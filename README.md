<p align="center">
  <strong>@littlebearapps/cf-monitor</strong><br>
  Self-contained Cloudflare account monitoring.<br>
  One worker. Zero migrations. Born from a $4,868 bill.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@littlebearapps/cf-monitor"><img src="https://img.shields.io/npm/v/@littlebearapps/cf-monitor" alt="npm" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/@littlebearapps/cf-monitor" alt="licence" /></a>
  <a href="https://github.com/littlebearapps/cf-monitor/actions"><img src="https://img.shields.io/github/actions/workflow/status/littlebearapps/cf-monitor/ci.yml?label=tests" alt="CI" /></a>
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> · <a href="#-features">Features</a> · <a href="#-sdk-api">SDK API</a> · <a href="#-cli-commands">CLI</a> · <a href="#-documentation">Docs</a> · <a href="#-contributing">Contributing</a>
</p>

---

Cloudflare Workers are great until a bug writes 4.8 billion D1 rows while you're asleep. cf-monitor wraps your workers with a single `monitor()` call, tracks every D1/KV/R2/AI/Queue operation, and shuts things down before they become expensive. One npm package, one worker per account, three CLI commands to production.

---

## 🛡️ Why cf-monitor?

Traditional monitoring SDKs need a central account, cross-account forwarding, HMAC secrets, and a fleet of workers to process telemetry. cf-monitor is different.

- **Your account monitors itself** — install on any Cloudflare account and it discovers all workers, tracks every binding call, and creates GitHub issues for errors. No central infrastructure, no cross-account secrets.
- **Three commands from zero to monitored** — `init`, `deploy`, `wire`. Budget defaults auto-calculated from your plan. You can be monitoring in production before your coffee gets cold.
- **Circuit breakers that actually trip** — per-invocation limits catch infinite loops on the first request. Daily budgets warn at 70%, stop at 100%. Monthly budgets align to your billing cycle. The runaway D1 loop from January 2026 ($3,434) would have been stopped at row 1,001.
- **Zero D1, zero queues, zero migrations** — metrics go to Analytics Engine (100M writes/month free). State lives in KV. No database schema to maintain, no queue infrastructure to provision.
- **Fail-open by default** — if cf-monitor has an internal error, your worker keeps running normally. Monitoring should never be the thing that breaks production.
- **Built for solo developers** — one worker per account, auto-discovery, auto-budgets, Slack alerts with dedup. Designed for people who ship fast and sleep well.

## ⚡ Quick Start

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

## 🎯 Features

- 🐛 **Error collection** — tail worker captures errors from every worker, deduplicates via fingerprint, creates GitHub issues with P0–P4 priority labels
- 💰 **Feature budgets** — per-feature daily and monthly limits with automatic circuit breakers. Warned at 70%, stopped at 100%
- 🔴 **Circuit breakers** — three-tier kill switches (feature, account, global) via KV. Auto-reset after configurable TTL
- 🛡️ **Cost protection** — per-invocation limits prevent runaway loops. Catches the $5K bug on the first request
- 📡 **Gap detection** — identifies workers that aren't sending telemetry. Shows where coverage is missing
- 🔍 **Worker discovery** — auto-discovers all workers via CF API. No manual registry needed
- 🔔 **Slack alerts** — budget warnings, errors, gaps, cost spikes. KV-based dedup so you don't get spammed
- 📈 **Cost spike detection** — flags when hourly costs exceed 200% of the 24-hour baseline
- ❤️ **Synthetic health checks** — hourly CB pipeline validation: trip, verify, reset, verify
- 📊 **Plan detection** — auto-detects Free vs Paid plan. Selects correct budget defaults automatically
- 📅 **Billing period tracking** — aligns monthly budgets to your actual billing cycle, not calendar months
- 📋 **Account usage dashboard** — queries CF GraphQL for Workers, D1, KV, R2, and Durable Objects. Shows % of plan used
- 🔧 **Self-monitoring** — tracks its own cron execution, error rates, and staleness. Alerts if cf-monitor itself is unhealthy

### Optional (AI-powered, disabled by default)

- 🤖 **Pattern discovery** — AI detection of transient error patterns (opt-in)
- 📝 **Health reports** — natural language account health summaries (opt-in)
- 🔬 **Coverage auditor** — AI scoring of integration quality (opt-in)

## 🔧 SDK API

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

## 🏗️ Architecture

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

## 💻 CLI Commands

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

