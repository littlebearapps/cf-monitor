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

If not configured, cf-monitor auto-seeds defaults from `PAID_PLAN_DAILY_BUDGETS` (80% of paid plan allowance / 30 days). The auto-seeding runs during the first hourly budget check when no `budget:config:*` keys exist in KV. It discovers active features from usage data, writes per-feature configs with 25-hour TTL, and creates an `__account__` fallback that applies to any feature without its own config. A seed flag (24-hour TTL) prevents re-seeding every hour.

## Monthly budgets (Layer 2b)

Monthly budgets work identically to daily but use a `budget:usage:monthly:{feature}:{month}` counter and `budget:config:monthly:{feature}` KV keys. Monthly alerts are deduplicated for 24 hours.

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

The 15-minute cron (`*/15 * * * *`) compares current hourly costs against a 24-hour baseline. If any metric exceeds the configured threshold (default: 200%), a Slack alert is sent.

This catches anomalies that fall within budget limits but are still unusual — like a worker suddenly doing 10x more D1 reads than normal.

Configure the threshold in `cf-monitor.yaml`:

```yaml
monitoring:
  spike_threshold: 2.0    # 200% of baseline (default)
```

## Synthetic health checks (Validation layer)

Every hour, cf-monitor runs a synthetic health check that validates the entire CB pipeline:

1. **Trip** a test circuit breaker (`platform:test:synthetic-cb`)
2. **Verify** it blocks (reads `STOP`)
3. **Reset** the circuit breaker
4. **Verify** it passes (reads `GO` or null)

If any step fails, it means the CB pipeline is broken and you'd find out before a real budget event.

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
