# AGENTS.md — cf-monitor

`@littlebearapps/cf-monitor` is a self-contained, per-account Cloudflare monitoring SDK. One npm package, one worker per account, zero D1.

## Quick Commands

```bash
npm test                    # 316 unit tests (vitest)
npm run test:integration    # 53 integration tests (deploys to CF, needs credentials)
npm run typecheck           # TypeScript strict (Workers + CLI)
npm run build:cli           # Build CLI for npm publish
npm pack --dry-run          # Verify package contents
npm run release -- <version>  # Bump version across 6 files, commit, tag, push
```

## Project Structure

```
cf-monitor/
  src/
    index.ts              # Single public export: monitor()
    types.ts              # All public types
    constants.ts          # KV prefixes, AE field mapping, pricing
    sdk/                  # Runtime SDK (installed in consumer workers)
      monitor.ts          # monitor() wrapper — main entry point
      proxy.ts            # Binding proxies (D1, KV, R2, AI, Vectorize, Queue, DO, Workflow)
      metrics.ts          # MetricsAccumulator + AE data point conversion
      circuit-breaker.ts  # CB check/trip/reset via KV
      detection.ts        # Auto-detect worker name, bindings, feature IDs
    worker/               # The single cf-monitor worker (deployed per account)
      index.ts            # Export: { fetch, scheduled, tail }
      tail-handler.ts     # Error capture from all tailed workers
      scheduled-handler.ts # Cron multiplexer
      fetch-handler.ts    # API endpoints
      self-monitor.ts     # Self-monitoring: cron tracking, error counts
      crons/              # 8 cron handlers: budget-check, collect-metrics, collect-account-usage, cost-spike, daily-rollup, gap-detection, synthetic-health, worker-discovery
      errors/             # Fingerprinting, patterns, GitHub issue CRUD
      alerts/             # Slack alerts with dedup
      account/            # Plan detection, billing period, allowances
      optional/           # STUB handlers for AI features (pattern-discovery, health-reporter, coverage-auditor) — not yet implemented in v0.3.7
    cli/                  # CLI: npx cf-monitor <command>
      commands/           # 9 commands: init, deploy, wire, status, coverage, secret, config-sync, upgrade, migrate, usage
  tests/                  # 316 unit tests + 53 integration tests (10 files)
  worker/                 # Pre-built entry for wrangler deploy
  docs/                   # 20 documentation files (getting-started, configuration, security, troubleshooting + 10 guides + 3 how-to)
```

## Key Conventions

- **One export**: `import { monitor } from '@littlebearapps/cf-monitor'`
- **Fail-open**: SDK errors must never break consumer workers
- **AE schema**: Doubles positions 0-19 are append-only — never reorder
- **KV versioning**: Prefixes include version (e.g. `cb:v1:`) for safe migration
- **No D1**: Analytics Engine for metrics, KV for state. Zero database migrations.
- **Australian English**: realise, colour, licence

## Stubs & Partial Features (v0.3.7)

Do not assume these work end-to-end:

- `src/worker/optional/pattern-discovery.ts`, `health-reporter.ts`, `coverage-auditor.ts` — stubs. Enabling `ai.*` flags in `cf-monitor.yaml` is a no-op. Tracked: #8, #9, #10.
- `transient_patterns:` YAML key — parsed and loaded into `env._customTransientPatterns`, but `src/worker/errors/patterns.ts` `matchTransientPattern()` only consults built-ins. Tracked: #92.
- `monitoring.spike_threshold` YAML key — schema validates but `src/worker/crons/cost-spike.ts:7` hardcodes `2.0`.

If you're asked to use any of these, implement the missing wiring first or flag the stub to the user.

## Architecture

```
Consumer Workers ──(tail)──> cf-monitor worker ──> GitHub Issues
    │                           │                     Slack Alerts
    └──(AE write)──> Analytics Engine <──(SQL)── cf-monitor crons
```

Storage: Analytics Engine (free, 90-day retention) + KV (1 namespace).

## Testing

- Unit tests use vitest with mock KV/AE helpers in `tests/helpers/`
- Integration tests deploy real workers with `test-` prefix to a CF account
- All SDK code must fail open — wrap in try-catch at boundaries

## Documentation

See `docs/README.md` for the full documentation index.
