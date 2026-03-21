# cf-monitor handover prompt

Copy everything below the line into a new Claude Code session in `/platform/main`.

---

cf-monitor handover — new session context

cf-monitor (@littlebearapps/cf-monitor) is a public npm package (MIT, v0.1.0 published to npm). It replaces
@littlebearapps/platform-consumer-sdk's centralised multi-account monitoring architecture with a self-contained per-account
model: ONE worker per CF account, zero D1, zero queues.

Repo: https://github.com/littlebearapps/cf-monitor (public, MIT, littlebearapps org)
Location: /home/nathan/claude-code-tools/lba/infrastructure/platform/main/cf-monitor/
npm: @littlebearapps/cf-monitor@0.1.0 (published, live on npm)

## What exists (committed + pushed to GitHub)

- Core SDK: monitor() wrapper, binding proxies (D1, KV, R2, AI, Vectorize, Queue), circuit breakers, metrics, tracing,
  heartbeat, cost estimation, auto-detection (worker name, feature IDs, bindings)
- Monitor worker: single worker with tail() (error capture → fingerprint → GitHub issues), scheduled() (cron multiplexer:
  metrics collection, budget enforcement, gap detection, worker discovery, synthetic CB health, daily rollup), fetch() (API:
  /status, /errors, /budgets, /workers, /_health)
- CLI: init (provision KV+AE, generate config), deploy, wire (auto-add tail_consumers), status (stub), coverage (stub)
- Claude Code setup: CLAUDE.md, settings.json, .claude/rules/ (sdk-conventions, cost-safety, context-quality)
- Storage: Analytics Engine + KV only. No D1, no queues.

## What exists (UNCOMMITTED — needs commit before any new work)

These changes were implemented in the previous session and need to be committed:

### Source changes:
- `src/constants.ts` — added METRICS_TO_BUDGET mapping (MetricsAccumulator field → BudgetMetric key)
- `src/sdk/monitor.ts` — flushTelemetry() now calls accumulateBudgetUsage() to write daily KV budget counters (#25).
  Also fixed unused `handler` param → `_handler`
- `src/worker/tail-handler.ts` — fixed unused `ctx` → `_ctx`
- `src/worker/crons/synthetic-health.ts` — removed unused `KV` import
- `src/cli/commands/coverage.ts` — fixed unused `options` → `_options`
- `src/cli/commands/status.ts` — fixed unused `options` → `_options`
- `src/cli/wrangler-generator.ts` — fixed unused `isFree` → `_isFree`
- `package.json` — repo URL fixed to `git+https://`, bin path auto-corrected by npm

### New files:
- `vitest.config.ts` — Node env, globals, v8 coverage with 60% thresholds
- `.npmrc` — ignore-scripts=true (supply chain protection)
- `.github/workflows/ci.yml` — Full CI: typecheck, tests, coverage, build, publint, attw, lockfile-lint,
  dependency-review, package contents/size guards, licence check. Pinned action SHAs. Node 20+22 matrix.
- `.github/workflows/release.yml` — Trusted Publishing (OIDC, no NPM_TOKEN). publint, attw, lockfile-lint,
  coverage, CLI smoke test before publish.
- `tests/helpers/mock-kv.ts` — In-memory KV mock with TTL simulation
- `tests/helpers/mock-ae.ts` — Analytics Engine mock (writeDataPoint collector)
- `tests/helpers/mock-env.ts` — Factory for MonitorWorkerEnv + ConsumerEnv with duck-typing-compatible mock bindings
- `tests/helpers/mock-request.ts` — Request, ExecutionContext, ScheduledController, MessageBatch factories
- `tests/sdk/metrics.test.ts` (8 tests)
- `tests/sdk/detection.test.ts` (21 tests)
- `tests/sdk/circuit-breaker.test.ts` (11 tests)
- `tests/sdk/proxy.test.ts` (30 tests)
- `tests/sdk/monitor.test.ts` (20 tests) — includes budget accumulation tests
- `tests/worker/errors/fingerprint.test.ts` (8 tests)
- `tests/worker/errors/patterns.test.ts` (13 tests)
- `tests/worker/errors/github.test.ts` (7 tests)
- `tests/worker/tail-handler.test.ts` (9 tests)
- `tests/worker/fetch-handler.test.ts` (8 tests)
- `tests/worker/scheduled-handler.test.ts` (6 tests)
- `tests/worker/crons/budget-check.test.ts` (7 tests)

Total: 148 tests, all passing. Typecheck clean. Coverage ~74%.

## Remaining GitHub issues (21 open)

Check `gh issue list -R littlebearapps/cf-monitor` for full details. Grouped:

**SDK** (2): #19 (write last_seen to KV), #12 (DO + Workflow proxy tracking)

**Monitor Worker** (6): #14 (soft error/warning capture), #13 (monthly budgets), #15 (cost spike detection),
#11 (gap detection AE SQL), #22 (GitHub webhook sync), #21 (config YAML runtime parsing)

**CLI** (6): #4 (status), #5 (coverage), #6 (upgrade), #7 (config sync), #24 (secret set), #18 (migrate from platform-sdk)

**Testing** (2): #3 (CLI unit tests), #26 (integration test on test CF account)

**Other** (2): #17 (JSON schema for config), #16 (email alerts)

**AI Optional** (3): #8 (pattern discovery), #9 (health reports), #10 (coverage auditor)

## Key design decisions

- SDK writes directly to AE (no queue) — flushTelemetry() in src/sdk/monitor.ts
- Budget enforcement is dual-layer: per-invocation limits (inline) + hourly cron (aggregate, trips CB)
- Budget accumulation: SDK increments daily KV counters in flushTelemetry() for budget-check cron to read
- GitHub issues use PAT auth (1 secret) instead of GitHub App (3 secrets)
- Feature IDs auto-generated: {workerName}:{handler}:{discriminator}
- KV keys versioned: cb:v1:feature:, budget:usage:daily: etc.
- ESM-only, ships .ts source files (Cloudflare Workers consumers compile via wrangler)
- Trusted Publishing configured on npmjs.com (OIDC, no stored token)

## Source files forked/simplified from

- platform-sdks/packages/consumer-sdk/src/worker.ts → src/sdk/monitor.ts
- platform-sdks/packages/consumer-sdk/src/proxy.ts → src/sdk/proxy.ts
- platform/workers/error-collector.ts → src/worker/tail-handler.ts
- platform/workers/lib/error-collector/fingerprint.ts → src/worker/errors/fingerprint.ts
- platform/workers/lib/usage/queue/budget-enforcement.ts → src/worker/crons/budget-check.ts

## First thing to do

Commit and push the uncommitted work (see "UNCOMMITTED" section above). Then check `gh issue list -R
littlebearapps/cf-monitor` for the backlog.
