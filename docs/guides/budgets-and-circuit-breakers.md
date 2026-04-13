# Budgets and Circuit Breakers

cf-monitor prevents runaway costs with three layers of protection: per-invocation limits, daily/monthly budgets, and circuit breakers.

## Per-invocation limits (Layer 1)

The first line of defence. These limits are enforced **synchronously** — the moment a binding operation exceeds the limit, a `RequestBudgetExceededError` is thrown. No waiting for a cron, no eventual consistency. The runaway loop stops on the first request.

### Default limits

| Metric | Default limit | What it protects |
|--------|--------------|-----------------|
| `d1Writes` | 1,000 | Prevents infinite INSERT loops |
| `d1Reads` | 5,000 | Prevents unbounded SELECT scans |
| `kvWrites` | 200 | KV writes cost 10x reads ($5/M) |
| `kvReads` | 1,000 | Prevents KV read floods |
| `aiRequests` | 50 | AI calls are expensive |
| `r2ClassA` | 100 | R2 mutations (put, delete) |
| `queueMessages` | 500 | Prevents message storms |

### Custom limits

```typescript
import { monitor } from '@littlebearapps/cf-monitor';

export default monitor({
  limits: {
    d1Writes: 500,      // Tighter than default
    aiRequests: 10,     // Very conservative for AI
  },
  fetch: handler,
});
```

### Handling the error

When a limit is exceeded, `RequestBudgetExceededError` is thrown. By default, `monitor()` catches it and returns a 500 response. You can customise this with `onError`:

```typescript
monitor({
  limits: { d1Writes: 500 },
  onError: (error, handler) => {
    if (error instanceof RequestBudgetExceededError) {
      return new Response('Operation too large', { status: 429 });
    }
  },
  fetch: handler,
});
```

## Daily budgets (Layer 2)

The hourly cron (`0 * * * *`) checks accumulated daily usage against configured budget limits.

### How it works

1. Each `monitor()` invocation accumulates metrics in KV (`budget:usage:daily:{feature}:{date}`)
2. The hourly `budget-check` cron reads these counters and compares against limits
3. Alerts fire at configurable thresholds:

| Threshold | Action |
|-----------|--------|
| **70%** | Slack warning (deduplicated for 1 hour) |
| **90%** | Slack critical warning (deduplicated for 1 hour) |
| **100%** | **Circuit breaker trips** — feature returns 503 until TTL expires |

### Configuration

Set budgets in `cf-monitor.yaml`:

```yaml
budgets:
  daily:
    d1_writes: 50000
    kv_writes: 10000
```

Or push from config to KV:

```bash
npx cf-monitor config sync
```

### Auto-seeding (plan-aware)

If not configured, cf-monitor auto-seeds defaults based on your detected CF plan:

- **Workers Paid**: ~80% of monthly included / 30 days (e.g. `d1_writes: 1,333,333/day`)
- **Workers Free**: Much lower limits (e.g. `d1_writes: 10,000/day`)

Plan detection uses the CF Subscriptions API. If your token lacks `Account Settings: Read` permission, it defaults to Paid plan limits (safe, conservative).

The auto-seeding runs during the first hourly budget check when no `budget:config:*` keys exist in KV. It discovers active features from usage data, writes per-feature configs with 25-hour TTL, and creates an `__account__` fallback that applies to any feature without its own config. A seed flag (24-hour TTL) prevents re-seeding every hour.

> ⚠️ **Auto-seeded configs expire.** The per-feature `budget:config:*` entries written by auto-seeding have a **25-hour TTL**. If you never run `npx cf-monitor config sync`, the keys expire ~daily and are re-seeded on the next hourly cron (the seed flag lets them re-seed). This is safe — limits don't change between seedings as long as your CF plan is stable — but it means nothing in KV is durable until you commit your own budgets. For production, run `config sync` once after deploy with a `budgets:` block in `cf-monitor.yaml` so limits are explicit and permanent.

If you run `npx cf-monitor config sync` with your own budgets, they take permanent precedence over auto-seeded defaults.

## Monthly budgets (Layer 2b)

Monthly budgets work identically to daily but use a `budget:usage:monthly:{feature}:{key}` counter and `budget:config:monthly:{feature}` KV keys. Monthly alerts are deduplicated for 24 hours.

### Billing period alignment

