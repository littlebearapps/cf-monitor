# Changelog

All notable changes to cf-monitor are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

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

[0.2.1]: https://github.com/littlebearapps/cf-monitor/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/littlebearapps/cf-monitor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/littlebearapps/cf-monitor/releases/tag/v0.1.0
