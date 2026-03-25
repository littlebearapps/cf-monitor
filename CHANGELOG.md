# Changelog

All notable changes to cf-monitor are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- Tail handler produces zero observable output — added structured logging at every decision point: batch summary, dedup hits, rate limits, transient dedup, creation locks, missing GitHub config, and issue creation success (#82)
- D1 GraphQL dataset name `d1AnalyticsAdaptive` does not exist — corrected to `d1AnalyticsAdaptiveGroups` with `date_geq`/`date_leq` filters in `collect-metrics.ts` (#80)
- KV GraphQL fields `readOperations`/`writeOperations`/`listOperations`/`deleteOperations` do not exist on `kvOperationsAdaptiveGroups` — updated both `collect-metrics.ts` and `collect-account-usage.ts` to use `dimensions { actionType }` + `sum { requests }`, matching the R2 operations pattern (#81)

### Changed
- Unit tests increased from 290 to 296

## [0.3.4] - 2026-03-22

### Added
- CORS headers on all GET endpoints — `Access-Control-Allow-Origin: *` enables browser-based monitoring dashboards (#74)
- OPTIONS preflight handler returns 204 with CORS headers
- `excludeBindings` option in `MonitorConfig` — skip proxy wrapping for specific env binding names that accidentally match CF binding method signatures (#75)

### Changed
- `createTrackedEnv()` accepts optional `excludeBindings` parameter, merged with internal skip set
- `detectBindings()` accepts optional `excludeKeys` parameter
- `docs/security.md` — updated duck-typing section with `excludeBindings` mitigation
- `docs/configuration.md` — added `excludeBindings` to SDK Options section
- Unit tests increased from 286 to 290

## [0.3.3] - 2026-03-22

### Security
- Admin endpoint authentication: all `/admin/*` POST routes require `Authorization: Bearer <ADMIN_TOKEN>` with timing-safe comparison (#62)
- CLI command injection: `execSync` replaced with `execFileSync` in `secret.ts`, `deploy.ts`, `upgrade.ts`; secret name validation added (#63)
- Markdown escaping: `escapeMd()` helper sanitises GitHub issue table cells, preventing injection via crafted error messages (#64)
- GraphQL input validation: `CF_ACCOUNT_ID` validated against `/^[0-9a-f]{32}$/i` before query interpolation (#65)
- Symbol privacy: `Symbol.for()` changed to `Symbol()` for module-private tracking metadata (#67)
- Info disclosure reduction: `/status` endpoint no longer returns `accountId`, worker `names`, `billingPeriod`, or `github.repo` (#68)
- Webhook replay protection: `X-GitHub-Delivery` nonce stored in KV (24hr TTL), duplicate deliveries silently dropped (#69)
- Error response hardening: admin endpoints return generic `'Internal error'` instead of `String(err)` (#70)
- KV TOCTOU race in budget accumulation documented as known limitation (#66)

### Added
- `docs/security.md` — comprehensive security guide: admin auth, secrets management, threat model, data exposure, SDK security, npm package security
- `ADMIN_TOKEN` environment variable for admin endpoint authentication
- New KV prefix: `webhook:nonce:` for webhook replay protection

### Changed
- CLI `secret` subcommand syntax fixed across all documentation (`secret` → `secret set`)
- All admin endpoint curl examples in docs now include `Authorization: Bearer` header
- `docs/getting-started.md` — added Step 8 (admin endpoint security), GitHub PAT scope guidance
- `docs/troubleshooting.md` — added "Admin endpoints returning 401" and "Self-monitoring shows stale crons" sections
- `docs/configuration.md` — expanded secrets section with all 6 secrets and minimum scopes
- `README.md` — added Security doc link, ADMIN_TOKEN requirement, admin auth notes on endpoint table

## [0.3.2] - 2026-03-22

### Added
- Self-monitoring module: tracks cron execution timestamps, per-handler error counts, and daily error totals (#44)
- `GET /self-health` endpoint — structured self-health status with handler breakdown, stale cron detection (200 healthy, 503 stale)
- Self-telemetry AE data points for cf-monitor's own handler invocations (`blob2` format: `self:{durationMs}:{1|0}`)
- Cron staleness Slack alerts when handlers haven't run within expected intervals (1/day dedup)
- `CRON_HANDLER_REGISTRY` constant defining expected schedule and max staleness per cron handler
- Admin cron trigger: `POST /admin/cron/staleness-check`
- New KV prefixes: `self:v1:cron:last_run`, `self:v1:error:{handler}:{date}`, `self:v1:errors:count:{date}`

## [0.3.1] - 2026-03-22

### Fixed
- Wrong GraphQL dataset names for usage collection — `d1AnalyticsAdaptive` corrected to `d1AnalyticsAdaptiveGroups`, removed 4 non-existent datasets (AI Gateway, Vectorize, Queues) (#57)
- D1 GraphQL dataset requires `date_geq`/`date_leq` filters (YYYY-MM-DD), not `datetime_geq` (ISO 8601) — caused entire query to fail (#58)
- Single GraphQL query failure killed all service results — split into 5 parallel per-service queries for isolation (#59)

### Changed
- Account usage collection now queries 5 CF services with GraphQL datasets (Workers, D1, KV, R2, Durable Objects). AI Gateway, Vectorize, and Queues do not have GraphQL Analytics datasets — may be added via REST APIs later.

## [0.3.0] - 2026-03-22

### Added
- **Plan detection** (#53): Auto-detects Workers Free vs Paid plan via CF Subscriptions API. Budget auto-seeding now selects correct defaults for each plan. CLI `status` and `GET /status` show detected plan.
- **Billing-period-aware budgets** (#54): Monthly budget tracking aligned to actual CF billing cycle (not calendar month). Gradual migration — old keys expire via TTL, both formats checked during transition.
- **Account-wide usage collection** (#55): Hourly GraphQL queries for 5 CF services (D1, KV, R2, Workers, Durable Objects). New `GET /usage` endpoint and `npx cf-monitor usage` CLI command.
- New `GET /plan` endpoint — returns detected plan type, billing period, days remaining, and plan allowances
- New `GET /usage` endpoint — returns per-service usage with plan context and data accuracy disclaimer
- New `npx cf-monitor usage` CLI command — formatted table with colour-coded % of plan used
- `GET /budgets` now includes `billingPeriod` object
- `GET /status` now includes `plan` field and `billingPeriod`
- New types exported: `AccountPlan`, `BillingPeriod`, `PlanAllowances`, `ServiceUsageSnapshot`
- `collect-account-usage` added to admin cron triggers (`POST /admin/cron/collect-account-usage`)

### Changed
- Budget auto-seeding uses dynamic plan detection instead of hardcoded `PAID_PLAN_DAILY_BUDGETS`
- Monthly budget KV keys transition from `YYYY-MM` to `YYYY-MM-DD` (billing period start date) — backward compatible, both formats checked during transition
- `PAID_PLAN_DAILY_BUDGETS` and `FREE_PLAN_DAILY_BUDGETS` moved to `src/worker/account/plan-allowances.ts` (re-exported from `constants.ts` for backward compat)
- CLI `status` now shows plan type, billing period, and days remaining
- CLI `getAccountPlan()` uses Subscriptions API instead of naive account settings check
- Unit tests increased from 231 to 254

## [0.2.2] - 2026-03-22

### Fixed
- Gatus heartbeat unreachable in scheduled handler — all cron branches returned before heartbeat code (#46)
- `/budgets` endpoint shows CB status `'unknown'` due to KV edge cache inconsistency — now maps `STOP`→`tripped`, `GO`→`resetting`, `null`→`tripped` (#51)
- Budget enforcement effectively disabled — zero `budget:config:*` keys populated after deploy. Added auto-seeding from `PAID_PLAN_DAILY_BUDGETS` when no configs exist, plus `__account__` fallback (#49)
- `config-sync` CLI wrote `budget:config:__default__` key that never matched per-feature usage keys — changed to `budget:config:__account__`

### Changed
- Scheduled handler now uses `if`/`else if` chain instead of `if`+`return`, tracks `success` from `Promise.allSettled` results, passes `success` status to Gatus heartbeat URL
- Budget check cron auto-seeds defaults (25hr TTL) from discovered usage keys when no config exists, with 24hr seed flag to prevent hourly re-seeding
- Unit tests increased from 222 to 231

## [0.2.1] - 2026-03-21

### Added
- Comprehensive public documentation suite: README rewrite with badges, benefit-first "Why" section, and corrected auto-detection docs
- CONTRIBUTING.md, CHANGELOG.md, SECURITY.md, CODE_OF_CONDUCT.md
- docs/getting-started.md, docs/configuration.md, docs/troubleshooting.md
- docs/guides/: error-collection, budgets-and-circuit-breakers, cost-protection
- GitHub issue templates (bug report, feature request) and PR template
- 4 previously untracked integration test files (01-health, 02-consumer-sdk, 03-circuit-breaker, 06-budget)

## [0.2.0] - 2026-03-21

### Added
- Integration test suite: 53 tests across 10 files deploying real workers to Cloudflare (#26)
- Admin cron trigger endpoints (`POST /admin/cron/{name}`) for testing all 7 cron handlers
- GitHub dry-run endpoint (`POST /admin/test/github-dry-run`) — validates issue formatting without API calls (#34)
- Slack dry-run endpoint (`POST /admin/test/slack-dry-run`) — validates alert payload structure (#35)
- Circuit breaker admin endpoints: trip, reset, account-level control
- GitHub webhook handler (`POST /webhooks/github`) for bidirectional issue lifecycle sync (#22)
- `workerName` config option for explicit worker name override (#28)
- `featureId` and `featurePrefix` config options for feature ID control (#30)
- Cost spike detection cron (200% threshold vs 24-hour baseline)
- Synthetic CB health check cron (hourly trip/verify/reset/verify pipeline validation)
- Analytics Engine SQL query helpers for integration tests (#36)
- P4 warning digest — daily batch of `console.warn()` entries into a single GitHub issue
- Soft error capture from `console.error()` in ok-outcome events
- Multi-error tail pipeline testing with 3 distinct error types (#33)
- KV proxy tracking verification with 10-read budget accumulation test (#40)

### Fixed
- Worker name detection chain: `config.workerName` > `env.WORKER_NAME` > `env.name` > `'worker'` (#28)
- CB reset propagation delay — writes `'GO'` with 60s TTL instead of `kv.delete()` for faster edge invalidation (#29)
- Feature ID format precedence clarified: `featureId` > `features` map > auto-generate (#30)
- Fingerprint stability test uses deterministic assertions (#33)
- Webhook test tolerance for KV propagation delays and fresh deploy routing

### Changed
- Status upgraded from "early development" to production-tested (deployed on Platform account with 18 consumer workers)

## [0.1.0] - 2026-03-15

### Added
- Core SDK: `monitor()` wrapper with auto-detection of worker name, bindings, and feature IDs
- Binding proxies for 8 types: D1, KV, R2, Workers AI, Vectorize, Queue, Durable Objects, Workflows
- Analytics Engine telemetry with 20-field append-only doubles layout
- Circuit breakers: feature-level, account-level, and global emergency stop via KV
- Per-invocation resource limits with `RequestBudgetExceededError`
- Error fingerprinting using FNV hash with message normalisation (strips UUIDs, timestamps, IPs)
- GitHub issue creation with priority labels (P0-P4) and transient pattern detection
- 7 built-in transient patterns: rate-limited, timeout, quota-exhausted, connection-refused, dns-failure, service-unavailable, cf-internal
- Error rate limiting: max 10 issues per script per hour
- Monitor worker with tail, scheduled, and fetch handlers
- Budget enforcement cron (daily + monthly) with Slack alerts at 70%, 90%, 100%
- Gap detection cron (AE primary, KV fallback) for monitoring coverage
- Worker discovery cron via Cloudflare API
- Daily rollup cron with AE marker
- Slack alerts with KV-based deduplication
- CLI: init, deploy, wire, status, coverage, secret, config sync, config validate, upgrade, migrate
- Wrangler config generator with JSON Schema validation
- Cloudflare API client for KV CRUD and namespace management
- JSON Schema for cf-monitor.yaml configuration
- 222 unit tests across 18 test files
- CI pipeline: Node 20/22 matrix, publint, attw, lockfile-lint, package validation
- Release workflow: tag-triggered npm publish

[Unreleased]: https://github.com/littlebearapps/cf-monitor/compare/v0.3.4...HEAD
[0.3.4]: https://github.com/littlebearapps/cf-monitor/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/littlebearapps/cf-monitor/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/littlebearapps/cf-monitor/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/littlebearapps/cf-monitor/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/littlebearapps/cf-monitor/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/littlebearapps/cf-monitor/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/littlebearapps/cf-monitor/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/littlebearapps/cf-monitor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/littlebearapps/cf-monitor/releases/tag/v0.1.0
