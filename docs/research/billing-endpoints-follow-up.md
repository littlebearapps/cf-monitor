# Billing Endpoints — Follow-up (Billing Read verified)

**Created**: 2026-05-28
**Source**: [`cloudflare-api-probe-results.md`](./cloudflare-api-probe-results.md) §B (Scout 2026-05-27, 403 on all three) + Platform Billing-Read probe 2026-05-28 (snapshot below).

## Confidence label vocabulary (canonical)

Every `/usage` response field carries a `confidence.<key>` label from this vocabulary (defined as `ConfidenceLabel` in `src/types.ts`). Other docs MUST reuse the exact strings — no synonyms.

| Label | Meaning | Used for |
|---|---|---|
| `billing_authoritative` | Trustworthy as invoice-grade for what it covers | `/subscriptions` plan, `/billing/history` past invoices, AI Gateway per-request logs |
| `analytics_estimate` | Cloudflare-disclaimed as not-billing-grade | All GraphQL Analytics datasets (workers / d1 / kv / r2 / DO etc.) |
| `runtime_metered` | Direct REST read or SDK proxy — measured, not estimated | Queue realtime backlog, Pages projects, Vectorize indexes, SDK binding proxies |
| `user_configured` | User-supplied configuration | budgets, thresholds |
| `static_catalogue` | Hard-coded constants reviewed periodically | Plan allowances (`plan-allowances.ts`) |
| `alert_only` | Notification, not enforcement | Cloudflare Budget Alerts |
| `dashboard_documented_no_public_api` | Dashboard-only, no programmatic equivalent | Billable Usage dashboard |
| `verified_undocumented` | Endpoint exists + shape known via probe, no Cloudflare docs page | `/billing/profile` |
| `unknown` | Source unverified or ambiguous | anything not yet classified |

Code reference: `src/worker/fetch-handler.ts → handleUsage()` emits the per-key `confidence` map on every `/usage` response.

## Tier 2 collectors (added 2026-05-28)

Three new REST-derived collectors are now live alongside the GraphQL-based `collect-account-usage` pipeline. All three are **fail-open** — a single failure does not block the rest of the cron set, and missing data simply returns `null` in the `/usage` response.

| Collector / surface | Cron | KV key | Source | Confidence |
|---|---|---|---|---|
| `collect-queue-realtime` | hourly | `KV.USAGE_QUEUE_REALTIME` | `GET /queues` + `GET /queues/{id}/metrics` | `runtime_metered` |
| `discover-pages-projects` | daily | `KV.USAGE_PAGES_DISCOVERY` | `GET /pages/projects?per_page=100` | `runtime_metered` |
| `discover-vectorize-indexes` | daily | `KV.USAGE_VECTORIZE_DISCOVERY` | `GET /vectorize/indexes?per_page=50` | `runtime_metered` |
| **Budget Alert subscription** (opt-in) | on demand via `cf-monitor init --register-budget-alert <n>` | `KV.CONFIG_BUDGET_ALERT` | POST `/alerting/v3/policies` with `alert_type: 'billing_budget_alert'` | `alert_only` |

Pages caveat: static assets are free; only Pages Functions are billed (as Workers). cf-monitor records `functions_usage: 'unknown'` per project rather than probing each — operators must NOT assume every Pages project is billable.

Vectorize caveat: **metadata only**. Per-index vector counts are NOT collected because that requires paginating `list_vectors` per index, which is expensive. Each snapshot carries a `caveat` string explaining the gap.

Budget Alert caveat: the `--register-budget-alert <threshold>` flag subscribes a CF notification policy to the `billing_budget_alert` event type. The **$threshold itself is NOT settable via the Notifications API** — it must be configured in the Cloudflare dashboard (`Manage Account > Billing > Billable Usage > Add a Budget Alert`). cf-monitor records the user-stated threshold in the policy description + KV blob for tracking, and the CLI prints a clear dashboard-step instruction. See [`budget-alert-registration-todo.md`](./budget-alert-registration-todo.md) for the full implementation map. Companion diagnostic: `cf-monitor probe alerting` (read-only).

