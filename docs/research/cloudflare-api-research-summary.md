# Cloudflare API Surface — Research Summary

**Generated**: 2026-05-27
**Companion to**: [`cloudflare-api-surface.md`](./cloudflare-api-surface.md) (long-form) and [`cloudflare-api-surface.json`](./cloudflare-api-surface.json) (machine-readable).

## Live probe corrections (2026-05-27)

A live API probe ([`cloudflare-api-probe-results.md`](./cloudflare-api-probe-results.md)) verified endpoint shapes and corrected several pass-1/pass-2 assumptions, now folded into this summary and the companion docs:

1. **Queue GraphQL datasets are singular** — `queueBacklogAdaptiveGroups`, `queueMessageOperationsAdaptiveGroups`, `queueConsumerMetricsAdaptiveGroups`. The plural `queuesBacklogAdaptiveGroups` is a 400 "unknown field".
2. **R2 `actionType` returns S3-style names** (`GetObject`, `PutObject`, `ListBucket`, …), not `read`/`write`. Now classified (Class A / Class B / free / `unknown`) in `src/worker/crons/r2-classification.ts`.
3. **Billing endpoints exist** — `/billing/profile`, `/billing/history`, `/billing/usage` (403 without `Billing Read`; payloads unverified). `/billing/usage` is the **highest-priority follow-up** and may reshape cf-monitor's cost architecture. See [`billing-endpoints-follow-up.md`](./billing-endpoints-follow-up.md). **Do not wire into production until verified.**
4. **Notification alert types confirmed** — `billing_budget_alert`, `billing_usage_alert`.
5. **`Query.cost` / `viewer.budget` are GraphQL rate-limit counters**, not account billing/budget.
6. **Audit Logs v2** (`/logs/audit`) requires both `since` and `before`; v1 (`/audit_logs`) still works (deprecated).
7. **R2 `event-notification` REST path 404s** — Terraform implies an API exists but the obvious path is wrong; open question.

## What Cloudflare exposes today

| Capability | Surface | Confidence |
|---|---|---|
| Plan detection (Free vs Paid, billing period anchor) | `GET /accounts/{id}/subscriptions` | **billing-authoritative** for plan only |
| Aggregate per-product usage | GraphQL Analytics API (`/client/v4/graphql`), ~25 datasets across Workers, D1, KV, R2, DO, Queues, Stream, WAF, HTTP, LB, Email, Page Shield, Pipelines, NEL, Magic FW | **analytics_estimate** — Cloudflare explicitly states these are not billing-authoritative |
| Realtime queue backlog | `GET /accounts/{id}/queues/{id}/metrics` | runtime-metered |
| AI Gateway request logs (per-request cost, tokens, model) | `GET /accounts/{id}/ai-gateway/gateways/{id}/logs` | **billing-authoritative** |
| Resource discovery (Workers, D1, R2, KV, Queues, DO, Vectorize, AI Gateways, Pages, Hyperdrive, Zones) | Per-product `GET /accounts/{id}/<service>/...` endpoints | runtime-metered |
| Cross-product resource grouping by user-supplied tags | Resource Tagging API (public beta since 2026-04-27) | runtime-metered |
| Daily $-cost dashboard (matches invoice) | `Manage Account > Billing > Billable Usage` (Apr 2026) | **billing-authoritative** but **no public API** |
| Email-based budget threshold alerts | Budget Alerts via Notifications policy | alert-only |
| Generic webhook delivery for any alert | Notifications webhook destinations | alert-only |
| Native rate limits (per-gateway) | AI Gateway `rate_limiting_*` settings | native rate limiter |
| Native cost cap (per-route) | AI Gateway Dynamic Routes "Budget Limit" node | native hard control (per-route only) |
| Per-script CPU/subrequest limits | Workers script settings (`limits.cpu_ms`, `limits.subrequests`) | native rate limiter |
| Emergency traffic block | WAF custom rules + rate limiting (Rulesets API) | native circuit breaker (destructive) |
| Workers route detach / cron disable / safe-mode deploy | Workers REST CRUD | native circuit breaker (destructive) |
| Workers Free / D1 Free / KV Free / Workers AI Free / Hyperdrive Free daily caps | Built-in to platform; errors when exceeded | native hard control (Free only) |

## What requires restricted / alpha / beta access

| Capability | Status | Notes |
|---|---|---|
| Resource Tagging | Public beta (since 2026-04-27) | API is stable but behaviour may change. AOT auth recommended. |
| `wrangler d1 insights` (per-query D1 metrics CLI) | Experimental | Output and flags may change. GraphQL `d1QueriesAdaptiveGroups` underpins it. |
| Account-level rate limiting rules | Enterprise + paid add-on | Custom rulesets at account level limited to zones on Enterprise. |
| AI Gateway Unified Billing | GA but requires Cloudflare credits loaded | Third-party model calls billed via account credits, not provider API keys. |
| FOCUS/FinOps-style billing export | Not publicly documented | Enterprise sales-channel only. |
| Workers Bundled/Unbound usage models | Legacy | Default since 2023-10-30 is Standard for new Paid accounts; legacy honoured per-script for older accounts. |