Monthly budgets track usage against your actual CF billing period (e.g. 2nd to 2nd), not calendar months. This prevents the ~2 day misalignment at period boundaries that could cause under- or over-counting.

The billing period is automatically detected from the CF Subscriptions API and cached in KV for 32 days. Monthly KV keys use the billing period start date (`YYYY-MM-DD` format, e.g. `2026-03-02`) instead of calendar month (`YYYY-MM`).

If billing period detection is unavailable (token lacks permissions), monthly budgets fall back to calendar month boundaries (previous behaviour). During the transition from v0.2.x, both key formats are checked and summed — no data is lost.

## Circuit breakers (Layer 3)

Circuit breakers are the "big red button". When a budget is exceeded, the feature's CB is tripped and all subsequent requests return 503 until the TTL expires.

### Three levels

| Level | KV Key | Scope | Use case |
|-------|--------|-------|----------|
| **Feature** | `cb:v1:feature:{featureId}` | Single feature/route | Budget exceeded for one endpoint |
| **Account** | `cb:v1:account` | Entire account | Account-wide emergency |
| **Global** | `cb:v1:global` | Everything | Last resort kill switch |

**Check order**: global > account > feature. If global is tripped, nothing runs.

### CB states

| Value | Meaning |
|-------|---------|
| `STOP` | Feature is blocked — requests return 503 |
| `GO` | Feature is explicitly allowed (reset with short TTL) |
| Not set | Feature is allowed (normal state) |

### Auto-reset

Circuit breakers reset automatically when their KV TTL expires (default: 1 hour). This prevents a temporary spike from permanently disabling a feature.

### Fast propagation

When a CB is reset, cf-monitor writes `'GO'` with a 60-second TTL instead of deleting the key. This forces KV cache invalidation across Cloudflare's edge network, which is faster than waiting for a delete to propagate (up to 60 seconds of eventual consistency).

> 💡 **Don't reset with `kv:key delete`.** If you manually "reset" a CB by deleting its KV key (e.g. `wrangler kv key delete "cb:v1:feature:my-feature"`), edges that have cached the `STOP` value will continue to serve 503s for up to ~60 seconds. Always prefer `POST /admin/cb/reset` (which writes `GO` + 60s TTL) or let the TTL expire naturally.

### Custom CB response

```typescript
monitor({
  onCircuitBreaker: (err) => {
    // err.featureId — which feature was blocked
    // err.level — 'feature', 'account', or 'global'
    // err.reason — why it was tripped
    return new Response('Service temporarily unavailable', { status: 503 });
  },
  fetch: handler,
});
```

## Cost spike detection (Layer 4)

The 15-minute cron (`*/15 * * * *`) compares current hourly costs against a 24-hour baseline. If any metric exceeds 200% of the baseline, a Slack alert is sent.

This catches anomalies that fall within budget limits but are still unusual — like a worker suddenly doing 10x more D1 reads than normal.

> 🚧 **The threshold is not yet configurable in v0.3.7.** `cf-monitor.yaml` accepts `monitoring.spike_threshold`, but `src/worker/crons/cost-spike.ts` hardcodes it to `2.0`. See [Cost spike detection](./cost-spike-detection.md) for full details, tuning workarounds, and alert shape.

## Synthetic health checks (Validation layer)

Every hour, cf-monitor runs a synthetic health check that validates the entire CB pipeline:

1. **Trip** a test circuit breaker (`cf-monitor:test:synthetic-cb`)
2. **Verify** it blocks (reads `STOP`)
3. **Reset** the circuit breaker
4. **Verify** it passes (reads `GO` or null)

If any step fails, it means the CB pipeline is broken and you'd find out before a real budget event. See [Synthetic health checks](./synthetic-health.md) for details on how to read the results and diagnose failures.

## Admin endpoints

For testing and emergency control:

| Endpoint | Purpose |
|----------|---------|
| `POST /admin/cb/trip` | Trip a feature CB: `{ "featureId": "...", "ttlSeconds": 300 }` |
| `POST /admin/cb/reset` | Reset a feature CB: `{ "featureId": "..." }` |
| `POST /admin/cb/account` | Set account CB: `{ "status": "paused" }` or `{ "status": "clear" }` |
| `POST /admin/cron/budget-check` | Manually trigger budget enforcement |
| `POST /admin/cron/cost-spike` | Manually trigger cost spike detection |
| `POST /admin/cron/synthetic-health` | Manually trigger CB health check |