## What the probes found

| Endpoint | Method | Scout token (2026-05-27) | Platform token w/ Billing Read (2026-05-28) | Verdict |
|---|---|---|---|---|
| `/accounts/{id}/billing/profile` | GET | 403 — exists, needs Billing Read | 200 — account billing contact + address | Documented; **not wired** (PII, no cost data) |
| `/accounts/{id}/billing/history` | GET | 403 — exists, needs Billing Read | 200 — paginated invoice rows with $-amounts | **Billing-authoritative** for past invoices; tracked as a possible follow-up |
| `/accounts/{id}/billing/usage` | GET | 403 — exists, needs Billing Read | **400 with bare path** ("time delta \"minute\" doesn't exist"); 200 with `?time_delta=day` | **NOT the Billable Usage API** — generic metric query, no per-product cost. Decision: do not wire |
| `/accounts/{id}/subscriptions` | GET | 200 (Scout) | 200 (Platform) — schema confirmed | Already consumed by `src/worker/account/subscriptions.ts` |

(`/accounts/{id}/billing`, `/billing/summary`, `/billing/invoices`, `/billing/payment_methods` all 400 "could not route" — they are NOT endpoints.)

## Why this mattered (and how it resolved)

cf-monitor's current usage/cost picture is built from **approximate** GraphQL Analytics data, which Cloudflare explicitly states is *not billing-authoritative*. The Billable Usage dashboard is the authoritative daily-cost view but has historically been **dashboard-only with no public API**.

The hope going into the Billing Read probe was that `/billing/usage` would be that long-missing programmatic equivalent and would reshape cf-monitor's cost architecture. **It is not.** `/billing/usage` is a generic time-series metric query (caller supplies `metrics`/`dimensions`/`since`/`until`/`time_delta`) that returns metric values, not cost. See the "Probe outcomes" section below for the full shape.

The runner-up finding — `/billing/history` returns real invoice rows with $-amounts — is genuinely useful for retrospective spend reporting, but it does not replace the runtime/GraphQL stack and does not warrant a production change in this phase.

## Hard guardrail (unchanged)

**Do NOT wire `/billing/usage` (or `/billing/profile`) into production.** `/billing/history` ingestion is a possible **separate, future** phase that must clear the 4-test gate documented under "Pre-conditions" below. No production code in this pass reads any `/billing/*` endpoint — only the read-only `cf-monitor probe billing` diagnostic does.

## How to run the probe safely

The probe is **read-only** (GET only, never mutates) and **redacts** sensitive values before saving. It writes a redacted JSON snapshot under `docs/research/probes/`.

```bash
# 1. Get a token with the Billing Read permission (Platform account).
export CLOUDFLARE_ACCOUNT_ID=<platform-account-id>     # 32-char hex
export CLOUDFLARE_API_TOKEN=<token-with-Billing-Read>

# 2. Run the probe (saves docs/research/probes/billing-probe-<date>.redacted.json).
npx cf-monitor probe billing
#   …or from a source checkout:
node dist/cli/index.js probe billing
```

The command prints a per-endpoint outcome (`payload returned` / `exists — needs Billing Read` / `does not route` / `unknown error`) and saves the redacted bodies. With a token that lacks `Billing Read` you will see `permission_denied (403)` for all three `/billing/*` endpoints — that confirms they exist; re-run with a Billing Read token to capture the actual payloads.

Implementation: `src/cli/probe-billing.ts` (core: `classifyProbeOutcome`, `redactBilling`, `probeBillingEndpoints`) + `src/cli/commands/probe-billing.ts` (wrapper). Tests: `tests/cli/probe-billing.test.ts`.

## Probe outcomes — captured 2026-05-28 (Platform account, Billing Read token)