## API token permission requirements

**Recommended read-only token** (cf-monitor's default ask):
`Billing Read`, `Account Analytics`, `Workers Scripts Read`, `Workers Tail Read`, `Workers Observability Read`, `D1 Read`, `Workers KV Storage Read`, `Workers R2 Storage Read`, `Queues Read`, `AI Gateway:Read`, `Workers AI Read`, `Vectorize Read`, `Hyperdrive Read`, `Pages Read`, `Notifications Read`, `Account Settings Read`.

**Opt-in controller token** (only for native control actions):
`Notifications Write`, `AI Gateway:Edit`, `Workers Scripts Edit`, `Workers Routes Edit`, `Zone WAF Write`, `Queues Edit`, `Billing Edit`. Account-level WAF / Rulesets require `Account WAF Write` + `Account Rulesets Write` (Enterprise + paid add-on for account-deployed rate limiting).

Full matrix in [`cloudflare-api-surface.md` §11](./cloudflare-api-surface.md#11-permission-matrix) and [`cloudflare-api-surface.json` → `permissionMatrix`](./cloudflare-api-surface.json).

## What is billing-authoritative vs only approximate

**Billing-authoritative** (can be trusted as invoice-matching):
- Plan state from `/subscriptions`.
- Billable Usage dashboard (dashboard-only — no API).
- AI Gateway per-request logs (provider cost is pass-through from upstream).
- Unified AI REST API calls (logged by default gateway).

**Approximate (`analytics_estimate`)**:
- All GraphQL Analytics datasets — `workersInvocationsAdaptive`, `d1AnalyticsAdaptiveGroups`, `kvOperationsAdaptiveGroups`, `r2OperationsAdaptiveGroups`, `durableObjectsInvocationsAdaptiveGroups`, `queueBacklogAdaptiveGroups`, `streamMinutesViewedAdaptiveGroups`, `firewallEventsAdaptive`, etc. — explicitly documented as non-billing.
- cf-monitor's own AE rollups (rate-of-truth depends on instrumentation coverage).

**Runtime-metered** (highest fidelity for cf-monitor-instrumented worker tree):
- KV / D1 / R2 / Queue / DO / Workers AI / Vectorize binding proxies. Highest accuracy for *what cf-monitor saw*, but blind to traffic outside instrumented workers.

## What can actually enforce hard limits

Five sources of true cost-stop on Cloudflare today:

1. **Free-plan daily caps** (Workers, D1, KV, Workers AI, Hyperdrive, Images) — the platform itself returns errors when caps are exceeded. On Paid, these vanish.
2. **AI Gateway per-gateway rate limit** — caps throughput but is request-rate, not $-rate.
3. **AI Gateway Dynamic Routes Budget Limit node** — only true native $-cap; per-route only; switches to fallback model (still billable).
4. **Workers per-invocation CPU + subrequest limits** — caps blast radius per call, not cumulative spend.
5. **WAF / Rulesets emergency block / rate-limit rules** — stop traffic at the edge (destructive).

Workers for Platforms Custom Limits is a sixth, but only available inside a dispatch Worker context.

## What can only alert

- Budget Alerts (email when projected spend crosses $-threshold; daily evaluation).
- Usage-based billing notifications (D1 rows_read/written threshold alerts).
- Generic notification policies (health, security, deployment, DDoS, Page Shield, Stream).
- Webhook destinations for any of the above.

## What cannot be done through public APIs

- **No account-wide hard spend cap**. There is no Cloudflare equivalent of AWS Budgets enforce mode.
- **No public API for the Billable Usage dashboard / invoice-grade per-product cost**. Dashboard-only.
- **No FOCUS-style FinOps export** for PAYG customers.
- **No plan-allowance API** — values must be maintained from the [Workers pricing page](https://developers.cloudflare.com/workers/platform/pricing/) and individual product pricing pages. cf-monitor's `plan-allowances.ts` is therefore a required artefact.
- **No GraphQL Analytics for AI Gateway, Vectorize, Hyperdrive, Workflows, Cache Reserve** — use product-specific REST or fall back to runtime metering.
- **No "disable script" toggle distinct from deletion** — closest options are detach route, deploy no-op safe-mode, or empty cron schedule.
- **No AI Gateway account-wide $-spend cap setting** — only per-Dynamic-Route Budget Limit nodes.
- **No realtime per-account credit balance read** for Unified Billing (not surfaced in docs).

## Recommended implications for cf-monitor architecture

1. **Position cf-monitor as the enforcement layer Cloudflare doesn't ship.** Cloudflare provides observability and email alerts; cf-monitor provides the runtime budget guard. Lead with this in marketing copy.
2. **Every cost number gets a confidence label.** `billing_authoritative` / `analytics_estimate` / `runtime_metered` / `user_configured` / `dashboard_documented_no_public_api` / `unknown`. Surface in `/usage`.
3. **Never silently assume Free plan.** Plan-detection failures default to "Paid (assumed)". cf-monitor already does this — keep it.
4. **Keep the SDK runtime-meter authoritative for enforcement.** GraphQL/CF dashboard is *visibility*, not *control*. Pre-invocation guard remains in the SDK proxy.
5. **Controller token is opt-in.** Default `cf-monitor init` asks only for read-only permissions. Edit permissions live in a separate controller token requested only when user enables native control actions.
6. **Tier additions by foundation-first dependency** (see [`cloudflare-api-surface.md` §13](./cloudflare-api-surface.md#13-recommended-cf-monitor-implementation-plan)):
   - **Tier 1 (done)**: subscriptions, 5 GraphQL datasets, AI Gateway logs, workers/scripts list, runtime proxies.
   - **Tier 2 (next)**: Queues realtime metrics REST, Vectorize stored-vector polling, Pages projects discovery, Budget Alert webhook subscription.
   - **Tier 3 (controller token, opt-in)**: AI Gateway rate-limit setter, AI Gateway Dynamic Routes Budget Limit, Workers route detach, cron disable, WAF emergency rate limit.
   - **Tier 4 (explicitly unsupported)**: account-wide spend cap installation, invoice extraction, plan-allowance fetch.
7. **Annual schema verification.** GraphQL dataset names change (cf-monitor #57, #58, #93 were dataset/field corrections). Re-run introspection against current schema before each release.
8. **Resource Tagging migration plan.** Tagging entered public beta on 2026-04-27. Until GA, treat as optional. Once GA, allow users to group cf-monitor's `/usage` view by their own `project=…` / `env=…` tags rather than worker-name conventions.
9. **Be explicit about what CF cannot do.** Marketing copy and docs should state: "Cloudflare provides Budget Alerts (email-only) and the Billable Usage dashboard. cf-monitor adds the runtime budget guard Cloudflare does not ship."

## Biggest blockers / unknowns

1. **No billing-authoritative public API for indie developers.** This is the strongest argument for cf-monitor existing — and the single hardest gap to close.
2. **GraphQL schema drift.** Datasets and fields are removed/renamed without long deprecation windows. cf-monitor must keep queries minimal and per-product, and add per-service try-catch.
3. **Resource Tagging stability during beta.** Won't be safe to make load-bearing until GA.
4. **AI Gateway account-wide spend cap absence.** This is the most surprising omission given AI's cost variance. Document the workaround: install per-Dynamic-Route Budget Limit nodes.
5. **Workers Logs cost growth.** 5B logs/day account cap then sampling. Heavy logging from instrumented Workers could itself be a cost surprise.
6. **Plan-allowance maintenance burden.** cf-monitor's `plan-allowances.ts` must be reviewed quarterly against [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) — pricing pages are the only source of truth.

## Files created in this research pass

- `docs/research/cloudflare-api-surface.md` — long-form (15 sections, ~50 surfaces in tables, full source-link bibliography)
- `docs/research/cloudflare-api-surface.json` — machine-readable inventory (`surfaces`, `permissionMatrix`, `recommendations`, `openQuestions`)
- `docs/research/cloudflare-api-research-summary.md` — this file

## Recommended next implementation prompt

> **P0 (do first — gates the cost-ingestion architecture)**: Capture the `/accounts/{id}/billing/usage` payload with a `Billing Read` token via `npx cf-monitor probe billing`, then decide whether cost ingestion should be built on that (potentially billing-authoritative) data instead of the approximate GraphQL estimates. Do NOT wire any `/billing/*` endpoint into production `/usage` until the payload shape is verified. See [`billing-endpoints-follow-up.md`](./billing-endpoints-follow-up.md).
>
> Then, given the cf-monitor research at `docs/research/cloudflare-api-surface.md`, implement the **Tier 2 additions**:
>
> 1. Add a `collect-queues-realtime` cron handler that polls `GET /accounts/{id}/queues/{id}/metrics` for each queue discovered via `GET /accounts/{id}/queues`, writing `backlog_count` and `oldest_message_timestamp_ms` to AE.
> 2. Add a `collect-vectorize-storage` cron handler that polls `GET /accounts/{id}/vectorize/indexes` and per-index `list_vectors` (pagination-aware) for stored-dimension counts.
> 3. Add a `collect-pages-projects` cron handler that polls `GET /accounts/{id}/pages/projects` and surfaces project list in `/usage` so Pages Functions are attributable.
> 4. Add an optional `--register-budget-alert <threshold>` flag to `cf-monitor init` that, when present, creates a CF Budget Alert policy and registers cf-monitor's `/webhooks/cf` endpoint as a destination (uses `Notifications Write`). Surface in `/status` that this is a redundant signal — not enforcement.
> 5. Update `/usage` to label every metric with its confidence (`billing_authoritative` / `analytics_estimate` / `runtime_metered`).
>
> Constraints: keep additions fail-open. New cron handlers must respect existing per-invocation request limits and use `enrichEnv()`. Add tests using existing Miniflare patterns. Do not modify the static plan-allowance catalogue in this PR.
