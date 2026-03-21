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
| **Status** | Early development (v0.1.0) |
| **Repository** | https://github.com/littlebearapps/cf-monitor |
| **Licence** | MIT |
| **Issues** | https://github.com/littlebearapps/cf-monitor/issues |

**Quick Commands**:
```bash
npm test              # Run all tests (vitest)
npm run typecheck     # TypeScript check (Workers + CLI)
npm run build:cli     # Build CLI for npm publish
npm pack --dry-run    # Verify package contents
```

---

## Repository Structure

```
cf-monitor/
├── package.json              # @littlebearapps/cf-monitor
├── tsconfig.json             # Workers runtime types
├── tsconfig.cli.json         # Node16 types for CLI
├── cf-monitor.schema.json    # JSON Schema for config validation (TODO)
│
├── src/
│   ├── index.ts              # Single public export: monitor()
│   ├── types.ts              # All public types
│   ├── constants.ts          # KV prefixes, AE field mapping, pricing
│   │
│   ├── sdk/                  # Runtime SDK (installed in consumer workers)
│   │   ├── monitor.ts        # monitor() wrapper — main entry point
│   │   ├── proxy.ts          # Binding proxies (D1, KV, R2, AI, Vectorize, Queue)
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
│   │   ├── fetch-handler.ts  # API: /status, /errors, /budgets, /workers
│   │   ├── crons/            # Cron handlers (metrics, budgets, gaps, discovery)
│   │   ├── errors/           # Fingerprinting, patterns, GitHub issue CRUD
│   │   ├── alerts/           # Slack alerts with dedup
│   │   └── optional/         # AI features (opt-in, not yet implemented)
│   │
│   └── cli/                  # CLI: npx cf-monitor <command>
│       ├── index.ts          # Commander setup
│       ├── commands/          # init, deploy, wire, status, coverage
│       ├── wrangler-generator.ts
│       └── cloudflare-api.ts
│
├── worker/                   # Pre-built entry for wrangler deploy
│   └── index.ts
│
└── tests/                    # Vitest tests (TODO)
    ├── sdk/
    ├── worker/
    └── cli/
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
| `scheduled()` | `*/15 * * * *` | Gap detection |
| `scheduled()` | `0 * * * *` | CF GraphQL metrics, budget enforcement, synthetic CB health |
| `scheduled()` | `0 0 * * *` | Daily rollup, worker discovery |
| `fetch()` | On-demand | API: /status, /errors, /budgets, /workers, /_health |

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
| `budget:usage:daily:` | Daily usage counters |
| `err:fp:` | Error fingerprint → GitHub issue URL |
| `err:rate:` | Per-script error rate limit |
| `workers:` | Auto-discovered worker registry |

---

## Key Files

| Purpose | File |
|---------|------|
| Public API | `src/index.ts` — exports `monitor()` |
| Worker wrapper | `src/sdk/monitor.ts` — the main SDK entry point |
| Binding proxies | `src/sdk/proxy.ts` — D1, KV, R2, AI, Vectorize, Queue tracking |
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
| **Platform** | `~/claude-code-tools/lba/infrastructure/platform/main/` — cf-monitor's predecessor. Contains the workers being replaced. |
| **Platform SDKs** | `~/claude-code-tools/lba/infrastructure/platform-sdks/main/` — `@littlebearapps/platform-consumer-sdk` (v3.0.5) that cf-monitor replaces. Source of forked code. |
| **Scout** | `~/claude-code-tools/lba/scout/` — First target for cf-monitor migration (dedicated CF account). |
| **Brand Copilot** | `~/claude-code-tools/lba/marketing/brand-copilot/main/` — Second migration target. |
| **Aus History MCP** | `~/claude-code-tools/lba/apps/mcp-servers/australian-history-mcp/` — Third target (currently dormant). |
| **ViewPO** | `~/claude-code-tools/lba/apps/devtools/viewpo/main/` — Fourth target (dedicated CF account). |

---

## Open Work

See https://github.com/littlebearapps/cf-monitor/issues for all planned features. Key priorities:

- **Testing** — Vitest setup, SDK unit tests, worker unit tests, CLI tests (#1, #2, #3, #23)
- **Budget accumulation** — SDK must write daily KV counters for budget-check to read (#25)
- **Gap detection AE queries** — Replace KV last_seen with AE SQL (#11)
- **CI pipeline** — GitHub Actions for lint, test, build, publish (#20)