Snapshot: [`probes/billing-probe-2026-05-28.redacted.json`](./probes/billing-probe-2026-05-28.redacted.json). Probe re-run after patching `redactBilling` to also redact opaque-id-shaped values (32-hex, UUIDs, Stripe `sub_…` ids) — the first run leaked subscription / zone / billing-profile / Stripe identifiers through the key-only filter; nothing was committed pre-patch.

### /accounts/{id}/billing/profile

- **HTTP status**: 200
- **Redacted payload shape** (CF success envelope `{errors, messages, result, success}`, `result` keys):
  `id, first_name, last_name, billing_email, company, address, city, state, zipcode, country, account_type`
- **Field meanings**: account billing contact + postal address. `account_type` is the CF account class (e.g. `"business"`). `country` is a 2-letter ISO code (e.g. `"AU"`).
- **Sensitive fields observed**: `first_name`, `last_name`, `billing_email`, `company`, `address`, `zipcode`, `id`. All redacted to `<REDACTED>` or `<REDACTED_ID>`. `city`/`state`/`country`/`account_type` pass through (low-sensitivity, useful as confidence signal).
- **Useful to cf-monitor?** **Marginal.** `account_type` and `country` could feed an "account context" badge in the dashboard, but nothing here is cost-relevant. Not worth wiring.

### /accounts/{id}/billing/history

- **HTTP status**: 200
- **Redacted payload shape**: `result` is an array of invoice rows; each row has keys:
  `id, type, occurred_at, amount, amount_to_pay, currency, invoice_id, receipt_id, status, source`.
  Plus `result_info: {page, per_page, next_page}`.
- **Appears to be invoice/charge history?** **YES — billing-authoritative for past invoices.** Each row carries a real Stripe-charged amount (e.g. `5.76`, `15.26`, `278.20`) with `currency: "usd"`, `status: "CLOSED"`, `source: "stripe"`, and the `occurred_at` timestamp. The Platform account's 2026-01 invoice ($278.20) lines up with the January 2026 D1 incident noted in `CLAUDE.md`.
- **Pagination params**: `page`, `per_page` (default 50). The probe captured 7 rows on `page=1, next_page=false`.
- **Time-range params**: not discovered in this probe (the probe used the bare path). Likely `since`/`until` or `from`/`to` based on CF conventions; needs a follow-up probe with explicit params if cf-monitor wants to scope queries.
- **Sensitive fields**: `id`, `invoice_id`, `receipt_id` — all redacted. The dollar `amount` / `amount_to_pay` fields are NOT redacted (financial figures rather than PII); treat the captured snapshot as account-confidential anyway.

### /accounts/{id}/billing/usage?time_delta=day  ← HIGHEST PRIORITY — major finding

- **HTTP status**: 200 (only when `?time_delta=day` is supplied; bare path returns 400 `"time delta \"minute\" doesn't exist"`).
- **Redacted payload shape**: `result` block with keys
  `rows, data[{metrics: [[…]]}], data_lag, min, max, totals, time_intervals[[…]], query{dimensions, metrics, since, until, time_delta, limit}`.
  No per-product breakdown was returned; `min`/`max`/`totals` were empty objects in this probe.
- **Per-product usage included?** **NO** — the server defaulted to a SINGLE metric (`metrics: ["streamMinutesViewed"]`) and returned one time-bucket `data: [{ metrics: [[0]] }]`. There is no field that enumerates per-product usage rows. The shape suggests this is a **generic metric-query endpoint** (caller specifies `metrics`/`dimensions`/`since`/`until`/`time_delta`/`limit`) rather than the long-hoped programmatic equivalent of the Billable Usage dashboard.
- **Per-product cost ($) included?** **NO.** Response has no cost fields. Only the requested metric values.
- **Billing-cycle aligned?** **No.** `time_intervals` is determined by the caller's `since`/`until`/`time_delta`. The endpoint is time-bucketed analytics, not billing-cycle aligned.
- **Invoice-grade or estimated?** Cannot claim invoice-grade. The endpoint did not return any `$-cost` figure, only a Stream-metric value of `0`. The query echo confirms `time_delta: "day"`, default `metrics: ["streamMinutesViewed"]`, default `limit: 100000`.
- **Query/time-range params**: `since` (ISO), `until` (ISO), `time_delta` ∈ {`day`, `hour`, `month` — exact set not enumerated; `minute` is rejected as "doesn't exist"), `metrics` (array of metric names), `dimensions` (array), `limit` (int). The probe did not enumerate the full metric vocabulary.
- **Sensitive fields observed**: none in this minimal response — but the metric set + dimensions a real query would request could expose account-scoped data.

