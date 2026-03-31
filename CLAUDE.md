# CLAUDE.md - cf-monitor

**Last Updated**: 2026-03-31

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
| **Status** | v0.3.6 — production-tested, published to npm |
| **Repository** | https://github.com/littlebearapps/cf-monitor |
| **Licence** | MIT |
| **Issues** | https://github.com/littlebearapps/cf-monitor/issues |

**Quick Commands**:
```bash
npm test                    # Run unit tests (316 tests, vitest)
npm run test:integration    # Run integration tests (53 tests across 10 files, needs CF credentials)
npm run typecheck           # TypeScript check (Workers + CLI)
npm run build:cli           # Build CLI for npm publish
npm pack --dry-run          # Verify package contents
npm run release -- <version> # Release new version (bumps 6 files, commits, tags, pushes)
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
│   │   ├── fetch-handler.ts  # API: /status, /errors, /budgets, /workers, /plan, /usage, /self-health + admin cron triggers + GitHub webhooks
│   │   ├── self-monitor.ts   # Self-monitoring: cron tracking, error counts, AE telemetry, staleness detection
│   │   ├── account/          # Account-level concerns (plan detection, billing period, allowances)
│   │   ├── crons/            # Cron handlers (metrics, usage collection, budgets, gaps, discovery)
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
├── scripts/
│   └── release.sh            # Automated release (version bump, commit, tag, push)
│
├── worker/                   # Pre-built entry for wrangler deploy
│   └── index.ts
│
├── vitest.integration.config.ts  # Integration test config (globalSetup, 120s timeout)
│
└── tests/                    # 290 unit tests + 53 integration tests
    ├── helpers/               # Mock KV, AE, env, request factories
    ├── sdk/                   # monitor, proxy, metrics, detection, circuit-breaker
    ├── worker/                # tail, fetch, scheduled, config, ae-client, crons, errors
    ├── cli/                   # wrangler-generator, cloudflare-api
    └── integration/           # 10 test files — deploys real workers to CF with test- prefix
        ├── setup.ts           # Global setup/teardown (deploy once)
        ├── helpers.ts         # CF API helpers, KV operations, AE SQL queries, webhook signing
        ├── test-consumer.ts   # 13-route consumer worker for testing
        └── 01-10*.test.ts     # Sequential: health, SDK, CB, telemetry, webhooks, budgets, crons, errors, dry-run, proxy-tracking
```

---

## Release Process

```bash
./scripts/release.sh 0.4.0    # or: npm run release -- 0.4.0
```

The script bumps version across 6 files (package.json, CHANGELOG.md, CLAUDE.md, bug_report.yml, llms.txt, docs/README.md), commits, tags, and pushes. GitHub Actions then: runs CI, publishes to npm, creates GitHub Release with CHANGELOG notes.