## 🌐 API Endpoints

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
| GET | `/self-health` | Self-monitoring status: stale crons, error counts, handler breakdown |
| POST | `/webhooks/github` | GitHub webhook receiver (issue close/reopen/mute sync) |
| POST | `/admin/cron/{name}` | Manually trigger any cron (requires `ADMIN_TOKEN`) |
| POST | `/admin/cb/trip` | Trip a feature circuit breaker (requires `ADMIN_TOKEN`) |
| POST | `/admin/cb/reset` | Reset a feature circuit breaker (requires `ADMIN_TOKEN`) |
| POST | `/admin/cb/account` | Set account-level CB status (requires `ADMIN_TOKEN`) |

## ⚙️ Configuration

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

## 📦 Requirements

- **Node.js 20+** (22 recommended)
- **npm 10+**
- **A Cloudflare account** (Free or Paid — plan auto-detected)
- **At least one deployed Worker** on the account
- **Wrangler CLI** installed (`npm install -g wrangler`)
- **A Cloudflare API token** with:
  - Workers KV Storage: Edit
  - Account Analytics: Read
  - Workers Scripts: Edit
  - *Optional*: Account Settings: Read (for automatic plan detection)
- **`ADMIN_TOKEN` secret** (recommended for production — protects admin endpoints). See [Security](./docs/security.md)

## 🔄 Upgrading

```bash
npm update @littlebearapps/cf-monitor
npx cf-monitor upgrade              # re-deploys the monitor worker
```

Or preview first:

```bash
npx cf-monitor upgrade --dry-run
```

See the [changelog](./CHANGELOG.md) for version history.

## 🔀 Migrating from platform-consumer-sdk

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

Binding changes: `PLATFORM_CACHE` → `CF_MONITOR_KV`, `PLATFORM_ANALYTICS` → `CF_MONITOR_AE`, remove `PLATFORM_TELEMETRY` (Queue).

Or use the CLI: `npx cf-monitor migrate --from platform-consumer-sdk`

See the [full migration guide](./docs/how-to/migrate-from-platform-sdk.md) for detailed steps.

## 📚 Documentation

### Getting started

- [Step-by-step setup](./docs/getting-started.md) — from install to verified monitoring
- [Configuration reference](./docs/configuration.md) — all YAML and SDK options

### Guides

- [Error collection](./docs/guides/error-collection.md) — fingerprinting, dedup, GitHub issues
- [Budgets & circuit breakers](./docs/guides/budgets-and-circuit-breakers.md) — 4 layers of cost protection
- [Cost protection](./docs/guides/cost-protection.md) — the $4,868 story and how cf-monitor prevents it
- [Worker discovery](./docs/guides/worker-discovery.md) — auto-discovery, exclude patterns
- [Slack alerts](./docs/guides/slack-alerts.md) — alert types, dedup, webhook setup
- [Plan detection](./docs/guides/plan-detection.md) — Free vs Paid, billing period, permissions
- [Account usage](./docs/guides/account-usage.md) — GraphQL queries, services, limitations
- [Gap detection](./docs/guides/gap-detection.md) — coverage monitoring

### How-to

- [GitHub webhooks](./docs/how-to/github-webhooks.md) — bidirectional issue sync setup
- [Custom feature IDs](./docs/how-to/custom-feature-ids.md) — featureId, featurePrefix, features map
- [Migrate from platform-sdk](./docs/how-to/migrate-from-platform-sdk.md) — expanded migration guide

### Security & Reference

- [Security](./docs/security.md) — admin auth, secrets, threat model, data exposure
- [Troubleshooting](./docs/troubleshooting.md) — common issues with solutions
- [Changelog](./CHANGELOG.md) — version history

## 🤝 Contributing

Contributions welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.

```bash
git clone https://github.com/littlebearapps/cf-monitor.git
cd cf-monitor
npm install
npm test                    # 286 unit tests
npm run test:integration    # 53 integration tests (needs CF credentials)
npm run typecheck           # TypeScript strict mode
```

## 🙏 Acknowledgements

cf-monitor is a spiritual successor to [@littlebearapps/platform-consumer-sdk](https://github.com/littlebearapps/platform-sdks), which provided centralised monitoring across multiple Cloudflare accounts. The SDK's circuit breaker patterns, AE telemetry layout, and error fingerprinting algorithm were carried forward into cf-monitor's simpler per-account architecture.

The project was born from a [$4,868 billing incident](./docs/guides/cost-protection.md) in January 2026, which proved that monitoring systems must be self-contained per account — not centralised.

## 📄 Licence

MIT — Made by [Little Bear Apps](https://littlebearapps.com)
