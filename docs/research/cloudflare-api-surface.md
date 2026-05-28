# Cloudflare API Surface — cf-monitor Research Reference

**Generated**: 2026-05-27
**Scope**: Every Cloudflare API/endpoint/GraphQL dataset/dashboard surface relevant to cf-monitor's mission (usage monitoring, cost estimation, billing visibility, budgeting, anomaly detection, resource discovery, circuit-breaker behaviour).
**Status**: Research-only. No code changes outside `docs/research/`.

> **Source primacy**: Every endpoint table cites the canonical Cloudflare developer-docs page. Blog/changelog entries are flagged when used. Where this document and cf-monitor's existing code diverge, the docs (and live API behaviour) win — open a follow-up issue and update code, not this file.

> **Live probe corrections (2026-05-27)** — folded into the tables below from [`cloudflare-api-probe-results.md`](./cloudflare-api-probe-results.md):
> 1. **Queue GraphQL datasets are singular** — `queueBacklogAdaptiveGroups`, `queueMessageOperationsAdaptiveGroups`, `queueConsumerMetricsAdaptiveGroups`. The plural `queuesBacklogAdaptiveGroups` is a 400 "unknown field".
> 2. **R2 `actionType` values are S3-style names** (`GetObject`, `PutObject`, `ListBucket`, …), not `read`/`write`. Classified in `src/worker/crons/r2-classification.ts` (Class A / Class B / free / `unknown`). **`ListBucket` reclassified `unknown` 2026-05-28** (warned, not counted) — CF docs may class the equivalent `ListObjects` as Class A; final classification awaits a Billing Read invoice.
> 3. **Billing endpoints verified (2026-05-28 Billing Read probe)** — `/billing/profile` returns PII-heavy account contact info (no cost data); `/billing/history` returns billing-authoritative past-invoice rows (possible future ingestion); `/billing/usage?time_delta=day` is **NOT** the long-hoped Billable Usage API — it's a generic time-series metric query with no per-product breakdown and no $-cost. **Decision: do not wire `/billing/usage` or `/billing/profile`.** Full payload analysis in [`billing-endpoints-follow-up.md`](./billing-endpoints-follow-up.md).
> 8. **Tier 2 collectors live (2026-05-28)** — `/usage` now carries a per-section `confidence` map (vocabulary defined in [`billing-endpoints-follow-up.md`](./billing-endpoints-follow-up.md)) plus three new optional sections: `queues_realtime` (hourly REST backlog, `runtime_metered`), `pages` (daily REST list, `runtime_metered`, every project marked `functions_usage: 'unknown'` per the static-vs-Functions billing distinction), `vectorize_indexes` (daily REST list, metadata only — per-index vector counts not collected, documented caveat). Existing `/usage` fields are byte-identical (backward-compat invariant locked in by `tests/worker/fetch-handler.test.ts`).
> 9. **Budget Alert opt-in shipped (2026-05-28, Phase 5)** — `cf-monitor init --register-budget-alert <threshold>` subscribes a notification policy to `billing_budget_alert` with email (auto-discovered from `/billing/profile`) or webhook recipient. **The $-threshold itself is NOT settable via the Notifications API** — it must be configured in the CF dashboard. The CLI prints a clear dashboard-step instruction; `/usage` surfaces the subscription with `confidence.budget_alert: 'alert_only'`. New read-only diagnostic `cf-monitor probe alerting` lists existing alerting policies + webhook destinations. See [`budget-alert-registration-todo.md`](./budget-alert-registration-todo.md) for the full implementation map.
> 10. **Protection Coverage report shipped (2026-05-28, Phase 7)** — `GET /protection` (and `npx cf-monitor protection`) turns the existing KV snapshots + worker discovery + SDK heartbeat data into an audit report classifying each surface as `protected` / `partially_protected` / `unprotected` / `unknown` / `not_applicable` with a heuristic 0–100 score. **Audit-only** — no Cloudflare mutations. Ten finding categories cover billing reality, Budget Alert subscription, queue storms, Pages ambiguity, Vectorize visibility, R2 ListBucket, runtime SDK coverage, AI Gateway native controls, Worker CPU limits, and safe-mode emergency controls. Tier-3 destructive controls explicitly deferred. See [`../protection-coverage.md`](../protection-coverage.md).
> 4. **Notification alert types confirmed** — `billing_budget_alert`, `billing_usage_alert`.
> 5. **`Query.cost` / `viewer.budget` are GraphQL rate-limit counters**, not account billing/budget.
> 6. **Audit Logs v2** (`/logs/audit`) requires both `since` and `before`; v1 (`/audit_logs`) still works.
> 7. **R2 `event-notification` path 404s** — open question.

---

## 1. Executive summary

Cloudflare exposes a **fragmented surface** for usage/cost monitoring. There is no single billing-authoritative API for indie developers. Production cf-monitor must combine:

1. **`/accounts/{id}/subscriptions`** — the one reliable signal for plan detection (Free vs Paid, billing period start).
2. **GraphQL Analytics API** — broad per-product usage metrics, but Cloudflare **explicitly states these datasets are not billing-authoritative**.
3. **Product-specific REST endpoints** (AI Gateway logs, Queues realtime metrics, Vectorize, Pages REST) — needed because not every product has GraphQL Analytics coverage.
4. **Static plan-allowance catalogue** — Cloudflare does not expose included-allowance numbers via API; cf-monitor must maintain its own versioned table.
5. **Dashboard-only surfaces** — Billable Usage dashboard (Apr 2026) and the underlying invoice-grade data are not currently available via public API.
6. **Native cost-stop controls are sparse** — Free-plan products auto-error at daily caps (true hard limits); on Paid plans, only AI Gateway rate-limiting and Dynamic Routes Budget Limit nodes provide native enforcement. Everything else requires cf-monitor runtime guards or destructive route/worker mutation.

The architectural implication: cf-monitor is the **enforcement layer Cloudflare doesn't ship**. Cloudflare gives observability and alerts; cf-monitor must provide the hard pre-execution budget check that prevents the bill spike.

---

## 2. Key conclusions

