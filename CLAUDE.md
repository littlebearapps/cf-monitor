# CLAUDE.md - cf-monitor

**Last Updated**: 2026-03-21

---

## What is cf-monitor?

`cf-monitor` (`@littlebearapps/cf-monitor`) is a self-contained, per-account Cloudflare monitoring SDK. Install it on any CF account and get full observability with ONE worker. No central account needed.

**It is a v2 refactor of `@littlebearapps/platform-consumer-sdk`** — born from real-world pain when Scout, Brand Copilot, Aus History MCP, and ViewPO moved to dedicated Cloudflare accounts. The centralised platform-sdk model (10+ workers, cross-account HMAC forwarding, platform-agents) broke. cf-monitor fixes this by making each account fully self-contained.

### Design Principles

1. **Per-account scope** — monitors only the CF account it's installed on. No central infrastructure.
2. **Single worker** — ONE `cf-monitor` worker per account handles tail (errors), scheduled (metrics/budgets/gaps), and fetch (API).
3. **Zero D1** — Analytics Engine for time-series metrics, KV for state/config. No database migrations.
4. **No queue** — SDK writes directly to AE (same-account, fire-and-forget). No queue infrastructure.
5. **One export** — `import { monitor } from '@littlebearapps/cf-monitor'`. Auto-detects everything.
6. **No AI by default** — AI features (pattern discovery, health reports) are opt-in.

### Comparison with platform-consumer-sdk

| | platform-consumer-sdk | cf-monitor |
|---|---|---|
| Workers | 10+ platform workers + agents | 1 worker per account |
| Storage | D1 (61 migrations) + KV + Queue | AE + KV only |
| Config | services.yaml + budgets.yaml + sync script | 1 cf-monitor.yaml |
| Setup | 7+ manual steps | 3 CLI commands |
| SDK API | 18 sub-path exports | 1 export: `monitor()` |

---

## Quick Facts

| | |
|---|---|
| **Language** | TypeScript |
| **Runtime** | Cloudflare Workers |
| **npm** | `@littlebearapps/cf-monitor` |
| **Status** | v0.2.0 — production-tested on Platform account |
| **Repository** | https://github.com/littlebearapps/cf-monitor |
| **Licence** | MIT |
| **Issues** | https://github.com/littlebearapps/cf-monitor/issues |

**Quick Commands**:
```bash
npm test                    # Run unit tests (222 tests, vitest)
npm run test:integration    # Run integration tests (36 tests, needs CF credentials)
npm run typecheck           # TypeScript check (Workers + CLI)
npm run build:cli           # Build CLI for npm publish
npm pack --dry-run          # Verify package contents
```

---

## Repository Structure

