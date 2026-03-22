# cf-monitor

**Self-contained Cloudflare account monitoring. One worker. Zero migrations.**

Error collection, feature budgets, circuit breakers, cost protection — with zero D1 dependencies and a single `monitor()` export.

[![npm](https://img.shields.io/npm/v/@littlebearapps/cf-monitor)](https://www.npmjs.com/package/@littlebearapps/cf-monitor)
[![licence](https://img.shields.io/npm/l/@littlebearapps/cf-monitor)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/littlebearapps/cf-monitor/ci.yml?label=tests)](https://github.com/littlebearapps/cf-monitor/actions)

[Quick Start](#quick-start) · [Features](#features) · [SDK API](#sdk-api) · [CLI](#cli-commands) · [Docs](./docs/) · [Contributing](./CONTRIBUTING.md)

---

## Why cf-monitor?

Traditional monitoring SDKs need a central account, cross-account forwarding, HMAC secrets, and a fleet of workers to process telemetry. cf-monitor is different.

- **One worker per account** — install on any Cloudflare account and it monitors everything on that account. No central infrastructure, no cross-account complexity.
- **Zero D1, zero queues** — all metrics go to Analytics Engine (100M writes/month free). State lives in a single KV namespace. No database migrations, ever.
- **Three commands to production** — `init`, `deploy`, `wire`. Your workers are monitored in minutes, not hours.
- **Fail-open by default** — if cf-monitor has an internal error, your worker keeps running normally. Monitoring never becomes the problem.
- **Born from a $4,868 bill** — an infinite D1 write loop produced 4.8 billion rows before anyone noticed. cf-monitor's per-invocation limits and circuit breakers exist so that never happens again.

## Quick Start

### 1. Install

```bash
npm install @littlebearapps/cf-monitor
```

### 2. Set up the monitor worker

```bash
# Provision KV + AE, generate config files
npx cf-monitor init --account-id YOUR_ACCOUNT_ID

# Deploy the single monitor worker
npx cf-monitor deploy

# Auto-wire tail_consumers + bindings to all your worker configs
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

## Features

### Core

| Feature | What it does for you |
|---------|---------------------|
| **Error Collection** | Tail worker captures errors from all workers on the account, deduplicates via fingerprinting, and creates GitHub issues with priority labels (P0-P4). You find out about errors in seconds, not days. |
| **Feature Budgets** | Per-feature daily and monthly resource limits with automatic circuit breakers. Set a budget, get warned at 70% and 90%, and the feature stops at 100% before it costs you money. |
| **Circuit Breakers** | Three-tier kill switches — feature-level, account-level, and global emergency stop — all via KV. Reset automatically after a configurable TTL. |
| **Cost Protection** | Per-invocation resource limits prevent runaway loops. Catches the bug that would become a $5K billing incident and stops it on the first request. |
| **Gap Detection** | Identifies workers on the account that aren't sending telemetry. Shows you where monitoring coverage is missing so nothing falls through the cracks. |
| **Worker Discovery** | Auto-discovers all workers on the account via the Cloudflare API. No manual registry — add a new worker and cf-monitor finds it. |
| **Slack Alerts** | Budget warnings, error notifications, gap alerts, and cost spike alerts — all with KV-based deduplication so you don't get spammed. |
| **Cost Spike Detection** | Flags when hourly costs exceed 200% of the 24-hour baseline. Catches anomalies before they become expensive. |
| **Synthetic Health Checks** | Hourly CB pipeline validation: trip a test breaker, verify it blocks, reset it, verify it passes. Proves your safety net works. |
| **Plan Detection** | Auto-detects Workers Free vs Paid plan via CF Subscriptions API. Selects correct budget defaults automatically — no config needed. |
| **Billing Period Tracking** | Aligns monthly budgets to your actual CF billing cycle (e.g. 2nd to 2nd), not calendar months. Prevents misalignment at period boundaries. |
| **Account Usage Dashboard** | Queries CF GraphQL API hourly for 9 services (D1, KV, R2, Workers, AI, AI Gateway, DO, Vectorize, Queues). Shows % of plan used via `GET /usage` and `npx cf-monitor usage`. |

### Optional (AI-powered, disabled by default)

| Feature | What it does for you |
|---------|---------------------|
| **Pattern Discovery** | AI-assisted detection of new transient error patterns from unclassified errors |
| **Health Reports** | Natural language account health summaries posted to Slack |
| **Coverage Auditor** | AI scoring of how well cf-monitor is integrated across each worker |

## SDK API

### Zero-config (most workers)

```typescript
import { monitor } from '@littlebearapps/cf-monitor';

export default monitor({
  fetch: handler,
  scheduled: cronHandler,
  queue: queueHandler,
});
```

### Custom feature IDs

```typescript
export default monitor({
  features: {
    'POST /api/scan': 'scanner:social',       // Custom route feature
    'GET /health': false,                      // Exclude from tracking
    '0 2 * * *': 'cron:arxiv-harvest',        // Custom cron feature
  },
  fetch: handler,
  scheduled: cronHandler,
});
```

### Per-invocation limits

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

| Setting | How it works | Manual override |
|---------|-------------|-----------------|
| Worker name | `config.workerName` > `env.WORKER_NAME` > `env.name` > `'worker'` | `workerName` option or `wire --apply` |
| Feature IDs | `{worker}:{handler}:{method}:{path-slug}` | `featureId`, `featurePrefix`, or `features` map |
| Bindings | Duck-typing at runtime (D1, KV, R2, AI, Queue, DO, Vectorize, Workflow) | — |
| Budget defaults | Auto-detected from CF plan (free/paid) via Subscriptions API | `budgets` in config or `config sync` CLI |
| Health endpoint | `/_monitor/health` | `healthEndpoint` option or `false` to disable |

## Architecture

```
                    +-----------------------------------------+
                    |          cf-monitor worker               |
Your Workers -tail->|  tail()  -> fingerprint -> GitHub Issues |-> Issues
    |               |  cron()  -> metrics, budgets,            |-> Slack
    |               |             gaps, spikes, discovery      |
    |               |  fetch() -> /status, /errors,            |
    |               |             /budgets, /workers            |
    |               +-----------------------------------------+
    |                              |
    +---- AE write --> Analytics Engine <-- AE SQL query
```

### One worker handles everything

| Handler | Schedule | Purpose |
|---------|----------|---------|
| `tail()` | Real-time | Error capture from all tailed workers |
| `scheduled()` | `*/15 * * * *` | Gap detection, cost spike detection |
| `scheduled()` | `0 * * * *` | CF GraphQL metrics, account usage collection, budget enforcement, synthetic CB health |
| `scheduled()` | `0 0 * * *` | Daily rollup + warning digest, worker discovery |
| `fetch()` | On-demand | Status API, admin endpoints, GitHub webhooks |

### Storage — zero D1

| Store | Purpose | Cost |
|-------|---------|------|
| **Analytics Engine** | All metrics and telemetry (90-day retention, SQL queries) | 100M writes/month free |
| **KV** (1 namespace) | Circuit breaker state, budget config, error dedup, worker registry | Reads: $0.50/M, Writes: $5/M |

### Bindings tracked

D1 (reads, writes, rows) · KV (reads, writes, deletes, lists) · R2 (Class A, Class B) · Workers AI (requests, neurons) · Vectorize (queries, inserts) · Queue (messages) · Durable Objects (requests) · Workflows (invocations)

## CLI Commands

| Command | Purpose | Key flags |
|---------|---------|-----------|
| `npx cf-monitor init` | Provision KV + AE, generate config | `--account-id`, `--github-repo`, `--slack-webhook` |
| `npx cf-monitor deploy` | Deploy the cf-monitor worker | `--dry-run` |
| `npx cf-monitor wire` | Auto-add tail_consumers + bindings to all worker configs | `--apply`, `--dir` |
| `npx cf-monitor status` | Show monitor health and CB states | `--json` |
| `npx cf-monitor coverage` | Show which workers are/aren't monitored | `--json` |
| `npx cf-monitor secret` | Set a secret on the cf-monitor worker | `[name]` |
| `npx cf-monitor usage` | Show account-wide CF service usage vs plan allowances | `--json` |
| `npx cf-monitor config sync` | Push budgets from YAML to KV | — |
| `npx cf-monitor config validate` | Validate cf-monitor.yaml against schema | — |
| `npx cf-monitor upgrade` | Safe npm update + re-deploy | `--dry-run` |
| `npx cf-monitor migrate` | Migrate from platform-consumer-sdk | `--from` |

## API Endpoints

The monitor worker exposes these endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/_health` | Health check (for Gatus or uptime monitors) |
| GET | `/status` | Account health, CB states, worker count |
| GET | `/errors` | Recent error fingerprints with GitHub issue links |
| GET | `/budgets` | Active circuit breakers and budget utilisation |
| GET | `/workers` | Auto-discovered workers on the account |
| GET | `/plan` | Detected plan type, billing period, days remaining, allowances |
| GET | `/usage` | Account-wide per-service usage with plan context (approximate) |
| POST | `/webhooks/github` | GitHub webhook receiver (issue close/reopen/mute sync) |
| POST | `/admin/cron/{name}` | Manually trigger any cron (for testing) |
| POST | `/admin/cb/trip` | Trip a feature circuit breaker |
| POST | `/admin/cb/reset` | Reset a feature circuit breaker |
| POST | `/admin/cb/account` | Set account-level CB status |

## Configuration

Generated by `npx cf-monitor init` — see [full reference](./docs/configuration.md).

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

# Optional — sensible defaults auto-calculated from your CF plan
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
// Before (platform-consumer-sdk)
import { platformWorker } from '@littlebearapps/platform-consumer-sdk/worker';
export default platformWorker({
  project: 'scout',
  workerName: 'scout-harvester',
  cronFeature: (cron) => ({ '0 2 * * *': 'scout:cron:arxiv-harvest' })[cron],
  requestLimits: { d1Writes: 500 },
  fetch: handler,
  scheduled: cronHandler,
});

// After (cf-monitor)
import { monitor } from '@littlebearapps/cf-monitor';
export default monitor({
  limits: { d1Writes: 500 },
  fetch: handler,
  scheduled: cronHandler,
});
```

Wrangler binding changes:
- `PLATFORM_CACHE` (KV) -> `CF_MONITOR_KV`
- `PLATFORM_ANALYTICS` (AE) -> `CF_MONITOR_AE`
- Remove `PLATFORM_TELEMETRY` (Queue) — no longer needed

Or use the CLI: `npx cf-monitor migrate --from platform-consumer-sdk`

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](./docs/getting-started.md) | Step-by-step from install to verified monitoring |
| [Configuration Reference](./docs/configuration.md) | Complete cf-monitor.yaml and SDK options reference |
| [Error Collection](./docs/guides/error-collection.md) | How fingerprinting, dedup, and GitHub issues work |
| [Budgets & Circuit Breakers](./docs/guides/budgets-and-circuit-breakers.md) | Per-invocation limits, daily/monthly budgets, CB mechanics |
| [Cost Protection](./docs/guides/cost-protection.md) | The $4,868 story and how cf-monitor prevents it |
| [Troubleshooting](./docs/troubleshooting.md) | Common issues and their solutions |

## Contributing

Contributions welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.

```bash
git clone https://github.com/littlebearapps/cf-monitor.git
cd cf-monitor
npm install
npm test          # 254 unit tests
npm run typecheck # TypeScript strict mode
```

## Licence

MIT — Made by [Little Bear Apps](https://littlebearapps.com)
