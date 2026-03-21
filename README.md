# cf-monitor

Self-contained Cloudflare account monitoring. One worker per account.

Error collection, feature budgets, circuit breakers, cost protection — with zero D1 dependencies.

> **Status:** Early development (v0.1.0). Core SDK and monitor worker are scaffolded. See [open issues](https://github.com/littlebearapps/cf-monitor/issues) for work in progress.

## Why

Traditional monitoring SDKs require a central account to collect and process telemetry. `cf-monitor` is different: install it on any Cloudflare account, and it monitors everything on **that account only**. No central infrastructure, no cross-account HMAC, no complex forwarding.

Born from real-world pain: a centralised monitoring architecture that broke when projects moved to dedicated Cloudflare accounts. cf-monitor fixes this by making each account fully self-contained.

## Features

| Feature | Description |
|---------|-------------|
| **Error Collection** | Tail worker captures errors from all workers, deduplicates via fingerprinting, creates GitHub issues with priority labels (P0-P4) |
| **Feature Budgets** | Per-feature daily/monthly resource limits with automatic circuit breakers at 100%, warnings at 70%/90% |
| **Circuit Breakers** | Three-tier kill switches: feature-level, account-level, and global emergency stop — all via KV |
| **Cost Protection** | Per-invocation resource limits prevent runaway loops. Catches the bug before it becomes a $5K billing incident |
| **Gap Detection** | Identifies workers on the account that aren't sending telemetry — shows where monitoring coverage is missing |
| **Worker Discovery** | Auto-discovers all workers on the account via CF API. No manual registry needed |
| **Slack Alerts** | Budget warnings, error notifications, gap alerts — all with KV-based deduplication |
| **Analytics Engine** | All metrics stored in AE: 90-day retention, SQL queries, 100M writes/month free tier |
| **Auto-Detection** | Worker name, feature IDs, bindings, and budget defaults are all detected automatically |

### Optional (AI-powered, disabled by default)

| Feature | Description |
|---------|-------------|
| Pattern Discovery | AI-assisted detection of new transient error patterns from unclassified errors |
| Health Reports | Natural language account health summaries posted to Slack |
| Coverage Auditor | AI scoring of how well cf-monitor is integrated across each worker |

## Quick Start

### 1. Install

```bash
npm install @littlebearapps/cf-monitor
```

### 2. Set up the monitor worker

```bash
# Provision KV namespace + AE dataset, generate config files
npx cf-monitor init --account-id YOUR_ACCOUNT_ID

# Deploy the single monitor worker (tail consumer + crons + API)
npx cf-monitor deploy

# Auto-wire tail_consumers + bindings to all other worker configs
npx cf-monitor wire --apply
```

### 3. Wrap your workers

```typescript
import { monitor } from '@littlebearapps/cf-monitor';

export default monitor({
  fetch: async (request, env, ctx) => {
    const data = await env.DB.prepare('SELECT * FROM items LIMIT 100').all();
    return Response.json(data);
  },
  scheduled: async (event, env, ctx) => {
    await env.KV.put('last-run', new Date().toISOString());
  },
});
```

That's it. Worker name, feature IDs, bindings, and budgets are all auto-detected.

### 4. Add bindings to your worker's wrangler config

```jsonc
{
  "kv_namespaces": [
    { "binding": "CF_MONITOR_KV", "id": "YOUR_KV_ID" }
  ],
  "analytics_engine_datasets": [
    { "binding": "CF_MONITOR_AE", "dataset": "cf-monitor" }
  ],
  "tail_consumers": [
    { "service": "cf-monitor" }
  ]
}
```

Or let the CLI handle it: `npx cf-monitor wire --apply` adds these to all your wrangler configs automatically.

## SDK API

### Zero-config (most users)

```typescript
import { monitor } from '@littlebearapps/cf-monitor';

export default monitor({
  fetch: handler,
  scheduled: cronHandler,
  queue: queueHandler,
});
```

### With custom feature IDs

```typescript
export default monitor({
  features: {
    'POST /api/scan': 'scanner:social',      // Custom route feature
    'GET /health': false,                     // Exclude from tracking
    '0 2 * * *': 'cron:arxiv-harvest',       // Custom cron feature
  },
  fetch: handler,
  scheduled: cronHandler,
});
```

### With per-invocation limits

```typescript
export default monitor({
  limits: {
    d1Writes: 500,       // Throws RequestBudgetExceededError if exceeded
    aiRequests: 10,
  },
  onCircuitBreaker: (err) => {
    return new Response('Temporarily unavailable', { status: 503 });
  },
  fetch: handler,
});
```

### What `monitor()` auto-detects

| Setting | How | Manual alternative |
|---------|-----|--------------------|
| Worker name | `env.WORKER_NAME` (CF runtime) | — |
| Feature IDs | `{worker}:{handler}:{path-slug}` | `features` map |
| Bindings | Duck-typing at runtime | — |
| Budget defaults | Based on CF plan (free/paid) | `budgets` in config |
| Tail consumers | CLI `wire` command | Manual wrangler edit |

## Architecture

```
                    ┌─────────────────────────────────┐
                    │      cf-monitor worker           │
Your Workers ─tail─>│  tail()  → fingerprint → GitHub │─> Issues
    │               │  cron()  → metrics, budgets,     │─> Slack
    │               │            gaps, discovery       │
    │               │  fetch() → /status, /errors,     │
    │               │            /budgets, /workers     │
    │               └─────────────────────────────────┘
    │                              │
    └──── AE write ──> Analytics Engine <── AE SQL query
```

**One worker handles everything:**

| Handler | Schedule | Purpose |
|---------|----------|---------|
| `tail()` | Real-time | Error capture from all tailed workers |
| `scheduled()` | `*/15 * * * *` | Gap detection |
| `scheduled()` | `0 * * * *` | CF GraphQL metrics, budget enforcement, synthetic CB health |
| `scheduled()` | `0 0 * * *` | Daily rollup, worker discovery |
| `fetch()` | On-demand | Status API endpoints |

## Storage

**Zero D1.** Everything uses Analytics Engine + KV.

| Store | Purpose | Cost |
|-------|---------|------|
| **Analytics Engine** | All metrics and telemetry (90-day retention) | 100M writes/month free |
| **KV** (1 namespace) | Circuit breaker state, budget config, error dedup, worker registry | Reads: $0.50/M, Writes: $5/M |

### KV Key Prefixes

| Prefix | Purpose | TTL |
|--------|---------|-----|
| `cb:v1:feature:` | Circuit breaker state per feature | Auto-reset (default 1hr) |
| `cb:v1:account` | Account-level CB | 24hr |
| `budget:config:` | Feature budget limits | None |
| `budget:usage:daily:` | Daily usage counters | 25hr |
| `err:fp:` | Error fingerprint → GitHub issue URL | 90 days |
| `err:rate:` | Per-script error rate limit | 2hr |
| `workers:` | Auto-discovered worker registry | 25hr |

## CLI Commands

| Command | Purpose |
|---------|---------|
| `npx cf-monitor init` | Provision KV + AE, generate config and wrangler.jsonc |
| `npx cf-monitor deploy` | Deploy the cf-monitor worker |
| `npx cf-monitor wire [--apply]` | Auto-add tail_consumers + bindings to all worker configs |
| `npx cf-monitor status` | Show monitor health, CB states, worker count |
| `npx cf-monitor coverage` | Show which workers are/aren't monitored |
| `npx cf-monitor upgrade` | Safe npm update + re-deploy with rollback |
| `npx cf-monitor config sync` | Push budgets from YAML to KV |

## Configuration

Generated by `npx cf-monitor init`:

```yaml
# cf-monitor.yaml
account:
  name: my-project
  cloudflare_account_id: "abc123..."

github:
  repo: "owner/repo"
  token: $GITHUB_TOKEN

alerts:
  slack_webhook: $SLACK_WEBHOOK_URL

# Optional — sensible defaults auto-calculated from CF plan
# budgets:
#   daily:
#     d1_writes: 50000
#     kv_writes: 10000
#   monthly:
#     d1_writes: 1000000

# ai:
#   enabled: false
#   pattern_discovery: false
#   health_reports: false
```

## Comparison with platform-consumer-sdk

| | platform-consumer-sdk | cf-monitor |
|---|---|---|
| **Scope** | Central account collects from all projects | Per-account, self-contained |
| **Workers** | 10+ platform workers + agents per account | 1 worker per account |
| **Storage** | D1 (61 migrations, 28 tables) + KV + Queue | AE + KV only (zero D1) |
| **Queues** | 2 per account (telemetry + DLQ) | 0 |
| **Config** | services.yaml + budgets.yaml + sync script | 1 cf-monitor.yaml |
| **Setup** | 7+ manual steps | 3 CLI commands |
| **SDK API** | 18 sub-path exports | 1 export: `monitor()` |
| **Cross-account** | HMAC secrets, platform-agents | Not needed |
| **Feature IDs** | Manual registration in YAML | Auto-generated |

## Migrating from platform-consumer-sdk

```typescript
// Before
import { platformWorker } from '@littlebearapps/platform-consumer-sdk/worker';
export default platformWorker({
  project: 'scout',
  workerName: 'scout-harvester',
  cronFeature: (cron) => ({ '0 2 * * *': 'scout:cron:arxiv-harvest' })[cron],
  requestLimits: { d1Writes: 500 },
  fetch: handler,
  scheduled: cronHandler,
});

// After
import { monitor } from '@littlebearapps/cf-monitor';
export default monitor({
  limits: { d1Writes: 500 },
  fetch: handler,
  scheduled: cronHandler,
});
```

Wrangler binding changes:
- `PLATFORM_CACHE` (KV) → `CF_MONITOR_KV`
- `PLATFORM_ANALYTICS` (AE) → `CF_MONITOR_AE`
- Remove `PLATFORM_TELEMETRY` (Queue) — no longer needed

## Contributing

Issues and PRs welcome. See [open issues](https://github.com/littlebearapps/cf-monitor/issues) for planned work.

```bash
git clone https://github.com/littlebearapps/cf-monitor.git
cd cf-monitor
npm install
npm test
npm run typecheck
```

## Licence

MIT
