# Protection Coverage

cf-monitor's protection coverage layer turns the raw `/usage` data into an actionable audit: **where could this Cloudflare account still get hurt?** It does not enforce anything — it answers the question "what visibility and enforcement do I actually have?"

## Two ways to consume

- **HTTP endpoint** (machine-readable):
  ```bash
  curl https://<your-cf-monitor-worker>/protection
  ```
- **CLI** (human-readable):
  ```bash
  npx cf-monitor protection           # grouped by severity, with score
  npx cf-monitor protection --json    # raw JSON, same as the HTTP endpoint
  ```

## What it does (and what it does NOT do)

| ✓ Does | ✗ Does NOT |
|---|---|
| Read existing KV snapshots (usage, queues, Pages, Vectorize, AI Gateway, budget alert) | Add new collectors |
| Cross-reference REST-discovered workers against SDK heartbeats | Mutate any Cloudflare resource |
| Score the account 0–100 (deterministic, heuristic) | Replace runtime SDK budget enforcement |
| Surface "where can I still get hurt?" findings | Set Cloudflare-side limits, rate limits, WAF rules |
| Recommend specific Tier-3 follow-ups | Detach routes, deploy safe-mode workers, disable crons |

This phase ships ten finding categories — see the brief for the full list. Every finding carries `destructive_action_required: false`. A future Tier 3 layer will add controller-token-driven destructive controls; until then, **runtime SDK proxies in your consumer workers remain the strongest enforcement layer.**

## Status vocabulary

| Status | Meaning |
|---|---|
| `protected` | Authoritative evidence of enforcement (e.g. SDK heartbeat present → per-invocation budgets apply) |
| `partially_protected` | Visibility exists but enforcement is downstream / advisory / alert-only |
| `unprotected` | No enforcement and no visibility for this surface |
| `unknown` | cf-monitor cannot determine the state from data it has today |
| `not_applicable` | The surface doesn't exist on this account (e.g. no queues) |

## Severity → score penalty

| Severity | unprotected | partially_protected | unknown |
|---|---|---|---|
| critical | -20 | -10 | -5 (capped) |
| high     | -12 | -6  | -5 (capped) |
| medium   | -6  | -3  | -3 |
| low      | -2  | -1  | -1 |
| info     |  0  |  0  |  0 |

Score starts at 100, clamps at 0. **The score is a directional UX signal, not actuarial science** — it's deliberately simple so it's predictable and easy to debug. Two different cf-monitor versions will produce different scores from the same account state if finding categories or severities are added/changed; treat the score as a comparable-to-itself indicator over time, not an absolute risk number.

## The ten finding categories (Phase 7)

| # | Category | Trigger | Default status |
|---|---|---|---|
| 1 | Billing reality check | always | `partially_protected` (medium) |
| 2 | Budget Alert status | KV blob present/absent | `partially_protected` / `unprotected` |
| 3 | Queue storm protection | per queue from realtime backlog | `protected` (info) up to `unprotected` (critical) |
| 4 | Pages billing ambiguity | per discovered project | `unknown` (medium) |
| 5 | Vectorize visibility gap | per discovered index | `partially_protected` (low) |
| 6 | R2 ListBucket ambiguity | only when R2 usage observed | `partially_protected` (low) |
| 7 | Runtime SDK coverage | per worker in WORKER_LIST | `protected` if heartbeat, else `partially_protected` |
| 8 | AI Gateway native controls | when AI Gateway data present | `unknown` (high) |
| 9 | Worker CPU/subrequest limits | always (strategic) | `unknown` (medium/low) |
| 10 | Safe-mode emergency controls | always (strategic) | `unprotected` (medium/high) |

## Confidence labels in the response

The `/protection` response includes a per-area confidence map (`overall`, `usage`, `runtime`, `billing`) and a per-finding `confidence` label, drawing on the same vocabulary used by `/usage` ([`billing-endpoints-follow-up.md`](./research/billing-endpoints-follow-up.md) "Confidence label vocabulary"):

- `billing_authoritative` — invoice-grade (used sparingly here: only for `/billing/history` if/when wired).
- `analytics_estimate` — approximate, from CF GraphQL Analytics.
- `runtime_metered` — direct SDK proxy or REST read.
- `alert_only` — CF Budget Alert subscriptions sit here.
- `dashboard_documented_no_public_api` — the Billable Usage dashboard.
- `unknown` — the audit could not determine state.

## Important caveats

1. **Visibility ≠ enforcement.** Seeing a Pages project, a Queue, or a Vectorize index in `/protection` does NOT mean cost is bounded. Only runtime SDK budget enforcement hard-stops blast radius.
2. **Budget Alerts are alert-only.** CF emails the recipient when the dashboard-configured threshold is hit — no API stops spend.
3. **Current-cycle invoice-grade per-product spend is dashboard-only.** `/billing/usage` is NOT that API (Phase 3 finding); `/billing/history` covers past invoices only.
4. **The score is heuristic.** Use it to track change over time on your own account, not to compare accounts or version cf-monitor instances.
5. **`/protection` is auth-required by default** (Phase 9). Unauthenticated callers receive `401 Unauthorized`. Send `Authorization: Bearer $ADMIN_TOKEN` to access (the same admin token the `/admin/*` POSTs use). The CLI (`npx cf-monitor protection`) reads `CF_MONITOR_ADMIN_TOKEN` from your shell env, or accepts `--admin-token <token>`. For operators who want a public-but-safe variant, set `CF_MONITOR_PROTECTION_PUBLIC=redacted` on the worker — unauthenticated callers then get a response with all resource names redacted but the score and severity counts visible. See [`security.md`](./security.md) → "Read endpoint authentication".

## Tier-3 future work (deferred)

Tier 3 will introduce a controller-token tier and destructive controls. Until then `/protection` will keep recommending these:

- AI Gateway native rate-limit + Dynamic Routes Budget Limit audit + setter.
- Per-worker `cpu_ms` / `subrequests` limit audit + setter.
- Emergency safe-mode controls: route detach, cron disable, account WAF rate-limit rules.
- Queue purge orchestration (last-resort, destructive).

Until each Tier-3 surface ships its own pre-condition test gate, treat the corresponding findings as "where you'd want a Tier-3 action to exist."