1. **Billing-authoritative cost data is not available via public API.** The Billable Usage dashboard (`Manage Account > Billing > Billable Usage`) shows daily usage that matches the invoice, but it is dashboard-only. Budget Alerts emit email when projected spend crosses a threshold; they do not enforce.
2. **GraphQL Analytics is the broadest usage surface, but is documented as approximate.** From [GraphQL Analytics API docs](https://developers.cloudflare.com/analytics/graphql-api/): *"These datasets should not be used as a measure for usage that Cloudflare uses for billing purposes."* cf-monitor must label all GraphQL-derived figures `analytics_estimate`, not `billing_authoritative`.
3. **Plan detection has one canonical path.** `GET /accounts/{id}/subscriptions` → look for `rate_plan.id === 'workers_paid'`. Falls back to "Paid (assumed)" when the token lacks `Billing Read`. cf-monitor already does this correctly.
4. **The Standard usage model has been the default since 2023-10-30.** Legacy Bundled/Unbound models still exist for old accounts and can be set per-script via dashboard. Once an account is opted into Standard, the wrangler `usage_model` value is ignored.
5. **Free plan products self-throttle.** D1, KV, Workers AI, Hyperdrive, and Workers itself return errors when daily Free-plan limits are reached. This is a **native hard control** on Free, and a true cost cap. Once on Paid, all of these become unlimited-overage and require cf-monitor runtime guards.
6. **AI Gateway is the only product with a native budget circuit breaker (and only via Dynamic Routes).** The Budget Limit node in a Dynamic Route enforces a cost quota per period and switches to a fallback when exceeded. Account-wide AI Gateway spend caps do not exist as a setting.
7. **Resource Tagging entered public beta on 2026-04-27.** API-first, Account-Owned-Token authentication, covers Workers, D1, R2, KV, DO namespaces, Queues, Stream, Images, AI Gateway, Access apps, Gateway rules, custom hostnames, tunnels, zones. cf-monitor should treat tagging as a discovery/grouping mechanism, not a control surface.
8. **Notifications API can fire arbitrary webhooks for budget alerts.** This is alert-only; cf-monitor can subscribe but Cloudflare will not stop a workload on its own.
9. **Several products have no GraphQL Analytics dataset.** AI Gateway, Vectorize, Queues message ops (have REST + GraphQL combo), Hyperdrive, Workflows, Cache Reserve. These need product-specific REST polls or are dashboard-only.
10. **Account-wide hard spend caps do not exist.** There is no Cloudflare equivalent of AWS Budgets *enforce* mode. Budget Alerts are notifications. cf-monitor cannot install one and must surface this explicitly to users.

---

## 3. What Cloudflare can and cannot provide

### ✓ Cloudflare provides
- **Plan/subscription state** (Free vs Paid, billing period, rate plan).
- **Aggregate per-product usage** via GraphQL (Workers, D1, KV, R2, DO, Queues, Pages Functions, Stream, WAF, HTTP, LB, Email, Page Shield, Calls TURN, NEL, Magic FW, Pipelines).
- **Realtime metrics for some products** (Queues backlog REST endpoint; AI Gateway logs REST).
- **Notification + webhook system** for budget thresholds, security events, deploy events.
- **Resource discovery** via per-product list endpoints (Workers scripts, D1 databases, R2 buckets, KV namespaces, Queues, DO namespaces, Vectorize indexes, AI Gateways) and unified via Resource Tagging filter queries.
- **Native daily hard caps on Free-plan products** (auto-error when exceeded — true cost stop).
- **AI Gateway: rate limiting, caching, Dynamic Routes (with Rate Limit + Budget Limit nodes), BYOK secret storage, request logs with cost data.**
- **Workers/Pages: per-script CPU + subrequest limits (configurable via wrangler/script settings).**
- **WAF/Rulesets: account-level + zone-level rules for emergency traffic blocking and rate limiting.**
- **Cron triggers, routes, custom domains, script settings — all mutable via REST.**

### ✗ Cloudflare does NOT provide (today)
- **Public API for the Billable Usage dashboard or invoice-grade per-product cost.** Dashboard-only.
- **An "account-wide spend cap"** that stops billable usage when crossed. Budget Alerts are email-only.
- **Per-feature spend caps from a config file** (cf-monitor's `budgets.yaml` model has no Cloudflare equivalent).
- **Plan-included-allowance values via API** (you must maintain a static catalogue keyed by plan).
- **GraphQL datasets for AI Gateway, Vectorize, Hyperdrive, Workflows, Cache Reserve.**
- **A `disable script` toggle** distinct from "delete script" (you can detach routes, deploy a no-op safe-mode worker, or kill cron triggers — but no global pause flag).
- **A queryable invoice / FOCUS-style FinOps export.** Enterprise sales-channel only.
- **CPU-time / subrequest billing on a per-route basis** — only per-script.

---

## 4. Billing and cost APIs

| Service | Surface | Endpoint | Method | Scope | Status | Approval? | Required perms | Data exposed | Freshness/retention | Billing-authoritative? | Can enforce limits? | cf-monitor use | Caveats | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Subscriptions | REST | `/accounts/{id}/subscriptions` | GET | account | GA | No | `Billing Read` | rate_plan.id, public_name, scope; current_period_start/end; component_values | Real-time | Yes (plan state) | No | Plan detection; billing-period anchor | Returns 403 on missing perm — cf-monitor falls back to "paid" assumption | [Billing permissions](https://developers.cloudflare.com/billing/understand/billing-permissions/) |
| Billing profile | REST | `/accounts/{id}/billing/profile` | GET | account | Exists (undocumented; verified 2026-05-28) | No | `Billing Read` | `{id, first_name, last_name, billing_email, company, address, city, state, zipcode, country, account_type}` — PII-heavy account contact info, **no cost data** | Real-time | n/a | No | **Not wired** — no cost relevance; `account_type` / `country` are marginal context | See `billing-endpoints-follow-up.md` Decision A″ | (no public source) |
| Billing history | REST | `/accounts/{id}/billing/history` | GET | account | Exists (undocumented; verified 2026-05-28) | No | `Billing Read` | Paginated invoice rows: `{id, type, occurred_at, amount, amount_to_pay, currency, invoice_id, receipt_id, status, source}` + `result_info` | Real-time (past invoices) | **Yes (past invoices)** | No | **Possible future ingestion** for "last N months actual spend" panel — gated on 4-test pre-condition list | Time-range params (since/until/from/to) not enumerated in 2026-05-28 probe | (no public source) |
| Billing usage | REST | `/accounts/{id}/billing/usage?time_delta=day` | GET | account | Exists (undocumented; verified 2026-05-28) | No | `Billing Read` | Generic time-series metric query — returns `{rows, data[{metrics}], time_intervals, query{dimensions, metrics, since, until, time_delta, limit}}`. Default `metrics: ["streamMinutesViewed"]`. **No per-product breakdown, no $-cost field.** Bare path 400s ("time delta \"minute\" doesn't exist"); `?time_delta=day` is the minimum accepted bucket | Caller-bucketed | **No** | No | **Not wired** — NOT the long-hoped Billable Usage API; redundant with GraphQL Analytics. Decision A → branch C | Full metric vocabulary still unknown | (no public source) |
| Billable Usage dashboard | Dashboard | `dash.cloudflare.com/<acct>/billing/billable-usage` | (UI) | account | GA (Apr 2026) | No | dashboard login | Daily usage cost per product, sortable table, billing-cycle aligned | Daily | Yes (matches invoice) | No | Document gap; recommend users check manually | Pay-as-you-go only; Enterprise contract accounts not supported | [Changelog 2026-04-13](https://developers.cloudflare.com/changelog/post/2026-04-13-billable-usage-dashboard-and-budget-alerts/) |
| Budget Alerts | Notifications API + dashboard | `Notifications > Add > Budget Alert` (UI); `/accounts/{id}/alerting/v3/policies` (API) | POST (policy) / GET | account | GA (Apr 2026) | No | `Notifications Write` (to create) / `Notifications Read` | Threshold ($), fires email when projected monthly spend crosses threshold; dedup automatic | Daily evaluation | No (notifies invoice projection) | No (alert-only) | cf-monitor can create budget-alert policies on user's behalf if user opts in | Pay-as-you-go only; fires once per billing cycle per threshold crossing; can't enforce | [Changelog 2026-04-13](https://developers.cloudflare.com/changelog/post/2026-04-13-billable-usage-dashboard-and-budget-alerts/); [Notifications webhook schema](https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/) |
| Usage-based billing notifications (D1) | Notifications | as above; alert types `d1.rows_read`, `d1.rows_written` | POST (policy) | account | GA | No | `Notifications Write` | Daily usage check vs threshold | Daily | No | No (alert-only) | Subscribe for D1 cost spike signal | Currently only D1 metrics surfaced as a usage-billing alert type per [D1 observability/billing](https://developers.cloudflare.com/d1/observability/billing/) | [D1 billing](https://developers.cloudflare.com/d1/observability/billing/) |
| Generic webhook destination | Notifications | `Notifications > Destinations > Webhooks` | POST | account | GA | No | `Notifications Write` | Receives `cf-webhook-auth` header for shared-secret verification | Real-time on alert | n/a | No | cf-monitor can register as destination for budget alerts | Only public IP on 80/443; if you need private routing use a Worker shim or Tunnel | [Configure webhooks](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/) |
| Invoice API / FOCUS export | — | Not publicly documented | — | account | Not available to PAYG | n/a | n/a | n/a | n/a | n/a | n/a | Mark "unknown — not available" | Enterprise sales-channel only | (no public source) |
| PayGo Usage API v1/v2 | — | Not publicly documented | — | — | Not advertised | n/a | n/a | n/a | n/a | n/a | n/a | Mark "does not exist as public API" | Term appears in some legacy material — no public endpoint found as of 2026-05-27 | (no public source) |

**cf-monitor implication**: invoice-grade cost data is not available programmatically. The closest cf-monitor can get is (a) plan + billing-period from `/subscriptions`, (b) per-product usage from GraphQL (labelled approximate), (c) cost *estimation* by multiplying usage × cf-monitor's static pricing catalogue. Surface this confidence gap explicitly in `/usage`.

---

## 5. Workers plan and allowance detection

### Plan detection

| Plan type | Detection signal | Source |
|---|---|---|
| Workers Free | `subscriptions` array empty OR no `rate_plan.id === 'workers_paid'` entry | [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers Paid ($5/mo min) | `rate_plan.id === 'workers_paid'` from subscriptions endpoint | [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers Enterprise | Custom — usage model specified in contract; sometimes still on Bundled/Unbound | [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers Standard (usage model) | Default for new Paid accounts since 2023-10-30; per-script setting honoured only on accounts not yet opted into account-wide Standard | [changelog 2023-10-30](https://developers.cloudflare.com/workers/platform/changelog/) |
| Workers Bundled / Unbound (legacy) | Set per-script in dashboard; `usage_model` in wrangler is ignored after account-wide Standard opt-in | [changelog 2023-10-30](https://developers.cloudflare.com/workers/platform/changelog/) |

### What `subscriptions` actually exposes

```
GET /accounts/{account_id}/subscriptions
Authorization: Bearer <token>   # needs Billing Read

[
  {
    "id": "...",
    "rate_plan": {"id": "workers_paid", "public_name": "...", "scope": "..."},
    "current_period_start": "...",
    "current_period_end": "...",
    "component_values": [...]
  }
]
```

### What CF does NOT expose

- **Included-allowance numbers per product per plan**. Allowances must be maintained from the [Workers pricing page](https://developers.cloudflare.com/workers/platform/pricing/) and product-specific pricing pages. cf-monitor's `src/worker/account/plan-allowances.ts` is therefore a required, manually-versioned artefact.
- **Remaining included usage** for the current billing period. cf-monitor derives this from `(allowance − rolled-up monthly usage)`, which is an estimate.
- **Per-Worker usage model on Standard-opted accounts** — wrangler `usage_model` is ignored; the dashboard is the source of truth.

### Confidence levels for plan detection

| Source | Confidence |
|---|---|
| `subscriptions` with `Billing Read` permission and clear `workers_paid` entry | High |
| `subscriptions` returns 200 + empty array | High (Free) |
| Token lacks `Billing Read` (403) | Low — default to "Paid (assumed)" for cost safety; surface to user |
| `subscriptions` returns 5xx | Low — retry with backoff; fail-safe to "Paid (assumed)" |

cf-monitor **must not silently assume Free** — assuming Free means lower default budgets, which on a Paid account leads to premature CB trips. cf-monitor's current behaviour (conservative "paid" fallback) is correct.

---

## 6. GraphQL Analytics API

### Endpoint

```
POST https://api.cloudflare.com/client/v4/graphql
Authorization: Bearer <token>   # needs Analytics Read (or Account Analytics for account-scope datasets)
Content-Type: application/json
```

### Authentication & scope

- **Account-scope datasets**: filter `viewer.accounts(filter: { accountTag: $accountId })`. Token needs `Account Analytics` or product-specific `*:Read` (e.g. `Workers KV Storage Read`).
- **Zone-scope datasets**: filter `viewer.zones(filter: { zoneTag: $zoneId })`. Token needs `Analytics Read` on the zone.
- **Introspection is supported** — query the schema for current dataset names, dimensions, metrics, retention.
- **`Query.cost` / `viewer.budget` are rate-limit counters, NOT billing** (probe 2026-05-27). The top-level `cost` field is the GraphQL query rate-limit cost (points consumed); `viewer.budget` is the remaining GraphQL rate-limit budget. Both are `uint64`. They do **not** expose account spend. Optional future use: log `cost` to monitor cf-monitor's own GraphQL rate-limit consumption (deferred — not implemented this pass).

### Stability caveats

- **70+ datasets** documented as a dynamic schema; Cloudflare "constantly expands the list and replaces existing ones with more capable alternatives" ([introspection docs](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/introspection/)).
- **Datasets have been removed/renamed in production** — cf-monitor has already had to patch around `cpuTime` being dropped from `workersInvocationsAdaptive.sum` (now must estimate via `quantiles.cpuTimeP50 * requests`) and `d1AnalyticsAdaptiveGroups` requiring `date_geq` not `datetime_geq`.
- **NOT billing-authoritative**: Cloudflare explicitly states *"these datasets should not be used as a measure for usage that Cloudflare uses for billing purposes. Billable traffic excludes things like DDoS traffic, while GraphQL is a measure of overall consumption/usage, so it will include all measurable traffic."* ([GraphQL Analytics API docs](https://developers.cloudflare.com/analytics/graphql-api/)).

### Datasets relevant to cf-monitor

| Product | Scope | Dataset(s) | Notes / billing-authoritative? | Source |
|---|---|---|---|---|
| Workers (account) | account | `workersInvocationsAdaptive`, `workersInvocationsScheduled`, `workersSubrequestsAdaptiveGroups`, `workersOverviewRequestsAdaptiveGroups`, `workersOverviewDataAdaptiveGroups`, `workerPlacementAdaptiveGroups`, `workersAnalyticsEngineAdaptiveGroups` | Not billing-authoritative. `cpuTime` removed from `sum`; use `quantiles.cpuTimeP50 * requests` as estimate (cf-monitor #93) | [Querying Workers metrics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/); [CMB dataset list](https://developers.cloudflare.com/data-localization/metadata-boundary/graphql-datasets/) |
| Workers (zone) | zone | `workersZoneInvocationsAdaptiveGroups`, `workersZoneSubrequestsAdaptiveGroups` | US-only data residency | [CMB dataset list](https://developers.cloudflare.com/data-localization/metadata-boundary/graphql-datasets/) |
| Pages Functions | account | `pagesFunctionsInvocationsAdaptiveGroups` | US-only data residency. Pages Functions are billed as Workers | [Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/) |
| D1 | account | `d1AnalyticsAdaptiveGroups` (sum: rowsRead, rowsWritten, readQueries, writeQueries), `d1QueriesAdaptiveGroups` (per-query insights) | Not billing-authoritative. Requires `date_geq`/`date_leq` not `datetime_*`. `wrangler d1 insights` is experimental CLI | [D1 metrics/analytics](https://developers.cloudflare.com/d1/observability/metrics-analytics/) |
| KV | account | `kvOperationsAdaptiveGroups` (dim: actionType), `kvStorageAdaptiveGroups` | Not billing-authoritative. UUID format: hyphens kill `kvOperationsAdaptiveGroups` results (cf-monitor #45) | [KV metrics/analytics](https://developers.cloudflare.com/kv/observability/metrics-analytics/) |
| R2 | account | `r2OperationsAdaptiveGroups` (dim: actionType, bucketName), `r2StorageAdaptiveGroups` | Not billing-authoritative. `actionType` returns **S3-style names** (`GetObject`, `HeadObject`, `PutObject`, `ListBucket`, …) — NOT lowercase `read`/`write` (probe 2026-05-27). Class B: `GetObject`/`HeadObject`; free: `DeleteObject`/`DeleteBucket`/`AbortMultipartUpload`; Class A: writes/mutations/`ListBuckets`/`PutBucket*`; `ListBucket` (singular) is **`unknown`** as of 2026-05-28 — Class A vs B unresolved until a per-operation invoice settles it; unrecognised → `unknown` (surfaced, never silently billed). See `src/worker/crons/r2-classification.ts` | [R2 metrics/analytics](https://developers.cloudflare.com/r2/platform/metrics-analytics/) |
| Queues | account | `queueBacklogAdaptiveGroups` (avg: bytes, messages), `queueConsumerMetricsAdaptiveGroups` (avg: concurrency), `queueMessageOperationsAdaptiveGroups` (dim: actionType, consumerType, outcome) — names are **singular** `queue*` (the plural `queuesBacklogAdaptiveGroups` is a 400 "unknown field"; probe 2026-05-27) | Not billing-authoritative for billable ops counting (use REST realtime endpoint for cost-critical decisions) | [Queues metrics](https://developers.cloudflare.com/queues/observability/metrics/) |
| Durable Objects | account | `durableObjectsInvocationsAdaptiveGroups`, `durableObjectsPeriodicGroups`, `durableObjectsStorageGroups`, `durableObjectsSubrequestsAdaptiveGroups` | US-only data residency. WebSocket 20:1 billing ratio NOT applied in analytics (analytics shows real msgs) | [DO release notes](https://developers.cloudflare.com/durable-objects/release-notes/); [CMB dataset list](https://developers.cloudflare.com/data-localization/metadata-boundary/graphql-datasets/) |
| Stream | account | `streamMinutesViewedAdaptiveGroups`, `videoPlaybackEventsAdaptiveGroups`, `videoBufferEventsAdaptiveGroups`, `videoQualityEventsAdaptiveGroups` | 90-day retention; 31-day max query interval. US-only data residency | [Stream GraphQL Analytics](https://developers.cloudflare.com/stream/getting-analytics/fetching-bulk-analytics/) |
| Email Routing | account | `emailRoutingAdaptive`, `emailRoutingAdaptiveGroups` | US + EU data residency | [CMB dataset list](https://developers.cloudflare.com/data-localization/metadata-boundary/graphql-datasets/) |
| Email Service (sending) | zone | `emailSendingAdaptive`, `emailSendingAdaptiveGroups` | Needs `Analytics Read` permission | [Email Service metrics](https://developers.cloudflare.com/email-service/observability/metrics-analytics/) |
| WAF / Security Events | zone | `firewallEventsAdaptive` | Free/Pro 24h; Business 3d; Enterprise 30d retention | [WAF security analytics](https://developers.cloudflare.com/waf/analytics/security-analytics/) |
| HTTP / Security Analytics | zone | `httpRequestsAdaptive` (Security Analytics) | Free/Pro 7d; Business 31d; Enterprise 90d retention | [WAF security analytics](https://developers.cloudflare.com/waf/analytics/security-analytics/) |
| Load Balancing | zone | `loadBalancingRequestsAdaptive` | Pool health, RTT, request volume | [LB analytics](https://developers.cloudflare.com/load-balancing/reference/load-balancing-analytics/) |
| Page Shield | zone | `pageShieldReportsAdaptiveGroups` | 30-day retention | [Page Shield violations](https://developers.cloudflare.com/client-side-security/rules/violations/) |
| Realtime TURN | account | `callsTurnUsageAdaptiveGroups` | introspect for fields | [Realtime TURN analytics](https://developers.cloudflare.com/realtime/turn/analytics/) |
| Pipelines | account | `pipelinesUserErrorsAdaptiveGroups` | Dropped events / deserialisation errors | [Pipelines metrics](https://developers.cloudflare.com/pipelines/observability/metrics/) |
| NEL (Network Error Logging) | zone | `nelReportsAdaptiveGroups` | US-only data residency | [CMB dataset list](https://developers.cloudflare.com/data-localization/metadata-boundary/graphql-datasets/) |
| Magic Firewall | account | `magicFirewallSamplesAdaptiveGroups`, `magicFirewallNetworkAnalyticsAdaptiveGroups` | Network firewall samples | [CMB dataset list](https://developers.cloudflare.com/data-localization/metadata-boundary/graphql-datasets/) |
| AI Gateway | — | **No GraphQL dataset** | Use REST logs endpoint | [cf-monitor #57 caveat](../../src/worker/crons/collect-account-usage.ts) |
| Vectorize | — | **No GraphQL dataset** | Dashboard-only metrics; REST `query` endpoint exists for index ops | [Vectorize changelog](https://developers.cloudflare.com/vectorize/platform/changelog/) |
| Hyperdrive | — | **No GraphQL dataset** | Dashboard-only metrics | [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) |
| Workflows | — | **No GraphQL dataset** | Workflows are billed as Workers; underlying script metrics visible via Workers datasets | [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) |
| Cache Reserve | — | **No dedicated dataset** | Cache writes metered when enabled; use HTTP `httpRequestsAdaptive` for cache_status dimension | [How charges accrue](https://developers.cloudflare.com/billing/understand/how-charges-accrue/) |

**Important**: dataset names and field structures change. cf-monitor must keep its GraphQL queries minimal (request only fields it consumes), wrap each per-service query in its own try-catch (one bad field has historically broken the entire batched query — cf-monitor #59), and rely on introspection during development to verify field names before deploy.

---

## 7. Product-specific monitoring and controls

### 7.1 Workers

| Surface | Endpoint | Method | Scope | Perms | Status | cf-monitor use | Caveats | Source |
|---|---|---|---|---|---|---|---|---|
| Script discovery | `/accounts/{id}/workers/scripts` | GET | account | `Workers Scripts Read` | GA | Discovery of consumer workers | Returns id, modified_on; doesn't include routes/triggers | [API ref](https://developers.cloudflare.com/api/) |
| Script settings | `/accounts/{id}/workers/scripts/{name}/settings` | GET / PATCH | account | `Workers Scripts Edit` | GA | Inspect/mutate per-script limits (cpu_ms, subrequests) | wrangler `limits` is the same as the script settings | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Routes | `/zones/{zone}/workers/routes` | GET / POST / DELETE | zone | `Workers Routes Read/Write` | GA | Emergency: detach a route to stop traffic to a runaway worker | Returns pattern + script; circuit-breaker action | [Workers Routes API](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/create/) (link from changelog 2025-04-15) |
| Cron triggers | `/accounts/{id}/workers/scripts/{name}/schedules` | GET / PUT | account | `Workers Scripts Edit` | GA | Disable cron on runaway scheduled handler | Propagation up to 15 min | [Cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) |
| Tail consumers | `/accounts/{id}/workers/scripts/{name}/tail-consumers` (via script settings) | GET / PUT | account | `Workers Tail Read` (read) / `Workers Scripts Edit` (write) | GA | Verify tail wiring (cf-monitor itself uses this) | — | [Workers Trace Events Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/) |
| Deploy a no-op safe-mode worker | `/accounts/{id}/workers/scripts/{name}` | PUT | account | `Workers Scripts Edit` | GA | Emergency: overwrite a runaway worker with a 503 stub | Destructive — cannot be undone without redeploying | [API ref](https://developers.cloudflare.com/api/) |
| Workers AI binding | `/accounts/{id}/ai/run/@cf/{model}` (legacy), `/accounts/{id}/ai/v1/chat/completions` (Unified, May 2026) | POST | account | `Workers AI Read/Edit` | GA | Workers AI inference; not normally proxied by cf-monitor | New Unified AI REST API (May 2026) routes through default gateway | [AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) |
| Workers Logs | `/accounts/{id}/workers/observability/...` | (see Observability MCP) | account | `Workers Observability Read` | GA | Inspect logs for diagnostic | 7d retention; 5B/day account cap; 256KB per log | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| Workers metrics dataset | GraphQL `workersInvocationsAdaptive` | POST | account | `Account Analytics` | GA | Hourly usage collection (already in cf-monitor) | cpuTime estimate via P50; subrequests separate dataset | [Querying Workers metrics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/) |

**Native controls available on Workers:**
- **Per-script CPU limit** (`limits.cpu_ms` in wrangler) — per-invocation rate limit, default 30s, max higher on Paid (300s for Workflows/Queues consumers).
- **Subrequest limit** (50 on Free, 1000 on Paid) — per-invocation.
- **Cron trigger schedule** — disable to stop scheduled execution.
- **Route detach / safe-mode deploy** — emergency circuit-breaker (causes outage).
- **Workers for Platforms Custom Limits** (only in dispatch Worker context) — per-customer enforcement.

### 7.2 Pages / Pages Functions

- All Pages Functions are **billed as Workers** ([Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/)).
- REST API: `/accounts/{id}/pages/projects` (CRUD), `/accounts/{id}/pages/projects/{name}/deployments` (CRUD). Auth: `Pages Read/Edit` (separate from Workers permissions).
- GraphQL: `pagesFunctionsInvocationsAdaptiveGroups`. US-only data residency.
- Controls: no native cost cap; emergency action is to roll back deployment or delete the project.
- Static asset requests are **free and unlimited** on both Free and Paid plans.

### 7.3 D1

| Aspect | Detail | Source |
|---|---|---|
| Datasets | `d1AnalyticsAdaptiveGroups`, `d1QueriesAdaptiveGroups` (insights) | [D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/) |
| REST | `/accounts/{id}/d1/database` (list/create/delete), `/accounts/{id}/d1/database/{id}/query` (execute SQL) | [API ref](https://developers.cloudflare.com/api/) |
| Permissions | `D1 Read`, `D1 Write` (account-level) | [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) |
| Native hard cap | **Yes on Free plan**: D1 API returns errors when daily reads (5M) or writes (100K) are exceeded ([D1 FAQ](https://developers.cloudflare.com/d1/reference/faq/)). On Paid: monthly included tier then overage charges, no hard cap. | [D1 FAQ](https://developers.cloudflare.com/d1/reference/faq/) |
| Best cf-monitor guard | Runtime D1 binding proxy (already implemented) with `requestLimits.d1Reads`/`d1Writes` — only line of defence on Paid plan | — |
| Caveat | `date_geq`/`date_leq` required (not `datetime_geq`) — cf-monitor #58 | — |

### 7.4 R2

| Aspect | Detail | Source |
|---|---|---|
| Datasets | `r2OperationsAdaptiveGroups`, `r2StorageAdaptiveGroups`. `actionType` returns **S3-style operation names** (`GetObject`, `HeadObject`, `PutObject`, `ListBucket`, …), not `read`/`write` (probe 2026-05-27). Classified in `src/worker/crons/r2-classification.ts` → Class A / Class B / free / `unknown` | [R2 metrics](https://developers.cloudflare.com/r2/platform/metrics-analytics/) |
| Operation classification | Class B: `GetObject`, `HeadObject`. Free (non-billable): `DeleteObject`, `DeleteBucket`, `AbortMultipartUpload`. Class A: `PutObject`, `CopyObject`, multipart ops, `ListBuckets`, `PutBucket*`. Anything unrecognised → `unknown` (logged, never silently counted as Class A). **`ListBucket` (singular) is `unknown` as of 2026-05-28** — reclassified from Class B because CF pricing docs may class the equivalent `ListObjects` as Class A; final classification awaits a Billing Read invoice (see `billing-endpoints-follow-up.md`). | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Storage classes | Standard ($0.015/GB-mo) vs Infrequent Access ($0.01/GB-mo + $0.01/GB retrieval + 30d min storage). **No Free-tier discount on IA.** Egress is always free. | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| REST | `/accounts/{id}/r2/buckets`, `/accounts/{id}/r2/buckets/{name}/lifecycle`/`/lock`/`/sippy` (all 200 ✓, probe 2026-05-27) | [API ref](https://developers.cloudflare.com/api/) |
| REST (event notifications) | `GET /accounts/{id}/r2/buckets/{name}/event-notification` → **404 "No route matches this url"** (probe 2026-05-27). Terraform `r2_bucket_event_notification` implies an API exists, but this path is wrong — **open question** | [API ref](https://developers.cloudflare.com/api/) |
| Permissions | `Workers R2 Storage Read`, `Workers R2 Storage Edit` | [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) |
| Native hard cap | **None on Paid plan**. Free plan has monthly caps (10GB, 1M Class A, 10M Class B) — exceeding does not error (charges apply if IA storage used, but Free Standard storage simply pauses billable ops). | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| cf-monitor guard | Runtime R2 binding proxy with classA/classB limits per invocation | — |
| Lifecycle rules | Mutable via API — can transition objects to IA after N days but **cannot transition back** to Standard | [R2 storage classes](https://developers.cloudflare.com/r2/buckets/storage-classes/) |

### 7.5 KV

| Aspect | Detail | Source |
|---|---|---|
| Datasets | `kvOperationsAdaptiveGroups`, `kvStorageAdaptiveGroups` | [KV metrics](https://developers.cloudflare.com/kv/observability/metrics-analytics/) |
| REST | `/accounts/{id}/storage/kv/namespaces` (list/create), `/{ns}/keys` (list), `/{ns}/values/{key}` (CRUD) | [API ref](https://developers.cloudflare.com/api/) |
| Permissions | `Workers KV Storage Read`, `Workers KV Storage Edit` | [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) |
| Pricing (Paid) | Reads $0.50/M, Writes $5/M (10x reads), Deletes $5/M, Lists $5/M, Storage $0.50/GB-mo | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Native hard cap | **Yes on Free plan**: hard limits 100K reads/1K writes/1K deletes/1K lists per day, errors when exceeded. None on Paid. | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Caveat | KV namespace ID hyphenation: do NOT hyphenate UUID when querying `kvOperationsAdaptiveGroups` (cf-monitor #45) | — |
| Bulk reads | Billed per key, not per request | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |

### 7.6 Queues

| Aspect | Detail | Source |
|---|---|---|
| GraphQL datasets | `queueBacklogAdaptiveGroups`, `queueConsumerMetricsAdaptiveGroups`, `queueMessageOperationsAdaptiveGroups` | [Queues metrics](https://developers.cloudflare.com/queues/observability/metrics/) |
| Realtime backlog REST | `GET /accounts/{id}/queues/{queue_id}/metrics` → backlog_count, backlog_bytes, oldest_message_timestamp_ms | [Queues metrics](https://developers.cloudflare.com/queues/observability/metrics/) |
| REST CRUD | `/accounts/{id}/queues` (list/create/delete), `/accounts/{id}/queues/{id}/consumers` (consumer config) | [API ref](https://developers.cloudflare.com/api/) |
| Permissions | `Queues Read`, `Queues Edit` | [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) |
| Native controls | `max_concurrency` (1–250) on consumer; max_retries; DLQ on consumer; explicit `retry()`/`retryAll()` from handler. **No native dollar cap**. | [Consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/) |
| Native rate limiter | Consumer Worker CPU + subrequest limits (inherited from Workers); message retention period limit (auto-expire after) | [Queues limits](https://developers.cloudflare.com/queues/platform/limits/) |
| cf-monitor guard | Producer-side: runtime queue-send limit per invocation. Consumer-side: track per-batch producer behaviour via `withQueueBudget()`-style wrapper. | — |
| Purge | `/accounts/{id}/queues/{id}/purge` — emergency drain of backlog | [API ref](https://developers.cloudflare.com/api/) |

### 7.7 Durable Objects

| Aspect | Detail | Source |
|---|---|---|
| Datasets | `durableObjectsInvocationsAdaptiveGroups`, `durableObjectsPeriodicGroups`, `durableObjectsStorageGroups`, `durableObjectsSubrequestsAdaptiveGroups` | [DO observability](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/) |
| WebSocket billing | **20:1 ratio** applied to incoming WS messages for *billing* — analytics still shows real count. Outgoing WS messages and protocol pings are free. | [DO release notes 2024-04-01](https://developers.cloudflare.com/durable-objects/release-notes/) |
| Storage backends | SQLite-backed (recommended; Free + Paid; billing kicked in 2026-01-07) vs Key-Value-backed (Paid only; legacy) | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| SQLite storage pricing | Free: 5M rowsRead/day + 100K rowsWritten/day + 5GB total; Paid: 25B rowsRead/mo + 50M rowsWritten/mo + 5GB-mo included, then $0.001/M reads, $1/M writes, $0.20/GB-mo | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Compute pricing | Free: 100K req/day + 13,000 GB-s/day; Paid: 1M req/mo + 400,000 GB-s/mo included, then $0.15/M req, $12.50/M GB-s | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Native controls | Alarm API (can schedule self-wakeup); WebSocket Hibernation API (avoids duration charges); explicit `state.setWebSocketAutoResponse()` for free auto-replies | [DO concepts](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/) |
| cf-monitor guard | Runtime DO binding proxy with d1Writes/d1Reads (since SQLite backend = D1-like billing) — note that `setAlarm()` counts as 1 row written | — |

### 7.8 AI Gateway

| Aspect | Detail | Source |
|---|---|---|
| REST CRUD | `/accounts/{id}/ai-gateway/gateways` (list/create), `/accounts/{id}/ai-gateway/gateways/{id}` (get/update/delete), `/accounts/{id}/ai-gateway/gateways/{id}/logs` (list logs) | [AI Gateway create API](https://developers.cloudflare.com/api/resources/ai_gateway/methods/create/) (link from rate-limiting docs) |
| Unified AI REST API (May 2026) | `POST /ai/run`, `POST /ai/v1/chat/completions` (OpenAI compat), `POST /ai/v1/responses`, `POST /ai/v1/messages` (Anthropic compat) — routes through `default` gateway unless `cf-aig-gateway-id` header set | [Changelog 2026-05-21](https://developers.cloudflare.com/changelog/post/2026-05-21-rest-api/) |
| Permissions | `AI Gateway:Read`, `AI Gateway:Edit`; for Unified API also needs sufficient Cloudflare credits | [AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) |
| GraphQL | **No dataset** — use REST logs endpoint | — |
| Logs query | `?start_date=ISO&end_date=ISO&per_page=1000&page=N&order_by=created_at&order_by_direction=desc` — returns provider, model, cost, tokens_in, tokens_out, duration, cached, success, status_code per request | [cf-monitor's `collect-ai-gateway-usage.ts`](../../src/worker/crons/collect-ai-gateway-usage.ts) |
| Native rate limit | **Yes**: per-gateway `rate_limiting_limit`, `rate_limiting_interval`, `rate_limiting_technique` settable via API. Uniformly applied to all requests for that gateway. | [AI Gateway rate limiting](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/) |
| Native budget/cost cap | **Only via Dynamic Routes** — a "Budget Limit" node enforces a cost quota per period and switches to a fallback model when exceeded. No account-wide AI Gateway $-cap setting. | [Dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/) |
| BYOK | Provider keys stored in Cloudflare Secrets Store, referenced from gateway config — removes need for app-side key management | [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/) |
| Unified Billing | Third-party model calls (OpenAI/Anthropic/Google/xAI) charged via Cloudflare credits (load into account); avoids managing provider keys | [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) (referenced in changelog 2026-05-21) |
| Default gateway | `default` is auto-created on first call to Unified AI API (Mar 2026 feature) | [Changelog 2026-03-02](https://developers.cloudflare.com/changelog/post/2026-03-02-default-gateway/) |

### 7.9 Workers AI

| Aspect | Detail | Source |
|---|---|---|
| Billing unit | **Neurons** — $0.011 per 1,000 Neurons; per-model unit pricing (e.g. $0.026/M input tokens for distilbert) | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Free allocation | 10,000 Neurons/day on both Free and Paid; resets 00:00 UTC; **hard error when exceeded on Free** | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| REST | `POST /accounts/{id}/ai/run/@cf/{model}` (direct) or via AI Gateway routing | [AI REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) |
| Permissions | `Workers AI Read`, `Workers AI Edit` | [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) |
| Native controls | Daily Free-tier cap (hard error); per-request token limits per model | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Dashboard | `dash.cloudflare.com/<acct>/ai/workers-ai` shows neuron usage; no public API for neuron consumption beyond per-invocation responses | — |
| cf-monitor guard | Runtime AI binding proxy `aiRequests`/`aiNeurons`; pre-call check on requested model's neuron cost | — |

### 7.10 Vectorize

| Aspect | Detail | Source |
|---|---|---|
| Status | GA since 2024-09-26 | [Vectorize changelog](https://developers.cloudflare.com/vectorize/platform/changelog/) |
| REST | `/accounts/{id}/vectorize/indexes` (CRUD), `.../indexes/{name}/query`, `.../indexes/{name}/insert`, `.../indexes/{name}/get_by_ids`, `.../indexes/{name}/list_vectors` (Aug 2025+) | [Vectorize client API](https://developers.cloudflare.com/vectorize/reference/client-api/) |
| Permissions | `Vectorize:Read`, `Vectorize:Edit` (token permission names per token templates) | [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) |
| GraphQL | **No dataset** | — |
| Billing units | Queried vector dimensions + Stored vector dimensions. Workers Paid: 50M queried + 10M stored free/mo, then $0.01/M queried, $0.05/100M stored | [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) |
| Native controls | None for cost. Index/namespace limits: 50K per account (Paid) since 2024-10-24 | [Vectorize changelog](https://developers.cloudflare.com/vectorize/platform/changelog/) |
| cf-monitor guard | Runtime Vectorize binding proxy: count queries × `topK` × dimensions; periodic REST poll for stored-vector count | — |

### 7.11 Hyperdrive

| Aspect | Detail | Source |
|---|---|---|
| Free included | 100,000 DB queries/day; **errors when exceeded on Free** (hard cap) | [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) |
| Paid included | Unlimited (no charge — connection pooling + cache are included in Workers Paid) | [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) |
| REST | `/accounts/{id}/hyperdrive/configs` (CRUD) | [API ref](https://developers.cloudflare.com/api/) |
| Permissions | `Hyperdrive Read`, `Hyperdrive Edit` | [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) |
| GraphQL | **No dataset** | — |
| cf-monitor guard | On Paid: nothing to enforce (unlimited). On Free: monitor for 429s from Hyperdrive (treat as cap-reached signal) | — |

### 7.12 Images

| Aspect | Detail | Source |
|---|---|---|
| Pricing | Free 5K unique transformations/mo (errors when exceeded with `9422`). Paid: $0.50/1K transformations after first 5K; $5/100K stored; $1/100K delivered. | [Images pricing](https://developers.cloudflare.com/images/pricing/) |
| REST | `/accounts/{id}/images/v1` (upload, list, get, delete); `/accounts/{id}/images/v1/variants` (variant CRUD); transformations served via `/cdn-cgi/image/...` URL on zone | [API ref](https://developers.cloudflare.com/api/) |
| Permissions | `Cloudflare Images Read`, `Cloudflare Images Edit` | [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) |
| Caching | Cache hits don't incur a new transformation charge within the same calendar month — only first unique combination is billed | [Images transformations overview](https://developers.cloudflare.com/images/optimization/transformations/overview/) |
| Native controls | None for cost; can disable transformations on the zone (dashboard) | — |

### 7.13 Stream

| Aspect | Detail | Source |
|---|---|---|
| Datasets | `streamMinutesViewedAdaptiveGroups`, `videoPlaybackEventsAdaptiveGroups`, `videoBufferEventsAdaptiveGroups`, `videoQualityEventsAdaptiveGroups` | [Stream GraphQL Analytics](https://developers.cloudflare.com/stream/getting-analytics/fetching-bulk-analytics/) |
| Retention | 90 days, 31-day max query window | [Stream GraphQL Analytics](https://developers.cloudflare.com/stream/getting-analytics/fetching-bulk-analytics/) |
| REST | `/accounts/{id}/stream` (videos), `/accounts/{id}/stream/live_inputs` | [API ref](https://developers.cloudflare.com/api/) |
| Permissions | `Stream Read`, `Stream Edit` | [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) |
| Native controls | Webhooks for Live Input state changes (alert-only) | [Stream Live webhooks](https://developers.cloudflare.com/stream/stream-live/webhooks/) |

### 7.14 Cache Reserve, Argo, Load Balancing — summary

| Product | GraphQL | REST | Cost-monitoring relevance | Source |
|---|---|---|---|---|
| Cache Reserve | No dedicated dataset; use `httpRequestsAdaptive.cache_status` | `/zones/{zone}/cache/cache_reserve` (settings) | Cache Reserve writes are metered when enabled; track via HTTP analytics | [How charges accrue](https://developers.cloudflare.com/billing/understand/how-charges-accrue/) |
| Argo Smart Routing | No dedicated dataset; visible via HTTP analytics | `/zones/{zone}/argo/smart_routing` (toggle) | Per-zone monthly + per-request pricing | [API ref](https://developers.cloudflare.com/api/) |
| Load Balancing | `loadBalancingRequestsAdaptive` | `/accounts/{id}/load_balancers`, `/zones/{zone}/load_balancers` | DNS queries / origin requests / monitor checks all metered | [LB analytics](https://developers.cloudflare.com/load-balancing/reference/load-balancing-analytics/) |

### 7.15 WAF / Rate Limiting / Rulesets

| Surface | Endpoint | Method | Scope | Perms | Status | Source |
|---|---|---|---|---|---|---|
| Rulesets API (account) | `/accounts/{id}/rulesets` (list/create), `/accounts/{id}/rulesets/{id}` (CRUD), `/accounts/{id}/rulesets/phases/{phase}/entrypoint` (deploy) | GET/POST/PUT/DELETE | account | `Account WAF Write`, `Account Rulesets Write` | GA (account-level rate limiting requires Enterprise + paid add-on) | [WAF account rate-limiting create-api](https://developers.cloudflare.com/waf/account/rate-limiting-rulesets/create-api/) |
| Rulesets API (zone) | `/zones/{zone}/rulesets`, `/zones/{zone}/rulesets/{id}` | GET/POST/PUT/DELETE | zone | `Zone WAF Write` | GA | [WAF rate-limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/) |
| Custom rules | Same Rulesets API in `http_request_firewall_custom` phase | as above | zone or account | as above | GA | [WAF custom rules](https://developers.cloudflare.com/waf/custom-rules/) |
| Security events dataset | GraphQL `firewallEventsAdaptive` | POST | zone | `Analytics Read` | GA | [WAF security analytics](https://developers.cloudflare.com/waf/analytics/security-analytics/) |

**Use for cf-monitor**: emergency mitigation. cf-monitor (with `Account WAF Write`/`Zone WAF Write`) could install an account-level or zone-level rate limit rule when detecting an attack-traffic-driven cost spike. **Caution**: this is destructive to user-facing traffic; only do it on explicit user opt-in or after a confirmed runaway pattern.

### 7.16 Resource Tagging

| Aspect | Detail | Source |
|---|---|---|
| Status | Public beta (rolling out from 2026-04-27) | [Changelog 2026-04-27](https://developers.cloudflare.com/changelog/post/2026-04-27-resource-tagging-public-beta/) |
| REST | `/accounts/{id}/tags`, `/accounts/{id}/tags/resources/{type}/{id}` (CRUD on a resource's tag set) — schema: `{environment: "production", team: "platform"}` | [Resource Tagging overview](https://developers.cloudflare.com/resource-tagging/) |
| Auth | **Account-Owned Tokens (AOT)** — recommended; persists independent of users | [AOT docs](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/) |
| Roles | Super Admin / Workers Admin / Tag Admin | [Resource Tagging overview](https://developers.cloudflare.com/resource-tagging/) |
| Supported types | Zones, custom hostnames, Tunnels, Workers, D1, R2, KV, DO namespaces, Queues, Stream videos, Images, Access apps, Gateway rules, AI Gateways (full list link in docs) | [Resource types](https://developers.cloudflare.com/resource-tagging/reference/resource-types/) |
| Filter | AND/OR/negation/key-only matching; up to 20 filters per query | [Filter resources](https://developers.cloudflare.com/resource-tagging/how-to/filter-resources/) |
| cf-monitor use | Group resources by `project=...` tag so users can attribute cost to their own micro-tools without per-tool worker-name conventions | Important: tagging is *not* billing-aware — tags don't influence invoices, just queryable metadata |

### 7.17 Notifications / Budget Alerts

| Surface | Endpoint | Method | Scope | Perms | Status | Source |
|---|---|---|---|---|---|---|
| Policies CRUD | `/accounts/{id}/alerting/v3/policies` | GET/POST/PUT/DELETE | account | `Notifications Read/Write` | GA | [API ref](https://developers.cloudflare.com/api/) |
| Available alerts | `GET /accounts/{id}/alerting/v3/available_alerts` → 26 categories. Billing alert-type `type` values **confirmed by probe 2026-05-27**: `billing_budget_alert` (Budget Alert) and `billing_usage_alert` (usage-based billing, e.g. D1 rows). To create a budget alert, POST `/alerting/v3/policies` with `alert_type: "billing_budget_alert"` | dashboard / API | account/zone | `Notifications Write` | GA | [Budget alerts changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-billable-usage-dashboard-and-budget-alerts/) |
| Generic webhook destination | `/accounts/{id}/alerting/v3/destinations/webhooks` | GET/POST/PUT/DELETE | account | `Notifications Write` | GA | [Webhooks](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/) |
| Webhook auth | Cloudflare sends `cf-webhook-auth: <secret>` header — receiver must reject mismatches | — | — | — | — | [Webhooks](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/) |
| Webhook payload schema | `{name, text, data, ts, account_id, policy_id, policy_name, alert_type, alert_correlation_id, alert_event}` (generic) | — | — | — | — | [Webhook payload schema](https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/) |

**Critical**: notifications are **alert-only**. Budget Alerts fire email when projected monthly spend crosses a dollar threshold. They do not stop usage. cf-monitor's runtime budget enforcement remains the only hard cost-stop mechanism.

### 7.18 Logs / Tail Workers / Analytics Engine

| Aspect | Detail | Source |
|---|---|---|
| Tail Worker | Bound via `tail_consumers` in wrangler config; receives tail events from producer workers. Same per-invocation limits as a normal worker. | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| Workers Logs limits | 7-day retention; 5B logs/day per account (after exceeded: 1% head-sampling for the rest of day); 256KB per log (truncated above). Billing began 2025-04-21. | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| Analytics Engine limits | 20 blobs / 20 doubles / 1 index per `writeDataPoint`; 16KB total blob size per data point; 96-byte max index; 250 data points per Worker invocation; **3-month retention** | [AE limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) |
| AE pricing | Workers Paid: 10M writes + 1M reads/mo included, then $0.25/M writes, $1/M reads. Workers Free: 100K writes + 10K reads/day. **Billing not yet enforced** as of doc snapshot. | [AE pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) |
| AE REST | `POST /accounts/{id}/analytics_engine/sql` (raw SQL body, text/plain content-type) | [AE SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) |
| AE permissions | `Account Analytics`-style read for SQL queries; writes happen via Worker binding | [AE limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) |
| Use for cf-monitor | AE is reliable for time-series telemetry (already used). **Not** reliable for critical budget enforcement — AE writes are async and fail-open; cf-monitor's KV-based budget counters remain authoritative for enforcement. | — |

---

## 8. Resource discovery and tagging

Discovery is product-by-product:

Probe status (2026-05-27): **200** = listed live; **403** = endpoint exists, token lacks the read scope; **400** = path does not route.

| Resource | Endpoint | Probe status | Source |
|---|---|---|---|
| Workers scripts | `GET /accounts/{id}/workers/scripts` | 200 ✓ | [API ref](https://developers.cloudflare.com/api/) |
| D1 databases | `GET /accounts/{id}/d1/database` | 200 ✓ | [API ref](https://developers.cloudflare.com/api/) |
| R2 buckets | `GET /accounts/{id}/r2/buckets` | 200 ✓ | [API ref](https://developers.cloudflare.com/api/) |
| KV namespaces | `GET /accounts/{id}/storage/kv/namespaces` | 200 ✓ | [API ref](https://developers.cloudflare.com/api/) |
| Queues | `GET /accounts/{id}/queues` (mirror: `GET /accounts/{id}/workers/queues`) | 200 ✓ | [API ref](https://developers.cloudflare.com/api/) |
| DO namespaces | `GET /accounts/{id}/workers/durable_objects/namespaces` | 200 ✓ | [API ref](https://developers.cloudflare.com/api/) |
| Workflows | `GET /accounts/{id}/workflows` | 200 ✓ (verified path) | [Workflows](https://developers.cloudflare.com/workflows/) |
| Secrets Store | `GET /accounts/{id}/secrets_store/stores` | 200 ✓ (backs AI Gateway BYOK) | [Secrets Store](https://developers.cloudflare.com/secrets-store/) |
| Vectorize indexes | `GET /accounts/{id}/vectorize/indexes` | 403 (needs `Vectorize Read`) | [API ref](https://developers.cloudflare.com/api/) |
| AI Gateways | `GET /accounts/{id}/ai-gateway/gateways` | 403 (needs `AI Gateway Read`) | [API ref](https://developers.cloudflare.com/api/) |
| AI Search | `GET /accounts/{id}/ai-search/instances` (hyphenated; `aisearch` 400s) | 403 (endpoint exists) | [AI Search](https://developers.cloudflare.com/ai-search/) |
| Pipelines | `GET /accounts/{id}/pipelines` | 403 (endpoint exists, beta) | [Pipelines](https://developers.cloudflare.com/pipelines/) |
| Pages projects | `GET /accounts/{id}/pages/projects` | 403 (needs `Pages Read`) | [Pages REST API](https://developers.cloudflare.com/pages/configuration/api/) |
| Hyperdrive configs | `GET /accounts/{id}/hyperdrive/configs` | 403 (needs `Hyperdrive Read`) | [API ref](https://developers.cloudflare.com/api/) |
| Zones | `GET /zones` | 200 ✓ | [API ref](https://developers.cloudflare.com/api/) |
| **Tags** | `GET /accounts/{id}/tags`, `GET /accounts/{id}/tags/resources` | 403 (both exist) | [Resource Tagging](https://developers.cloudflare.com/resource-tagging/) |

Once Resource Tagging is GA (currently public beta), it should replace product-by-product enumeration for project-grouping queries. Collectors for the newly-confirmed surfaces (Workflows, Secrets Store, AI Search, Pipelines, Tags) are **not** implemented yet — docs only; see roadmap.

### Audit Logs

| Version | Endpoint | Status (probe 2026-05-27) |
|---|---|---|
| v2 | `GET /accounts/{id}/logs/audit` | 200 — **requires BOTH `since` AND `before`** query params (`since` alone → 400). Event shape: `{account, action, actor, id, raw, resource}` |
| v1 | `GET /accounts/{id}/audit_logs` | 200 — still works alongside v2 (deprecated; different shape: `{action, actor, id, interface, metadata, newValue*, oldValue*, owner, resource, when}`) |

Audit-log ingestion is **not** in scope for this pass — documented for future reference only.

---

## 9. Notifications and budget alerts (deep-dive)

Budget Alerts are the closest thing Cloudflare offers to the "budget" cf-monitor enforces internally. Critical differences:

| Dimension | Cloudflare Budget Alerts | cf-monitor budgets |
|---|---|---|
| Trigger | Projected monthly spend crosses threshold (calculated daily) | Per-invocation usage exceeds limit, OR daily/monthly rollup crosses threshold |
| Action | Email | Trip circuit breaker (refuses future calls) + optional Slack/webhook alert |
| Latency | Up to 24h (daily evaluation) | Sub-second per invocation; minutes for cron-based rollups |
| Granularity | Account-wide $ spend | Per-feature, per-project, per-account |
| Enforcement | None (alert-only) | Hard pre-call check on bound resources |
| Availability | Pay-as-you-go only; not Enterprise contract accounts | Any account; cf-monitor agnostic to billing model |

**Recommendation**: cf-monitor should treat Budget Alerts as a redundant signal — install one at user request as a backup safety net — but not as a substitute for runtime guards. Users should be told plainly that Budget Alerts cannot stop a runaway workload.

---

## 10. Native controls and circuit breakers

Classification per the brief's section E.

### Native hard controls (actually prevent spend at Cloudflare level)

| Surface | What it stops | When | Source |
|---|---|---|---|
| Workers Free daily request cap (100K) | Worker invocations | Daily limit reached → error | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| D1 Free daily limits (5M reads / 100K writes) | D1 queries | Daily limit reached → DB API returns errors | [D1 FAQ](https://developers.cloudflare.com/d1/reference/faq/) |
| KV Free daily limits (100K reads / 1K writes / etc.) | KV ops | Daily limit reached → errors | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers AI Free daily 10K neurons | Workers AI inference | Daily limit reached → errors | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Hyperdrive Free 100K queries/day | DB queries via Hyperdrive | Daily limit reached → errors | [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) |
| Workers Logs 5B/day account cap | Log volume above this is sampled at 1% | Daily | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| Images Free 5K transformations/mo | Returns 9422 error after | Monthly | [Images pricing](https://developers.cloudflare.com/images/pricing/) |
| AI Gateway Dynamic Routes "Budget Limit" node | Switches to fallback model after $ quota for period | Per-route evaluation | [Dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/) |
| Workers for Platforms Custom Limits | CPU + subrequests per dispatched-customer Worker | Per-invocation | [Custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/) |

### Native rate / usage limiters (throttle blast radius; not $-caps)

| Surface | What it does | Source |
|---|---|---|
| Workers per-invocation CPU limit (`limits.cpu_ms`, default 30s, max 5min on Paid Workflows/Queues consumers) | Caps single invocation compute | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Workers per-invocation subrequest limit (50 Free, 1000 Paid) | Caps fetch/storage calls per invocation | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| AI Gateway rate limit (`rate_limiting_limit` + `rate_limiting_interval`) | Caps gateway throughput | [AI Gateway rate limiting](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/) |
| Queues consumer `max_concurrency` | Caps consumer fan-out (still pays for messages) | [Consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/) |
| WAF rate limiting rules | Caps requests per IP/colo/etc per period | [WAF rate-limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/) |

### Native emergency circuit breakers (cause outage)

- **Detach Workers route** — `DELETE /zones/{zone}/workers/routes/{id}` (zone, `Workers Routes Edit`). Removes Worker from path; subsequent requests fall through to Pages or origin.
- **Deploy no-op safe-mode worker** — `PUT /accounts/{id}/workers/scripts/{name}` (account, `Workers Scripts Edit`) with a 503 stub. Destructive — cannot be undone without redeploying real code.
- **Disable cron triggers** — `PUT /accounts/{id}/workers/scripts/{name}/schedules` (account, `Workers Scripts Edit`) with empty `crons: []`. Propagates within 15 min.
- **Add WAF block rule** — `POST /zones/{zone}/rulesets` (zone, `Zone WAF Write`). Emergency traffic block.
- **Add account-level rate limit rule** — `POST /accounts/{id}/rulesets` (account, `Account WAF Write` + `Account Rulesets Write`). Enterprise+ only.
- **Disable AI Gateway** — set gateway `enable: false` via API. Stops routing through that gateway.
- **Purge Queue** — `POST /accounts/{id}/queues/{id}/purge`. Drops backlog (data loss).

### Runtime guard required (no native cap; cf-monitor must enforce)

- D1 rows read / written on **Paid** plan.
- KV ops on **Paid** plan.
- R2 storage + Class A/B ops on **Paid** plan (any plan for IA storage).
- Queue producer + consumer ops on **Paid** plan.
- DO requests + duration + storage on **Paid** plan.
- Workers AI neurons on **Paid** plan beyond 10K/day.
- Vectorize queried/stored dimensions on any plan.
- Hyperdrive queries on **Paid** plan (Paid = unlimited but you should still know spend).
- Images transformations on **Paid** plan.
- Stream minutes viewed.
- Cache Reserve writes.
- Argo Smart Routing per-request fees.

### Alert-only

- **Budget Alerts** (email when projected spend crosses $-threshold; Pay-as-you-go only).
- **Usage-based billing notifications** (D1 rows read/written threshold notifications).
- **Notifications policies** generally (health, security, DNS, deployment events).
- **Generic webhooks** as a delivery channel.

### Visibility-only

- **Billable Usage dashboard** (Apr 2026) — daily $ per product, billing-cycle aligned, no public API.
- **GraphQL Analytics datasets** — broad usage data, explicitly not billing-authoritative.
- **Workers AI dashboard** — neuron usage per account.
- **AI Gateway dashboard** — request volume, cache hit rate, cost per provider.

---

## 11. Permission matrix

Minimum API token scopes for cf-monitor operations. Cloudflare permission names are listed in [`/fundamentals/api/reference/permissions/`](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

### Read-only monitoring token (recommended default)

| cf-monitor operation | Required CF permission | Scope | Read/Edit |
|---|---|---|---|
| Plan detection | `Billing Read` | account | Read |
| GraphQL Analytics (account datasets — Workers/D1/KV/R2/DO/Queues) | `Account Analytics` | account | Read |
| GraphQL Analytics (zone datasets — HTTP/WAF/LB/Pages-zone) | `Analytics Read` | zone | Read |
| Workers script discovery | `Workers Scripts Read` | account | Read |
| Workers tail / logs | `Workers Tail Read`, `Workers Observability Read` | account | Read |
| D1 database list | `D1 Read` | account | Read |
| KV namespace list | `Workers KV Storage Read` | account | Read |
| R2 bucket list | `Workers R2 Storage Read` | account | Read |
| Queue list + realtime metrics | `Queues Read` | account | Read |
| AI Gateway list + logs | `AI Gateway:Read` | account | Read |
| Workers AI usage | `Workers AI Read` | account | Read |
| Resource tag query | `Account Settings Read` + (Resource Tagging tokens via AOT — beta) | account | Read |
| Notifications list | `Notifications Read` | account | Read |
| Account-owned token list | `User API Tokens Read` | user | Read |
| Pages project list | `Pages Read` | account | Read |
| Hyperdrive config list | `Hyperdrive Read` | account | Read |
| Vectorize index list | `Vectorize Read` | account | Read |
| Analytics Engine SQL queries | `Account Analytics` | account | Read |

### Controller token (optional, for native control actions; only requested at user opt-in)

| cf-monitor operation | Required CF permission | Scope | Read/Edit |
|---|---|---|---|
| Create Budget Alert policy | `Notifications Write` | account | Edit |
| Create webhook destination | `Notifications Write` | account | Edit |
| Create AI Gateway / set rate limit | `AI Gateway:Edit` | account | Edit |
| Detach Workers route | `Workers Routes Edit` | zone | Edit |
| Deploy safe-mode Worker | `Workers Scripts Edit` | account | Edit |
| Disable cron triggers | `Workers Scripts Edit` | account | Edit |
| Update Worker script settings (cpu_ms, subrequests) | `Workers Scripts Edit` | account | Edit |
| Create WAF custom rule / rate limit (zone) | `Zone WAF Write` | zone | Edit |
| Create WAF rate limit (account; Enterprise) | `Account WAF Write` + `Account Rulesets Write` | account | Edit |
| Create Resource Tag (when beta → GA) | (AOT-based; Tag Admin or Super Admin role) | account | Edit |
| Purge Queue | `Queues Edit` | account | Edit |
| Billing Edit (e.g. budget alert creation) | `Billing Edit` | account | Edit |

### cf-monitor recommendation

- **Default**: ask for a read-only token at `cf-monitor init`. Document each permission's purpose in the CLI prompt.
- **Opt-in**: separate controller token created only if user enables native control actions. Never bundle controller perms into the default token — minimises blast radius if leaked.
- **Token Templates**: cf-monitor can refer users to Cloudflare's `Read analytics and logs` template plus selective additional `*Read` permissions, rather than asking them to assemble from scratch.

---

## 12. Data confidence model

Confidence categories per the brief's section G, with surface mapping.

| Confidence | Definition | Surfaces |
|---|---|---|
| `billing_authoritative` | Matches the monthly invoice | **None publicly accessible**. Billable Usage dashboard is the only billing-authoritative source and has no public API. |
| `billing_api_alpha` | API exists but is alpha/restricted | (none confirmed at this time) |
| `dashboard_documented_no_public_api` | Documented but only via dashboard | Billable Usage dashboard; per-product realtime usage dashboards (Workers AI, AI Gateway) |
| `analytics_estimate` | GraphQL Analytics — broad usage, explicitly not billing | All `*AdaptiveGroups`/`*Adaptive` datasets used by cf-monitor (workersInvocationsAdaptive, d1AnalyticsAdaptiveGroups, kvOperationsAdaptiveGroups, r2OperationsAdaptiveGroups, durableObjectsInvocationsAdaptiveGroups, queueBacklogAdaptiveGroups, …) |
| `runtime_metered` | Counted by cf-monitor's SDK as operations happen | KV/D1/R2/Queue/DO/Workers AI/Vectorize binding proxies. Highest fidelity for *what happened on this account*, but does not include traffic from outside the cf-monitor-instrumented worker tree (e.g. dashboard ad-hoc queries) |
| `user_configured` | Set by the user in `cf-monitor.yaml` | Per-feature `budget`, transient patterns, custom alert thresholds |
| `unknown` | No public source | Account-wide $ cap; FOCUS-style invoice export; AI Gateway account-wide spend cap; Vectorize/Hyperdrive/Workflows GraphQL Analytics |

**Implementation note**: cf-monitor `/usage` should surface the confidence per metric. e.g. "D1 rows written: 1.2M (analytics_estimate; +/- runtime_metered 1.18M from this worker tree)". Users must understand they are reading projections, not invoices.

---

## 13. Recommended cf-monitor implementation plan

Ordered by foundation-first dependency.

### Tier 1 — Already implemented, verified by this research
1. `/accounts/{id}/subscriptions` for plan detection (✓).
2. Workers / D1 / KV / R2 / DO GraphQL hourly collection (✓; verify queries against current schema annually).
3. AI Gateway logs REST collection (✓).
4. Worker discovery via `/accounts/{id}/workers/scripts` (✓).
5. Static plan-allowance catalogue (✓; verify quarterly against [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
6. Runtime binding proxies for D1/KV/R2/Queue/DO/AI/Vectorize (✓ in `src/sdk/proxy.ts`).

### Tier 2 — High-value additions
7. **Queues realtime backlog REST polling** — `GET /accounts/{id}/queues/{id}/metrics`. Adds visibility into stuck consumers / backlog-driven cost spikes.
8. **Vectorize REST polling** — `GET /accounts/{id}/vectorize/indexes` + `list_vectors` for stored-dimension counts (queried dimensions from runtime proxy).
9. **Pages projects + deployments discovery** — `/accounts/{id}/pages/projects`. Pages Functions are billed as Workers; surface them alongside script list.
10. **Notifications subscription** — register cf-monitor as a webhook destination for Budget Alerts (only if user opts in). Document the signal as "redundant secondary".

### Tier 3 — Native controls (opt-in only; require controller token)
11. **AI Gateway rate-limit setter** — `PATCH /accounts/{id}/ai-gateway/gateways/{id}` to set `rate_limiting_*` on user request.
12. **AI Gateway Dynamic Routes Budget Limit setter** — manage route nodes via REST (when stable).
13. **Workers Routes detach** — emergency disable; require explicit `--confirm` flag and dry-run output.
14. **Cron trigger disable** — `PUT /accounts/{id}/workers/scripts/{name}/schedules` with empty array. Less destructive than route detach.
15. **WAF emergency rate limit rule** — install zone-level rate limit rule. Require strong user confirmation; expose as `cf-monitor emergency block <pattern>`.

### Tier 4 — Should remain unsupported
16. **Account-wide spend cap installation** — does not exist as a CF primitive; do not pretend by aggregating per-feature CBs.
17. **Invoice extraction** — Enterprise-only; explicitly out of scope for indie tool.
18. **Mutation of plan-allowance catalogue from API** — Cloudflare does not expose these numbers; do not invent a "fetch allowances" command that lies.

### Per cf-monitor command

| Command | Endpoints used | Confidence |
|---|---|---|
| `cf-monitor plan detect` | `/accounts/{id}/subscriptions` | High (billing_authoritative for plan only) |
| `cf-monitor scan` | All discovery endpoints (workers/scripts, d1/database, r2/buckets, kv/namespaces, queues, vectorize/indexes, ai-gateway/gateways, pages/projects, hyperdrive/configs); optionally `/accounts/{id}/tags/resources` if tagging GA | analytics_estimate (counts) |
| `/usage` (HTTP endpoint) | GraphQL Analytics (5 batched queries) + AI Gateway logs + Queues realtime + cf-monitor's own AE rollups | analytics_estimate; cf-monitor's AE is runtime_metered |
| `/protection-coverage` (future) | Workers script list + cf-monitor's own SDK registration KV → diff = "unprotected" | runtime_metered + user_configured |
| `/plan` | `/accounts/{id}/subscriptions` + cf-monitor allowances catalogue | High |

### Architectural principles (re-stated)

- **Fail open by default** — cf-monitor SDK and discovery code must not break the user's worker on a CF API outage.
- **Never silently assume Free** — leads to too-low default budgets on a Paid account.
- **Label every cost number with confidence** — `/usage` must show `analytics_estimate` next to GraphQL-derived figures.
- **Surface what CF cannot do** — be explicit in docs (FAQ, `/usage` response) that Cloudflare does not offer account-wide hard spend caps.
- **Controller token is opt-in** — never request `*Edit` permissions during default init.

### What must require explicit user confirmation
- Installing AI Gateway rate limits or Budget Limit Dynamic Route nodes (changes user-facing traffic).
- Detaching Workers routes (causes outage).
- Deploying safe-mode Workers (data path effect).
- Disabling cron triggers (workflow effect).
- Creating WAF rules at zone/account level (traffic block effect).

---

## 14. Open questions / requires live account verification

Items the research could not pin without a live, mutation-capable CF account:

1. **Exact path of cron-triggers PUT endpoint** — docs reference `/schedules` resource but full schema not surfaced in `cloudflare-docs` MCP results; verify against [`/api/`](https://developers.cloudflare.com/api/) before implementation.
2. **Whether `/accounts/{id}/subscriptions` returns `component_values` populated for all PAYG accounts** (cf-monitor relies on `current_period_start/end`; confirm always present).
3. **Whether the Unified AI REST API endpoints (`/ai/v1/chat/completions` etc.) emit AI Gateway logs by default when no `cf-aig-gateway-id` is set** — changelog says "default gateway" auto-created, but log retention/visibility behaviour for `default` should be confirmed.
4. **Vectorize REST API stability** — `list_vectors` is recent (2024-08-25); pagination + rate limits not deeply documented.
5. **D1 `d1QueriesAdaptiveGroups` access** — schema implies query-string capture (sensitive). Confirm whether cf-monitor can read this without violating user expectations / compliance.
6. **Resource Tagging public-beta API stability** — `cf-monitor` should not depend on tag-based filtering for critical paths until tagging hits GA.
7. **Budget Alert policy creation API exact schema** — alert-type values now **confirmed** (`billing_budget_alert`, `billing_usage_alert`; probe 2026-05-27), but the full `/accounts/{id}/alerting/v3/policies` POST body (filters/mechanism block) still needs verification before any create-policy implementation.
8. **Exact dataset name for HTTP Cache Reserve writes** — assumed to be visible via `httpRequestsAdaptive.cache_status`; verify.
9. **AI Gateway Unified Billing credit balance read** — is there an endpoint to query current Cloudflare credit balance? Not surfaced.
10. **Whether tagged resources can be filtered by tag in product-specific list endpoints** (e.g. `/workers/scripts?tag.environment=production`) or only via the central `/tags/resources` query.
11. **`/accounts/{id}/billing/usage` payload shape** — **Resolution (2026-05-28 Billing Read probe)**: NOT a programmatic Billable Usage API. Generic time-series metric query with no per-product breakdown and no $-cost; redundant with GraphQL Analytics. Decision recorded in `billing-endpoints-follow-up.md` Decision A → branch C: do not wire. Full metric vocabulary remains undocumented (sub-question only — not blocking).
12. **R2 `event-notification` REST path** — `GET /accounts/{id}/r2/buckets/{b}/event-notification` returns 404 "No route matches this url" (probe 2026-05-27). The Terraform `r2_bucket_event_notification` resource implies an event-notification API exists, but the obvious singular path is wrong. Path unknown — open.
13. **R2 `ListBucket` Class A vs Class B** — **resolution (2026-05-28)**: reclassified `unknown` in `src/worker/crons/r2-classification.ts` (warned, not counted). The brief permitted `unknown` or conservative `class_a_assumed` when ambiguous; `unknown` was chosen to match "prefer unknown over fake precision" and to reuse the existing warn-and-skip path. Final classification still awaits an authoritative Billing Read invoice.

These should be added to cf-monitor issue tracker as "verify against live CF API before implementing" items.

---

## 15. Source links

Primary references used to build this document. Every endpoint and claim in the tables above cites the relevant source URL inline.

- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers platform changelog](https://developers.cloudflare.com/workers/platform/changelog/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Billing permissions](https://developers.cloudflare.com/billing/understand/billing-permissions/)
- [How billing works](https://developers.cloudflare.com/billing/understand/how-billing-works/)
- [How charges accrue](https://developers.cloudflare.com/billing/understand/how-charges-accrue/)
- [Billable Usage dashboard + Budget alerts changelog 2026-04-13](https://developers.cloudflare.com/changelog/post/2026-04-13-billable-usage-dashboard-and-budget-alerts/)
- [GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/)
- [GraphQL introspection](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/introspection/)
- [Querying Workers metrics tutorial](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)
- [CMB dataset list (cross-product GraphQL reference)](https://developers.cloudflare.com/data-localization/metadata-boundary/graphql-datasets/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 FAQ](https://developers.cloudflare.com/d1/reference/faq/)
- [D1 observability/billing](https://developers.cloudflare.com/d1/observability/billing/)
- [D1 metrics/analytics](https://developers.cloudflare.com/d1/observability/metrics-analytics/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [R2 storage classes](https://developers.cloudflare.com/r2/buckets/storage-classes/)
- [R2 metrics/analytics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)
- [KV metrics/analytics](https://developers.cloudflare.com/kv/observability/metrics-analytics/)
- [Queues metrics](https://developers.cloudflare.com/queues/observability/metrics/)
- [Queues consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects release notes](https://developers.cloudflare.com/durable-objects/release-notes/)
- [Durable Objects observability](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)
- [AI Gateway BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [AI Gateway rate limiting](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/)
- [AI Gateway dynamic routing (incl. Budget Limit)](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)
- [AI Gateway REST API (Unified)](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
- [AI Gateway changelog 2026-05-21 (Unified API)](https://developers.cloudflare.com/changelog/post/2026-05-21-rest-api/)
- [AI Gateway changelog 2026-03-02 (default gateway)](https://developers.cloudflare.com/changelog/post/2026-03-02-default-gateway/)
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)
- [Vectorize client API](https://developers.cloudflare.com/vectorize/reference/client-api/)
- [Vectorize changelog](https://developers.cloudflare.com/vectorize/platform/changelog/)
- [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/)
- [Images pricing](https://developers.cloudflare.com/images/pricing/)
- [Images optimization overview](https://developers.cloudflare.com/images/optimization/transformations/overview/)
- [Stream GraphQL Analytics](https://developers.cloudflare.com/stream/getting-analytics/fetching-bulk-analytics/)
- [Pages REST API](https://developers.cloudflare.com/pages/configuration/api/)
- [Pages Functions metrics](https://developers.cloudflare.com/pages/functions/metrics/)
- [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/)
- [WAF security analytics](https://developers.cloudflare.com/waf/analytics/security-analytics/)
- [WAF rate-limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- [WAF account rate-limiting rulesets](https://developers.cloudflare.com/waf/account/rate-limiting-rulesets/create-api/)
- [Rulesets API overview](https://developers.cloudflare.com/ruleset-engine/rulesets-api/)
- [Resource Tagging overview](https://developers.cloudflare.com/resource-tagging/)
- [Resource Tagging changelog 2026-04-27](https://developers.cloudflare.com/changelog/post/2026-04-27-resource-tagging-public-beta/)
- [Notifications webhook configuration](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/)
- [Notifications webhook payload schema](https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- [Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)
- [Workers cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers for Platforms custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/)
- [Load Balancing analytics](https://developers.cloudflare.com/load-balancing/reference/load-balancing-analytics/)
- [Email Service metrics](https://developers.cloudflare.com/email-service/observability/metrics-analytics/)
- [Page Shield rule violations](https://developers.cloudflare.com/client-side-security/rules/violations/)
- [API token permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [API token templates](https://developers.cloudflare.com/fundamentals/api/reference/template/)
- [Account-Owned Tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
- [Cloudflare API reference (full)](https://developers.cloudflare.com/api/)