```
cf-monitor/
├── package.json              # @littlebearapps/cf-monitor
├── tsconfig.json             # Workers runtime types
├── tsconfig.cli.json         # Node16 types for CLI
├── cf-monitor.schema.json    # JSON Schema for config validation
│
├── src/
│   ├── index.ts              # Single public export: monitor()
│   ├── types.ts              # All public types
│   ├── constants.ts          # KV prefixes, AE field mapping, pricing
│   │
│   ├── sdk/                  # Runtime SDK (installed in consumer workers)
│   │   ├── monitor.ts        # monitor() wrapper — main entry point
│   │   ├── proxy.ts          # Binding proxies (D1, KV, R2, AI, Vectorize, Queue, DO, Workflow)
│   │   ├── metrics.ts        # MetricsAccumulator + AE data point conversion
│   │   ├── circuit-breaker.ts # CB check/trip/reset via KV
│   │   ├── detection.ts      # Auto-detect worker name, bindings, feature IDs
│   │   ├── tracing.ts        # W3C distributed tracing
│   │   ├── heartbeat.ts      # Gatus heartbeat ping
│   │   └── costs.ts          # CF pricing tiers
│   │
│   ├── worker/               # The single cf-monitor worker (deployed per account)
│   │   ├── index.ts          # Export: { fetch, scheduled, tail }
│   │   ├── tail-handler.ts   # Error capture → fingerprint → GitHub issue
│   │   ├── scheduled-handler.ts # Cron multiplexer
│   │   ├── fetch-handler.ts  # API: /status, /errors, /budgets, /workers + admin cron triggers + GitHub webhooks
│   │   ├── crons/            # Cron handlers (metrics, budgets, gaps, discovery)
│   │   ├── errors/           # Fingerprinting, patterns, GitHub issue CRUD
│   │   ├── alerts/           # Slack alerts with dedup
│   │   └── optional/         # AI features (opt-in, not yet implemented)
│   │
│   └── cli/                  # CLI: npx cf-monitor <command>
│       ├── index.ts          # Commander setup
│       ├── commands/          # init, deploy, wire, status, coverage, secret, config-sync, upgrade, migrate
│       ├── wrangler-generator.ts
│       └── cloudflare-api.ts
│
├── worker/                   # Pre-built entry for wrangler deploy
│   └── index.ts
│
├── vitest.integration.config.ts  # Integration test config (globalSetup, 120s timeout)
│
└── tests/                    # 222 unit tests + 36 integration tests
    ├── helpers/               # Mock KV, AE, env, request factories
    ├── sdk/                   # monitor, proxy, metrics, detection, circuit-breaker
    ├── worker/                # tail, fetch, scheduled, config, ae-client, crons, errors
    ├── cli/                   # wrangler-generator, cloudflare-api
    └── integration/           # 8 test files — deploys real workers to CF with test- prefix
        ├── setup.ts           # Global setup/teardown (deploy once)
        ├── helpers.ts         # CF API helpers, KV operations, webhook signing
        ├── test-consumer.ts   # 10-route consumer worker for testing
        └── 01-08*.test.ts     # Sequential: health, SDK, CB, telemetry, errors, budgets, crons, webhooks
```

---

## Architecture

```
Consumer Workers ──(tail)──> cf-monitor worker ──> GitHub Issues
    │                           │                     Slack Alerts
    │                           │
    └──(AE write)──> Analytics Engine <──(SQL)── cf-monitor crons
                                                  (budgets, gaps,
                                                   discovery, health)
```

### Single Worker Handlers