**Bottom line**: `/billing/usage` is **not the Billable Usage API**. It's a generic CF analytics-style metric-query endpoint that defaults to Stream-only metrics. cf-monitor's GraphQL Analytics datasets already provide equivalent (or richer) per-product time-series data with the same approximate-not-authoritative caveat. There is no programmatic billable-cost equivalent of the Billable Usage dashboard via this path.

### /accounts/{id}/subscriptions  (baseline — already used by cf-monitor)

- **HTTP status**: 200, 17 subscriptions returned.
- **Confirms existing schema** assumed in `src/worker/account/subscriptions.ts`? **YES** for the fields that module reads (`rate_plan.id`, `rate_plan.scope`, `current_period_start`, `current_period_end`). Additional fields are present but not yet consumed:
  - `id`, `external_id` (Stripe `sub_…`; present only on PAYGO entries), `currency`, `state` (`"Paid"`), `frequency` (`"monthly"` for PAYGO, `"not-applicable"` for free zones), `price` (per-period $), `intent` (`"FREE"` / `"PAYGO"`), `created_date`, `cancel_at_period_end`, `trial`, `handler` (`"stripe"`), `product.{name, period, billing, public_name, duration}`, `component_values[]` (per-feature usage / enum / sum values), `zone.{id, name}` (when scope=zone), `rate_plan.{public_name, currency, externally_managed, sets, is_contract}`.
- **`current_period_start`/`end` present only on account-scoped PAYGO subs** (e.g. `workers_paid`, `r2_paid`), absent on free-zone subs. cf-monitor's `getBillingPeriod()` already iterates and picks the first account-scoped sub with both fields — correct behaviour confirmed.
- **Plan IDs observed**: `free` (14× zone-scoped), `workers_paid` (1× account-scoped, $5 monthly), `r2_paid` (1× account-scoped, $0 base — PAYGO usage billing).

## Architecture recommendation — resolved against the 2026-05-28 probe payload

### Decision A — should cf-monitor ingest `/billing/usage`?  **NO — branch C fires.**

**Resolved: do not wire `/billing/usage` into production.** The endpoint is a generic time-series metric query (caller supplies `metrics`/`dimensions`/`since`/`until`/`time_delta`); it returns time-bucketed metric values with **no per-product breakdown and no `$-cost` field**. The default metric is `streamMinutesViewed`, which strongly suggests this is the Stream analytics endpoint (or a misnomered generic one). cf-monitor's existing GraphQL Analytics collectors already provide equivalent or richer per-product time-series data with the same approximate-not-authoritative caveat, so ingesting `/billing/usage` adds no signal cf-monitor doesn't already have. **No `/usage` confidence labels change.**

### Decision A′ — what about `/billing/history`?  **Conditional yes (smaller, follow-up).**

`/billing/history` IS billing-authoritative for past invoices. A future `collect-billing-history` cron could surface a "last N months actual spend" panel in the dashboard. This is a **separate, smaller opportunity** from the original `/billing/usage` hope. **Not in scope for this phase** — but tracked as a follow-up; if pursued, it must clear the same 4-test gate listed below (with one substitution: 404/permission-fallback test instead of the `/billing/usage`-specific tests).

### Decision A″ — `/billing/profile`?  **No.**

PII-heavy account contact info with no cost data. `account_type` / `country` are mildly interesting context but not worth a cron. Skip.