**Workflow**: `.github/workflows/release.yml` (tag-triggered)
**Branch cleanup**: Feature branches auto-delete on PR merge (repo setting).

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
| `scheduled()` | `0 * * * *` | CF GraphQL metrics, account usage collection, budget enforcement (daily+monthly), synthetic CB health |
| `scheduled()` | `0 0 * * *` | Daily rollup + warning digest, worker discovery |
| `fetch()` | On-demand | API: /status, /errors, /budgets, /workers, /plan, /usage, /self-health, /_health, /admin/cron/*, /webhooks/github |

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
| `config:plan` | Detected CF plan (free/paid), 24hr TTL |
| `config:billing_period` | Billing period JSON, 32d TTL |
| `usage:account:{date}` | Daily per-service usage snapshot, 32d TTL |
| `self:v1:cron:last_run` | Handler execution timestamps (single JSON blob), 48hr TTL |
| `self:v1:error:` | Per-handler daily error counts, 48hr TTL |
| `self:v1:errors:count:` | Total daily error count, 48hr TTL |

---

## Key Files

| Purpose | File |
|---------|------|
| Public API | `src/index.ts` — exports `monitor()` |
| Worker wrapper | `src/sdk/monitor.ts` — the main SDK entry point |
| Binding proxies | `src/sdk/proxy.ts` — D1, KV, R2, AI, Vectorize, Queue, DO, Workflow tracking |
| Types | `src/types.ts` — MonitorConfig, MetricsAccumulator, CircuitBreakerError, AccountPlan, BillingPeriod |
| Constants | `src/constants.ts` — AE field mapping, KV prefixes, pricing |
| Monitor worker | `src/worker/index.ts` — single worker entry point |
| Error capture | `src/worker/tail-handler.ts` — tail event processing |
| GitHub issues | `src/worker/errors/github.ts` — PAT-based issue creation |
| Budget enforcement | `src/worker/crons/budget-check.ts` — plan-aware hourly CB enforcement |
| Account detection | `src/worker/account/subscriptions.ts` — plan detection, billing period, KV-cached |
| Plan allowances | `src/worker/account/plan-allowances.ts` — free/paid allowance tables |
| Usage collection | `src/worker/crons/collect-account-usage.ts` — hourly GraphQL for 9 services |
| Self-monitoring | `src/worker/self-monitor.ts` — cron tracking, error counts, AE telemetry, /self-health, staleness |
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

**#26 — Integration test suite**: IMPLEMENTED. 53 tests across 10 files covering all features. Deploys real workers with `test-` prefix to Platform CF account. CI: runs on push to main + workflow_dispatch.

## v0.3.0 Features

**#53 — Plan detection**: Auto-detects Workers Free vs Paid via CF Subscriptions API (`GET /accounts/{id}/subscriptions`). Plan cached in KV (24hr TTL). Budget auto-seeding selects correct defaults per plan. Falls back to "paid" (conservative) if token lacks `#billing:read`. New `GET /plan` endpoint. CLI `status` shows plan type.

**#54 — Billing-period-aware budgets**: Monthly KV keys transition from `YYYY-MM` to `YYYY-MM-DD` (billing period start). Billing period cached in KV (32d TTL). `checkMonthlyBudgets()` checks both old and new key formats during transition (sums usage). SDK-side module-level cache (1hr TTL per isolate) avoids per-invocation KV reads. `GET /budgets` includes `billingPeriod`. Falls back to calendar month if unavailable.

**#55 — Account-wide usage collection**: Hourly `collect-account-usage` cron queries CF GraphQL for 5 services (Workers, D1, KV, R2, Durable Objects). Daily snapshots stored in KV (`usage:account:{date}`, 32d TTL). New `GET /usage` endpoint with plan context + disclaimer. New `npx cf-monitor usage` CLI. Uses existing `CLOUDFLARE_API_TOKEN` — no new token needed. Data is approximate per CF documentation. AI Gateway, Vectorize, and Queues do not have GraphQL Analytics datasets — may be added via REST APIs later.

## Bug Fixes (v0.3.1)

**#57 — Wrong GraphQL dataset names**: FIXED. `d1AnalyticsAdaptive` corrected to `d1AnalyticsAdaptiveGroups`. Removed 4 non-existent datasets (AI Gateway, Vectorize, Queues producer/consumer) — these services don't have GraphQL Analytics datasets. Service count corrected from 9 to 5.

**#58 — D1 date filter format**: FIXED. D1's `d1AnalyticsAdaptiveGroups` requires `date_geq`/`date_leq` (YYYY-MM-DD), not `datetime_geq` (ISO 8601). Caused entire batched GraphQL query to fail with "unknown arg datetime_geq".

**#59 — Single query kills all results**: FIXED. Split core services into 5 parallel GraphQL queries (Workers, D1, KV, R2, DO). Each individually try-caught. If one service query fails, the others still return data. Costs 5 requests instead of 2 but well within CF's 25/5min rate limit.

## v0.3.2 Features

**#44 — Self-monitoring**: cf-monitor now tracks its own handler execution, errors, and cron staleness. New `self-monitor.ts` module provides fail-open recording functions. All 3 handlers (tail, scheduled, fetch) are instrumented. New `GET /self-health` endpoint returns handler status, error counts, and stale cron detection (200 when healthy, 503 when stale). Staleness alerts via Slack (1/day dedup). Self-telemetry written to AE (`blob2` format: `self:{durationMs}:{1|0}`, `doubles[0]=1`). New KV prefixes: `self:v1:cron:last_run` (handler timestamps as single JSON blob), `self:v1:error:{handler}:{date}` (error counts), `self:v1:errors:count:{date}` (daily total). `CRON_HANDLER_REGISTRY` constant for staleness thresholds. Admin cron trigger: `POST /admin/cron/staleness-check`. Phase 3 (self-capture via error pipeline) deferred to future version.

## v0.3.6 Runtime Config Resolution

- **Runtime config resolution**: `cf-monitor.yaml` is now the actual runtime config source. The CLI embeds it as `CF_MONITOR_CONFIG` JSON var in `wrangler.jsonc` during `init` and `deploy`. The worker calls `enrichEnv()` which resolves `$SECRET` references at runtime. (#87)
- **`enrichEnv()`**: Non-mutating helper in `config.ts`. Precedence: direct env > config > undefined. `$`-prefix safety check prevents unresolved refs from being used. Called in `index.ts` for all 3 handlers (tail, scheduled, fetch). Zero handler changes needed.
- **`--account-name` CLI option**: `npx cf-monitor init --account-name scout` sets the account name in both `cf-monitor.yaml` and `wrangler.jsonc`. (#86)
- **YAML parser**: `src/cli/yaml-parser.ts` — line-by-line parser for `cf-monitor.yaml`, zero npm dependencies. Used by `deploy.ts` to re-embed config.
- **Bug fix**: `GITHUB_REPO` not included in generated wrangler config — Scout and Brand Copilot silently skipped all GitHub issue creation. (#85)
- **Bug fix**: `ACCOUNT_NAME` defaulted to `'my-account'`, never passed from init options. (#86)
- **Bug fix**: `GITHUB_WEBHOOK_SECRET` added to `MonitorWorkerEnv` interface (was unsafe type cast).
- **Backward compatible**: Existing deployments without `CF_MONITOR_CONFIG` continue working — `enrichEnv()` is a no-op.

## v0.3.4 CORS + Binding Exclusion

- **CORS headers**: All GET endpoints include `Access-Control-Allow-Origin: *`. OPTIONS preflight returns 204. POST endpoints unchanged (server-to-server only). (#74)
- **`excludeBindings` option**: New `MonitorConfig.excludeBindings?: string[]` — env binding names to skip from proxy wrapping. Prevents false-positive metric tracking on custom env objects that match CF binding method signatures. (#75)
- Updated `docs/security.md` with "Binding detection" section documenting `excludeBindings` as mitigation.

## v0.3.3 Security Hardening

Full security audit with 9 fixes:

- **Admin endpoint auth**: All `/admin/*` POST routes require `Authorization: Bearer <ADMIN_TOKEN>` (timing-safe comparison). New `ADMIN_TOKEN` env var in `MonitorWorkerEnv`.
- **CLI command injection**: `execSync` → `execFileSync` in `secret.ts`, `deploy.ts`, `upgrade.ts`. Secret name validation: `/^[A-Z_][A-Z0-9_]*$/`.
- **Markdown escaping**: `escapeMd()` helper sanitises table cell values in GitHub issue bodies (`github.ts`, `fetch-handler.ts`).
- **Webhook replay protection**: `X-GitHub-Delivery` nonce stored in KV (24hr TTL). Duplicate deliveries silently dropped.
- **GraphQL input validation**: `CF_ACCOUNT_ID` validated against `/^[0-9a-f]{32}$/i` before interpolation in `collect-account-usage.ts` and `collect-metrics.ts`.
- **Symbol privacy**: `Symbol.for('cf-monitor:tracked')` → `Symbol('cf-monitor:tracked')` (module-private, undiscoverable by other code in isolate).
- **Info disclosure reduction**: `/status` no longer returns `accountId`, worker `names`, `billingPeriod`, or `github.repo`.
- **Error response hardening**: Admin endpoint errors return `'Internal error'` instead of `String(err)` (prevents stack trace leakage).
- **New `docs/security.md`**: Public-facing security guide covering admin auth, secrets, threat model, data exposure, SDK security, npm package security.

## Bug Fixes (v0.2.2)

**#46 — Gatus heartbeat unreachable**: FIXED. Scheduled handler's cron branches all returned before heartbeat code. Restructured to `if`/`else if` chain without early returns. Heartbeat now always fires with `success` status reflecting cron handler results.

**#51 — /budgets CB status 'unknown'**: FIXED. KV `list()` and `get()` can hit different edge caches. Now maps: `STOP`→`tripped`, `GO`→`resetting`, `null`→`tripped` (conservative default when key exists but value unreadable).

**#49 — Budget enforcement disabled**: FIXED. Budget config keys were never populated (config-sync CLI not run, no auto-seeding). Added: (1) auto-seed from `PAID_PLAN_DAILY_BUDGETS` when no configs exist, (2) `__account__` fallback when per-feature config missing, (3) fixed config-sync to write `__account__` instead of `__default__`.

---

## Open Work

See https://github.com/littlebearapps/cf-monitor/issues for planned features.

**Remaining features:**
- #8, #9, #10 — AI optional features (pattern discovery, health reports, coverage auditor) — stubs created in `src/worker/optional/`