| Handler | Schedule | Purpose |
|---------|----------|---------|
| `tail()` | Real-time | Error capture from all tailed workers |
| `scheduled()` | `*/15 * * * *` | Gap detection, cost spike detection |
| `scheduled()` | `0 * * * *` | CF GraphQL metrics, budget enforcement (daily+monthly), synthetic CB health |
| `scheduled()` | `0 0 * * *` | Daily rollup + warning digest, worker discovery |
| `fetch()` | On-demand | API: /status, /errors, /budgets, /workers, /_health, /admin/cron/*, /webhooks/github |

### Storage Model

- **Analytics Engine** (`CF_MONITOR_AE`) — all metrics/telemetry. 90-day retention, SQL queries, 100M writes/month free.
- **KV** (`CF_MONITOR_KV`) — circuit breaker state, budget config, error dedup, worker registry.
- **No D1**, no Queue.

### KV Key Prefixes

| Prefix | Purpose |
|--------|---------|
| `cb:v1:feature:` | Circuit breaker per feature |
| `cb:v1:account` | Account-level CB |
| `budget:config:` | Feature budget limits |
| `budget:config:monthly:` | Monthly budget limits |
| `budget:usage:daily:` | Daily usage counters |
| `budget:usage:monthly:` | Monthly usage counters |
| `budget:warn:` | Alert dedup (budget + gap) |
| `err:fp:` | Error fingerprint → GitHub issue URL |
| `err:rate:` | Per-script error rate limit |
| `err:transient:` | Transient error dedup (1/day) |
| `warn:digest:` | P4 warning daily digest batch |
| `workers:` | Auto-discovered worker registry |
| `workers:{name}:last_seen` | SDK heartbeat timestamp |

---

## Key Files

| Purpose | File |
|---------|------|
| Public API | `src/index.ts` — exports `monitor()` |
| Worker wrapper | `src/sdk/monitor.ts` — the main SDK entry point |
| Binding proxies | `src/sdk/proxy.ts` — D1, KV, R2, AI, Vectorize, Queue, DO, Workflow tracking |
| Types | `src/types.ts` — MonitorConfig, MetricsAccumulator, CircuitBreakerError |
| Constants | `src/constants.ts` — AE field mapping, KV prefixes, pricing |
| Monitor worker | `src/worker/index.ts` — single worker entry point |
| Error capture | `src/worker/tail-handler.ts` — tail event processing |
| GitHub issues | `src/worker/errors/github.ts` — PAT-based issue creation |
| Budget enforcement | `src/worker/crons/budget-check.ts` — hourly CB enforcement |
| CLI entry | `src/cli/index.ts` — commander setup |

---

## Your Role

When working in cf-monitor, you are building a **public npm package**:

- **Simplicity first** — this replaces a complex centralised system. Every API should be simpler than what it replaces.
- **Zero-config defaults** — auto-detect everything possible (worker name, feature IDs, bindings, budgets).
- **Backward compatible AE schema** — doubles positions (0-19) match platform-consumer-sdk layout. Never reorder.
- **KV key versioning** — prefixes include version (e.g. `cb:v1:`) for safe schema migration.
- **Fail open** — SDK errors must never break the consumer worker. `failOpen: true` is the default.
- **No AI unless opted in** — AI features gated by `ai.enabled: true` in config.

---

## Related Projects

| Project | Relationship |
|---------|-------------|
| **Platform** | `~/claude-code-tools/lba/infrastructure/platform/main/` — **First production deployment** (2026-03-21). 18 workers migrated to `monitor()`, cf-monitor worker deployed, full pipeline validated. |
| **Platform SDKs** | `~/claude-code-tools/lba/infrastructure/platform-sdks/main/` — `@littlebearapps/platform-consumer-sdk` (v3.0.5) that cf-monitor replaces. Source of forked code. |
| **Scout** | `~/claude-code-tools/lba/scout/` — Next migration target. Migration issue: [scout#234](https://github.com/littlebearapps/scout/issues/234). |
| **Brand Copilot** | `~/claude-code-tools/lba/marketing/brand-copilot/main/` — Future migration target. |
| **Aus History MCP** | `~/claude-code-tools/lba/apps/mcp-servers/australian-history-mcp/` — Future target (currently dormant). |
| **ViewPO** | `~/claude-code-tools/lba/apps/devtools/viewpo/main/` — Future target (dedicated CF account). |

---

## Production Deployment (Platform Account)

Deployed 2026-03-21 on Platform CF account (`55a0bf6d...`):
- cf-monitor worker: `cf-monitor.littlebearapps.workers.dev`
- KV namespace: `fa04a5ab2abf44328638f92e1d13abbe`
- AE dataset: `cf-monitor`
- 18 consumer workers migrated from `platformWorker()` to `monitor()`
- Both `error-collector` and `cf-monitor` receive tail events (parallel testing)

---

## Bug Fixes (v0.2.1)

**#28 — WORKER_NAME detection**: FIXED. Added `workerName` config option (highest priority), `wire --apply` now auto-injects `WORKER_NAME` from wrangler `name` field. Detection chain: `config.workerName` → `env.WORKER_NAME` → `env.name` → `'worker'`.

**#29 — CB reset propagation delay**: FIXED. `resetFeatureCb()` now writes `'GO'` with 60s TTL instead of `kv.delete()`, forcing faster KV cache invalidation across edge replicas.

**#30 — Feature ID format**: FIXED. Added `featureId` (single ID for all routes) and `featurePrefix` (replaces worker name in auto-generated IDs). Precedence: `featureId` → `features` map → auto-generate with `featurePrefix ?? workerName`.

**#26 — Integration test suite**: IMPLEMENTED. 36 tests across 8 files covering all features. Deploys real workers with `test-` prefix to Platform CF account. CI: runs on push to main + workflow_dispatch.

---

## Open Work

See https://github.com/littlebearapps/cf-monitor/issues for planned features.

**Remaining features:**
- #8, #9, #10 — AI optional features (pattern discovery, health reports, coverage auditor) — stubs created in `src/worker/optional/`