### Decision B — fallback when Billing Read is missing  (unchanged from Phase 2 plan)

cf-monitor must never depend on Billing Read. The `cf-monitor probe billing` diagnostic continues to work with or without it (returns `permission_denied` outcomes). No production code path reads `/billing/*`, so there is nothing to fall back from. If a future `/billing/history` ingestion ships, its 403-handling must:

- Log at `info` (expected operator choice, not failure).
- Set a `billing_history_unavailable: true` flag in whatever snapshot it populates.
- Surface in the dashboard as "no Billing Read token — historical invoices unavailable".

### Decision C — what stays  (unchanged; no replacement happens)

All current collectors remain authoritative for their domains:
- **Runtime budget enforcement** (`src/sdk/proxy.ts`, `src/worker/crons/budget-check.ts`) — the only true cost-stop mechanism.
- **GraphQL Analytics collectors** (`collect-account-usage.ts`, `collect-metrics.ts`) — near-real-time approximate signal.
- **AI Gateway logs collector** (`collect-ai-gateway-usage.ts`) — billing-authoritative for AI.
- **`/subscriptions` consumer** (`src/worker/account/subscriptions.ts`) — plan detection + billing-period anchor.

### Pre-conditions if `/billing/history` ingestion is later pursued

(Retained from Phase 2; tightened against what the snapshot showed.)

1. **Payload-shape unit test** over a fixture derived from `probes/billing-probe-2026-05-28.redacted.json`. Lock the row keys: `id, type, occurred_at, amount, amount_to_pay, currency, invoice_id, receipt_id, status, source` and the pagination block.
2. **Permission-fallback test** — mocked 403 must produce: `info` log + `billing_history_unavailable: true` + dashboard message; no other `/usage` field affected.
3. **Confidence-label correctness test** — any field sourced from `/billing/history` is labelled `billing_authoritative`; GraphQL-sourced fields retain `analytics_estimate`.
4. **Time-range param probe** — discover the actual `since`/`until` (or alternative) param names before writing the cron. The 2026-05-28 probe did not enumerate them.

## Open questions (post 2026-05-28 Billing Read probe)

### Resolved

- **Payload shape of `/billing/usage`** — **NOT a programmatic Billable Usage API.** Generic time-series metric query with no per-product breakdown and no $-cost. Decision: do not wire (Decision A above).
- **Granularity / freshness of `/billing/usage`** — caller-specified via `time_delta` (`day` / `hour` / `month`); `minute` is rejected as "doesn't exist".
- **Whether `/billing/history` returns invoices** — **Yes**, billing-authoritative invoice rows with $-amounts, currency, dates. Sufficient for a future "last N months actual spend" panel.
- **R2 `ListBucket` Class A vs Class B** — reclassified `unknown` in `src/worker/crons/r2-classification.ts` 2026-05-28 (warned, not counted). The Billing Read probe did NOT directly settle this (the invoice history in `/billing/history` is dollar amounts only — no per-operation breakdown). Final classification still awaits a per-operation invoice or a docs update from Cloudflare.

### Still open

- **`/billing/usage` metric vocabulary** — the server defaulted to `metrics: ["streamMinutesViewed"]`. The full list of accepted metric names (CF-product-billable metrics? all Analytics metrics?) is undocumented. If a follow-up does pursue this surface, enumerate the metric vocabulary by trying `metrics=requests` / `metrics=d1RowsRead` / `metrics=r2ClassAOperations` / etc. and recording 200 vs error responses.
- **`/billing/history` time-range parameters** — the bare path returned 7 most-recent invoices on `page=1`. The accepted `since`/`until`/`from`/`to`/`before` parameter names were not enumerated; needs follow-up probing if the cron is built.
- **Receipt-id format vs Stripe invoice id** — `receipt_id` (human-readable like `IN-64052317`) is account-scoped and not redacted by the value-pattern path (only by the key-name path). Consider whether to expose receipt ids in any future dashboard view.
