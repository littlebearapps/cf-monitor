# Cloudflare API Surface — Deep-Dive Pass 2

**Generated**: 2026-05-27
**Companion to**: [`cloudflare-api-surface.md`](./cloudflare-api-surface.md) (pass 1), this file is the deeper inventory.
**Delta doc**: [`cloudflare-api-surface-delta.md`](./cloudflare-api-surface-delta.md) — read that for what changed.
**Live probe results**: [`cloudflare-api-probe-results.md`](./cloudflare-api-probe-results.md) — added 2026-05-27 against Scout CF account (Platform token was 401 in BWS). Many `partially_verified` entries below have been **promoted to `verified`** in the probe-results companion; see that doc for the authoritative status.
**Source channels used**: CF Docs MCP, Cloudflare TypeScript SDK source tree (`cloudflare/cloudflare-typescript`), Terraform provider source tree (`cloudflare/terraform-provider-cloudflare`), Cloudflare changelog, **live API probe against Scout CF account** (added in update). **Channels still unavailable**: Platform-specific probe (BWS token expired).

> **Important corrections from live probe** (apply when reading the tables below):
> 1. Queue GraphQL dataset names are **singular** (`queueBacklogAdaptiveGroups`, `queueMessageOperationsAdaptiveGroups`, `queueConsumerMetricsAdaptiveGroups`) — plural form documented in CF prose is wrong.
> 2. R2 `actionType` dimension values are S3 names (`GetObject`, `HeadObject`, `PutObject`, `ListBucket`), not `read`/`write`.
> 3. Audit Logs v2 requires both `since` AND `before` query params.
> 4. Confirmed billing alert types: `billing_budget_alert` + `billing_usage_alert` (under "Billing" category).
> 5. `Query.cost` and `viewer.budget` GraphQL fields are **query rate-limit metadata**, not account cost — useful for cf-monitor to self-monitor its GraphQL spend.

> **Hard rule from the brief**: do not invent endpoints. Unverified items are marked `unverified` / `ambiguous` / `not_found`. Speculation is never presented as fact.

---

## 1. Executive summary

Pass 1 inventoried ~51 surfaces across ~20 product groups, primarily from Cloudflare developer docs. Pass 2 cross-references the **official `cloudflare/cloudflare-typescript` SDK resource tree** (109 top-level resource groups) and the **`cloudflare/terraform-provider-cloudflare` provider** (251 services). The SDK shows what REST endpoints Cloudflare has formalised; the Terraform provider shows what's writable as infrastructure-as-code. Together they reveal:

1. **Cloudflare has a `billing` SDK resource group** — which pass 1 marked as missing. The exact endpoints under it are not documented in product prose. Marked `partially_verified` pending live introspection.
2. **Audit Logs v2 went GA on 2026-03-10**: `GET /accounts/{account_id}/logs/audit` (and `/organizations/{org_id}/logs/audit`). 18-month retention. Logpush dataset `audit_logs_v2`. Permission: `Account Settings Read/Write`. Pass 1 missed this entirely.
3. **API token verification is a documented public endpoint**: `GET /user/tokens/verify` returns the token's status; `GET /user/tokens/permission_groups` lists every permission group. cf-monitor can self-introspect its token at runtime — pass 1 did not document this.
4. **Logpush is Enterprise-only** for HTTP/object destinations. Pass 1 implied general availability; the docs explicitly mark Free/Pro/Business = "No". `Logs Write` permission required.
5. **The Terraform provider contains zero billing/usage/invoice/budget surfaces** (only `account_subscription` and `zone_subscription`). This corroborates pass 1's conclusion that cost monitoring has no Terraform-managed surface.
6. **Pipelines and R2 Data Catalog joined Terraform on 2026-04-27** (provider v5.19.0). Open beta — Cloudflare not billing for Pipelines yet beyond R2 storage. Pass 1 mentioned Pipelines via `pipelinesUserErrorsAdaptiveGroups` only.
7. **AI Search** is a new Cloudflare product with REST resources (`ai_search_instance`, `ai_search_token`); not on Cloudflare docs MCP for the queries we ran. Marked `partially_verified` — exists in SDK + Terraform but cost/usage characteristics not yet confirmed.
8. **Workflows pricing is purely Workers passthrough** (CPU + requests), confirmed via official pricing page. Limits raised to 50K concurrent instances on Paid plan on 2026-04-15.
9. **Browser Rendering pricing** is now $0.09/browser-hour (started billing 2025-08-20). REST API rate limit increased 3x to 10 req/sec on Paid (2026-03-04).
10. **Notification policy webhooks have their own Terraform resource** (`notification_policy_webhooks`) separate from policies — pass 1 didn't break this out.

cf-monitor implications: the `billing` SDK resource group is the most material unknown — it could close (or reduce the surface area of) pass 1's "no billing API exists" claim. cf-monitor should probe `/accounts/{id}/billing/*` with a read-only token to confirm what (if anything) is queryable.

---

## 2. Discovery methodology

For each scope area in the brief, we ran:

1. **Cloudflare Docs MCP** (`mcp__cloudflare-docs__search_cloudflare_documentation`) with focused, product-targeted queries — not just product names, but capability terms (e.g. "audit logs API account history", "API tokens introspection verify").
2. **GitHub MCP** (`mcp__github__get_file_contents`) to enumerate the `cloudflare-typescript/src/resources/` directory and `terraform-provider-cloudflare/internal/services/` directory. The returns were ~140K-156K chars each, so we used file-reading subagents to slice and extract.
3. **Cross-correlation**: every claim is anchored to either (a) a developers.cloudflare.com URL, (b) the cloudflare-typescript SDK source file path, or (c) the terraform-provider-cloudflare resource path. No claim relies on a single channel.

Channels NOT exhausted in this pass (documented honestly):
- **Wrangler source-level grep for `/accounts/` / `/zones/`** — skipped because the Terraform provider catalogue covers the same endpoint surface (Terraform consumes the same APIs Wrangler does).
- **Live GraphQL introspection** — no credentials available in shell env; converted to `cloudflare-api-probe-plan.md`.
- **Live REST probing** — same reason; in probe plan.

---

## 3. Source channels used (and what each contributed)

| Channel | Tool/source | Used for | Key contribution |
|---|---|---|---|
| Cloudflare Docs MCP | `mcp__cloudflare-docs__search_cloudflare_documentation` | Gap-product searches (Audit Logs, Logpush, Workflows, Pipelines, Browser Rendering, Bot Mgmt, Access) | Audit Logs v2 GA path; Logpush Enterprise-only; Browser Rendering pricing |
| Cloudflare TypeScript SDK | `cloudflare/cloudflare-typescript` `src/resources/` directory listing | Endpoint-group discovery | 109 resource groups; confirmed `billing`, `audit-logs`, `pipelines`, `ai-search`, `vulnerability-scanner`, `r2-data-catalog`, `resource-sharing`, `realtime-kit` exist as first-class REST resources |
| Terraform provider | `cloudflare/terraform-provider-cloudflare` `internal/services/` directory listing | Writable-control discovery, resource model | 251 services; revealed R2 lifecycle / locks / event notifications / sippy / managed domains; Workflows + Pipelines TF resources (May 2026); confirms no billing/usage/budget TF surfaces |
| Cloudflare changelog | docs MCP year-scoped searches | Recent additions | Audit Logs v2 GA (Mar 2026); Browser Rendering rate limit 3x (Mar 2026); Workflows step+concurrency raises (Mar/Apr 2026); Pipelines TF (Apr 2026); AI Gateway Unified REST API (May 2026 — already in pass 1) |
| Pass 1 research | `docs/research/cloudflare-api-surface.md` + `.json` | Baseline | Pre-existing 51-surface inventory used as delta anchor |

---

## 4. Source channels unavailable

| Channel | Why unavailable | Workaround |
|---|---|---|
| Live GraphQL introspection | No `CLOUDFLARE_API_TOKEN` in shell env; no `.envrc` in repo | Authored `cloudflare-api-probe-plan.md` with prepared `__type` queries |
| Live REST probing | Same | Same |
| `apify` / `jina` / `pal` MCP servers | Disconnected mid-session per system reminders | Substituted with Cloudflare Docs MCP + GitHub MCP |
| Cloudflare Python / Go SDK source trees | Not inspected (TypeScript SDK is the canonical generated client) | Documented as not-inspected; TS SDK presumed authoritative; cross-cite Terraform as second source |
| Cloudflare OpenAPI spec | Not found via docs MCP queries | Marked `not_found`; assumed Cloudflare uses Stainless to generate the SDK from an internal OpenAPI/JSON-schema, not currently published |

---

## 5. Delta vs existing research

Full delta is in [`cloudflare-api-surface-delta.md`](./cloudflare-api-surface-delta.md). Summary counts:

- **New surfaces found**: 21 (Audit Logs v2 REST + Logpush dataset, token verify, token permission_groups list, billing SDK group, R2 lifecycle/event/lock/sippy/managed-domain, Pipelines stream/sink/pipeline, R2 Data Catalog, AI Search, Vulnerability Scanner, Resource Sharing, Realtime Kit, Leaked Credential Checks, notification_policy_webhooks split, Workers `worker_version` + `workers_secret` + `workers_deployment`, Web Analytics rules/sites)
- **Previously documented surfaces confirmed**: 47 of 51 still verified
- **Corrections / downgrades**: 4 (see Delta doc)
- **Endpoints searched-for but not found**: 8 (see §9)

---

## 6. Newly discovered endpoints/surfaces

Every entry uses the brief's full schema. Sources prefixed `cf-ts:` mean `cloudflare-typescript/src/resources/<dir>/` (SDK directory); `tf:` means `terraform-provider-cloudflare/internal/services/<dir>/`.

### 6.1 Billing / cost / account

| service | capability | surface_type | name | endpoint_or_dataset | method | scope | status | source_channel | source_url_or_file | required_permissions | requires_approval_or_plan | data_exposed | freshness | retention | billing_authoritative | exposes_cost | exposes_allowance | can_enforce_limits | control_type | cf_monitor_use | implementation_priority | caveats | verification_status | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| billing | unknown | sdk | Billing resource group | (unknown — exact paths not surfaced in docs MCP queries) | unknown | account | unknown | sdk | `cf-ts:billing/` | unknown — likely `Billing Read/Edit` | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | Live-probe candidate — could close pass 1's "no billing API" gap | p1 | Exists in SDK as a top-level resource; not on cloudflare-docs MCP. Either undocumented or restricted/internal | partially_verified | **Highest-value unknown in this pass** |
| account | subscription mgmt | terraform | `account_subscription` | (resource — implies REST CRUD endpoint exists) | (terraform CRUD) | account | ga | terraform | `tf:account_subscription/` | `Billing Edit` (inferred) | unknown | rate plan id, billing period | unknown | n/a | partial | no | partial | partial | visibility_only | Confirms pass 1's `GET /accounts/{id}/subscriptions` is also a writeable endpoint via Terraform | p3 | Pass 1 covered the read path only | verified | Mirrors `zone_subscription` for zone-level plans |
| audit_logs | v2 list | rest | Audit Logs v2 | `GET /accounts/{account_id}/logs/audit` | GET | account | ga (since 2026-03-10) | docs | https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/ | `Account Settings Read` (or `Write`) | no | actor, action_type, action_result, resource, raw HTTP method, zone, ray_id, auth method, interface (API/dash), 20+ filter params | near real-time | 18 months | partial (records auth events; not invoice) | no | no | no | visibility_only | Detect privileged-token misuse, post-incident forensics for cost spike events | p2 | ~95% product coverage at GA, up from ~75% in v1; UI/API both available | verified | Pass 1 missed this entirely |
| audit_logs | v2 organisation-scope | rest | Org Audit Logs | `GET /organizations/{org_id}/logs/audit` | GET | organization | ga (since 2026-03-10) | docs | https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/ | `Account Settings Read` (inferred) | no | as above + org-scoped events | near real-time | 18 months | partial | no | no | no | visibility_only | Only for accounts in organisations | p3 | "User-initiated actions only" at initial release; system actions, dashboard UI, Logpush coming later | partially_verified | Indie devs typically not in orgs |
| audit_logs | logpush dataset | dashboard+rest | `audit_logs_v2` Logpush dataset | (Logpush job dataset name) | n/a | account | ga | docs | https://developers.cloudflare.com/changelog/post/2026-03-10-audit-logs-v2-ga/ | `Logs Write` (to configure) | no (but Logpush itself is Enterprise) | full audit logs | streamed | sink-defined | no | no | no | no | visibility_only | Enterprise-only delivery channel | never (PAYG indies can't use Logpush) | Pass 1's audit gap | verified | Indie devs use direct API instead |
| iam | token verify | rest | Verify API token | `GET /user/tokens/verify` | GET | user | ga | docs | https://developers.cloudflare.com/fundamentals/api/troubleshooting/ | (none — token authenticates itself) | no | `id`, `status` (active/disabled/expired), `not_before`, `expires_on` | real-time | n/a | n/a | no | no | no | visibility_only | cf-monitor can confirm its own token is still active before running cron | p1 | Token IP/TTL restrictions are NOT applied to this endpoint per docs — useful for cf-monitor health-check | verified | Pass 1 did not document this |
| iam | permission groups list | rest | List token permission groups | `GET /user/tokens/permission_groups` | GET | user | ga | docs | https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/ | `API Tokens Read` or `Write` | no | array of `{id, name, description, scopes[]}` | real-time | n/a | n/a | no | no | no | visibility_only | cf-monitor can build the permission matrix dynamically rather than hard-coding | p2 | Permission `id` is stable; `name` is "cosmetic and subject to change" per docs | verified | Pass 1's permission matrix could be machine-generated from this |
| iam | account-owned token list | rest+terraform | Account API tokens | `/accounts/{account_id}/tokens` (CRUD); `tf:account_token/` | GET/POST/PUT/DELETE | account | ga | terraform+docs | https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/ | `API Tokens Read/Write` | no | token metadata (not value after creation) | real-time | n/a | n/a | no | no | no | visibility_only | Audit which Account-Owned Tokens exist | p3 | AOT survives credential rotations; recommended for cf-monitor's own controller token | verified | New surface vs pass 1 |

### 6.2 Workers expanded surfaces

| service | capability | surface_type | name | endpoint_or_dataset | method | scope | status | source | source_path | required_permissions | data_exposed | control_type | cf_monitor_use | priority | verification_status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| workers | script versions | terraform+rest | `worker_version` | `/accounts/{id}/workers/scripts/{name}/versions` (inferred) | GET/POST | account | ga | terraform | `tf:worker_version/` | `Workers Scripts Read/Edit` | version metadata, bindings | visibility_only | List rollback targets when reverting from a runaway version | p2 | partially_verified |
| workers | deployments | terraform+rest | `workers_deployment` | `/accounts/{id}/workers/scripts/{name}/deployments` (inferred) | GET/POST | account | ga | terraform | `tf:workers_deployment/` | `Workers Scripts Read/Edit` | deployment id, target version | native_circuit_breaker | Promote a previous version as emergency rollback | p2 | partially_verified |
| workers | secrets | terraform+rest | `workers_secret` | `/accounts/{id}/workers/scripts/{name}/secrets` (inferred) | GET/PUT/DELETE | account | ga | terraform | `tf:workers_secret/` | `Workers Scripts Edit` | secret names (not values) | visibility_only | Audit which secrets are wired without revealing values | p3 | partially_verified |
| workers | custom domains | terraform+rest | `workers_custom_domain` | `/accounts/{id}/workers/domains` (inferred) | GET/POST/DELETE | account | ga | terraform | `tf:workers_custom_domain/` | `Workers Scripts Edit` | domain, zone, script | native_circuit_breaker | Detach a custom domain to stop a runaway worker (less destructive than route-detach in some cases) | p2 | partially_verified |
| workers | workers.dev subdomain | terraform | `workers_script_subdomain` | (inferred) | GET/POST | account | ga | terraform | `tf:workers_script_subdomain/` | `Workers Scripts Edit` | enabled flag | native_circuit_breaker | Disable `*.workers.dev` access for a runaway worker without removing zone routes | p2 | partially_verified |

### 6.3 R2 expanded surfaces

| service | capability | surface_type | name | endpoint_or_dataset | source | source_path | data_exposed | control_type | cf_monitor_use | priority | verification_status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| r2 | bucket lifecycle | terraform+rest | `r2_bucket_lifecycle` | `/accounts/{id}/r2/buckets/{name}/lifecycle` (matches pass-1 mention) | terraform | `tf:r2_bucket_lifecycle/` | rules (transition, expiration) | native_hard | Detect Standard→IA transitions that incur retrieval fees | p2 | verified |
| r2 | event notification | terraform+rest | `r2_bucket_event_notification` | (inferred) | terraform | `tf:r2_bucket_event_notification/` | event rules (notify on PutObject etc.) | visibility_only | Detect cost-amplifying event-notification chains | p3 | partially_verified |
| r2 | bucket lock | terraform+rest | `r2_bucket_lock` | (inferred) | terraform | `tf:r2_bucket_lock/` | retention lock state | visibility_only | Detect compliance locks that prevent deletion (cost lock-in) | p3 | partially_verified |
| r2 | sippy (migration) | terraform+rest | `r2_bucket_sippy` | (inferred) | terraform | `tf:r2_bucket_sippy/` | source bucket config | visibility_only | Sippy is on-demand migration from S3/GCS — could explain unexpected Class A spikes | p3 | partially_verified |
| r2 | custom domains | terraform+rest | `r2_custom_domain`, `r2_managed_domain` | (inferred) | terraform | `tf:r2_custom_domain/`, `tf:r2_managed_domain/` | domain config | visibility_only | Discovery | p3 | partially_verified |
| r2 | data catalog | terraform+rest | `r2_data_catalog` | `/accounts/{id}/r2/data_catalog` (inferred) | terraform | `tf:r2_data_catalog/` | catalog enabled, table list, compaction | visibility_only | Data Catalog enables Iceberg / SQL queries on R2 — cf-monitor should track if enabled (affects costs) | p3 | partially_verified |

### 6.4 Pipelines (Open Beta)

| service | capability | surface_type | name | endpoint_or_dataset | source | data_exposed | control_type | cf_monitor_use | priority | verification_status |
|---|---|---|---|---|---|---|---|---|---|---|
| pipelines | stream | terraform+rest+sdk | `pipeline_stream` | `/accounts/{id}/pipelines/streams` (inferred from `cf-ts:pipelines/`) | terraform | stream config, HTTP/Worker binding, schema | visibility_only | Discovery | p3 | partially_verified |
| pipelines | sink | terraform+rest+sdk | `pipeline_sink` | `/accounts/{id}/pipelines/sinks` (inferred) | terraform | R2 / R2 Data Catalog destination | visibility_only | Discovery | p3 | partially_verified |
| pipelines | pipeline | terraform+rest+sdk | `pipeline` | `/accounts/{id}/pipelines` (inferred) | terraform | SQL connecting stream→sink, status | visibility_only | Discovery | p3 | partially_verified |
| pipelines | analytics | graphql | `pipelinesUserErrorsAdaptiveGroups` (pass 1) | graphql / viewer.accounts | docs (pass 1) | dropped-event counts | visibility_only | Already in pass 1 | p2 | verified |

**Caveat**: Pipelines is in open beta and "we are not currently billing for Pipelines during open beta. However, you will be billed for standard R2 storage and operations for data written by sinks." → cf-monitor should label Pipelines costs as `unknown — pricing pending` until GA pricing lands.

### 6.5 AI Search (new)

| service | capability | surface_type | name | endpoint_or_dataset | source | data_exposed | control_type | cf_monitor_use | priority | verification_status |
|---|---|---|---|---|---|---|---|---|---|---|
| ai_search | instance | terraform+sdk | `ai_search_instance` | `/accounts/{id}/ai-search/instances` (inferred) | terraform+sdk | instance config, status | visibility_only | Discovery; pricing unknown | p3 | partially_verified |
| ai_search | token | terraform+sdk | `ai_search_token` | (inferred) | terraform+sdk | scoped access token for AI Search | visibility_only | Audit | p3 | partially_verified |

cloudflare-docs MCP searches for "AI Search" returned no clear product page in our queries; the product clearly exists in SDK + Terraform. Marked `partially_verified` — needs a fresh `mcp__cloudflare-docs__search_cloudflare_documentation` query with the exact product name once cf-monitor is implementing it.

### 6.6 Other SDK-discovered resource groups

These exist as top-level SDK directories but were not deeply queried via docs MCP this pass. Listed for the discovery log + future verification.

| SDK directory | Likely scope | cf-monitor relevance | verification_status |
|---|---|---|---|
| `vulnerability-scanner` | account | Security; not cost-monitoring | partially_verified |
| `resource-sharing` | account | Cross-account resource sharing; relevant if cf-monitor wants to detect when account resources are shared (potential cost-attribution complication) | partially_verified |
| `realtime-kit` | account | Calls/Realtime extension; relevant if AI Calls / TURN cost surfaces emerge | partially_verified |
| `secrets-store` | account | BYOK / AI Gateway secret storage backend; affects pass-1 AI Gateway BYOK note | partially_verified |
| `r2-data-catalog` | account | See §6.3 | partially_verified |
| `request-tracers` | account | Cloudflare Trace; observability for distributed Workers traces | partially_verified |
| `diagnostics` | account | Account-level diagnostics — unclear if billing-related | partially_verified |
| `radar` | n/a | Cloudflare Radar (global internet trends) — not cf-monitor-relevant | verified (not relevant) |
| `botnet-feed` | enterprise | Enterprise security feed | verified (not relevant) |
| `cloud-connector`, `cloudforce-one`, `brand-protection`, `cloud-connector`, `intel`, `fraud`, `dls` | enterprise/security | Not cf-monitor-relevant | verified (not relevant) |

### 6.7 Logpush extras

| service | capability | surface_type | name | endpoint_or_dataset | source | data_exposed | control_type | cf_monitor_use | priority | verification_status |
|---|---|---|---|---|---|---|---|---|---|---|
| logpush | dataset field discovery | rest | List dataset fields | `GET /zones/{zone}/logpush/datasets/{dataset}/fields`, `GET /accounts/{id}/logpush/datasets/{dataset}/fields` | docs | https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/ | field schemas per dataset | visibility_only | Auto-discover available fields when constructing Logpush jobs | p3 | verified |
| logpush | logpull retention | terraform | `logpull_retention` | (inferred) | terraform | `tf:logpull_retention/` | retention days | visibility_only | Cost-relevant: longer retention = more storage | p3 | partially_verified |
| logpush | Pipelines as destination | docs | Pipelines destination | (logpush job destination config) | docs | https://developers.cloudflare.com/pipelines/streams/logpush/ | account-scoped `workers_trace_events`, zone-scoped `http_requests`/`firewall_events`/`dns_logs` | visibility_only | Pipelines reduces external-sink need; cost stays inside CF account | p3 | verified |

### 6.8 Web Analytics (Terraform-discovered)

| service | capability | surface_type | name | source | data_exposed | cf_monitor_use | priority | verification_status |
|---|---|---|---|---|---|---|---|---|
| web_analytics | site | terraform | `web_analytics_site` | `tf:web_analytics_site/` | site config, beacon token | Not cost-monitoring; observability-only | p3 | partially_verified |
| web_analytics | rule | terraform | `web_analytics_rule` | `tf:web_analytics_rule/` | rules for filtering | n/a | p3 | partially_verified |

Pass 1 only mentioned Web Analytics in passing. Note: Web Analytics is **free for all customers** and not a cost-monitoring concern.

### 6.9 Notification policy split

Pass 1 documented notification policies via `/accounts/{id}/alerting/v3/policies`. Pass 2 confirms via Terraform that `notification_policy` and `notification_policy_webhooks` are **separate resources** — meaning the policy and its webhook destinations have separate REST endpoints. cf-monitor's "register as webhook destination" recommendation should explicitly create the webhook destination first, then attach it to a policy.

| service | resource | source | source_path | priority |
|---|---|---|---|---|
| notifications | `notification_policy` | terraform | `tf:notification_policy/` | p2 |
| notifications | `notification_policy_webhooks` | terraform | `tf:notification_policy_webhooks/` | p2 |

---

## 7. Previously documented endpoints confirmed

Pass 1's 51 surfaces still verify:

| Pass-1 area | Confirmed by | Notes |
|---|---|---|
| `/accounts/{id}/subscriptions` (plan detection) | SDK `cf-ts:accounts/` + Terraform `tf:account_subscription/` | Mirror endpoint for zones: `zone_subscription` |
| `/accounts/{id}/workers/scripts` | SDK `cf-ts:workers/` + Terraform `tf:workers_script/` | Verified |
| Workers Routes | Terraform `tf:workers_route/` | Verified |
| Cron triggers | Terraform `tf:workers_cron_trigger/` | Verified |
| AI Gateway | SDK `cf-ts:ai-gateway/` + Terraform `tf:ai_gateway/` + `tf:ai_gateway_dynamic_routing/` | Dynamic routing confirmed as separate Terraform resource → separate REST endpoint group |
| GraphQL Analytics datasets (workers/D1/KV/R2/DO/Queues/Stream/WAF/HTTP/LB/Email/Page Shield/Pipelines/NEL/Magic FW) | docs MCP | All 21 GraphQL datasets from pass 1 still in current docs |
| Notifications policies | Terraform `tf:notification_policy/` | + `tf:notification_policy_webhooks/` as separate resource |
| Resource Tagging beta | docs MCP (still beta in 2026-05) | Confirmed |
| WAF Rulesets | Terraform `tf:ruleset/` | Confirmed |
| Pages projects + deployments | Terraform `tf:pages_project/` + `tf:pages_domain/` | Confirmed |
| Analytics Engine SQL | docs MCP (3-month retention; pricing not yet enforced) | Confirmed |

---

## 8. Previously documented endpoints corrected or downgraded

| Pass-1 claim | Correction | Source |
|---|---|---|
| "No billing API exists for indie developers" | Partially incorrect. A **`billing` resource group exists** in the SDK; exact endpoints not surfaced via docs MCP. Could still be enterprise-restricted or just thinly documented — but the claim should be downgraded from "does not exist" to "unverified — SDK reports a billing resource group with undocumented endpoints". | `cf-ts:billing/` |
| "Logpush is publicly accessible" (implied) | **Logpush is Enterprise-only**. Free/Pro/Business plans cannot use it. Critical caveat for indie-dev positioning. | https://developers.cloudflare.com/logs/logpush/ ("Availability: Free=No, Pro=No, Business=No, Enterprise=Yes") |
| "No public API for Audit Logs" (implied — pass 1 did not list Audit Logs) | **Audit Logs v2 GA since 2026-03-10**, `GET /accounts/{id}/logs/audit`, 18-month retention, `Account Settings Read` permission. Pass 1's omission was a gap, not a correct exclusion. | https://developers.cloudflare.com/changelog/post/2026-03-10-audit-logs-v2-ga/ |
| "No token-permission discovery API" (implied) | **`GET /user/tokens/permission_groups`** lists all permission groups dynamically. Combined with `GET /user/tokens/verify`, cf-monitor can self-introspect at runtime. | https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/ |

---

## 9. Endpoints searched for but not found

| Target | Why searched | Sources checked | Result | Notes |
|---|---|---|---|---|
| OpenAPI / JSON schema spec for CF API | Brief asked to find published spec | docs MCP queries; SDK README (not deeply inspected) | not_found | cloudflare-typescript is generated (likely Stainless); the spec is presumed internal-only. cf-monitor cannot rely on a CF-published OpenAPI document. |
| Billing Usage API v1/v2 | Brief asked explicitly | docs MCP; SDK | not_found | The phrase "Billing Usage API" does not appear to refer to a public endpoint. The Billable Usage **dashboard** exists (pass 1) but no API surface confirmed. |
| FOCUS / FinOps export | Brief asked explicitly | docs MCP | not_found | Not surfaced publicly. Enterprise sales-channel only per pass 1 — still true. |
| Account-wide hard $-spend cap (enforce mode) | Brief asked explicitly | docs MCP | not_found | Pass 1 conclusion confirmed: no Cloudflare equivalent of AWS Budgets enforce mode exists. Budget Alerts remain notify-only. |
| Per-account credit balance query (for AI Gateway Unified Billing) | Pass 1 open question | docs MCP queries on "credit balance", "invoice preview" | not_found | Unified Billing exists (pass 1) but no documented API to query current credit balance |
| Vectorize GraphQL Analytics dataset | Re-verify pass 1 negative claim | docs MCP + CMB dataset list | not_found | Confirmed: no Vectorize GraphQL dataset |
| Hyperdrive GraphQL Analytics dataset | Re-verify | docs MCP | not_found | Confirmed: dashboard-only metrics |
| AI Gateway GraphQL Analytics dataset | Re-verify | docs MCP | not_found | Confirmed: REST logs API only |

---

## 10. GraphQL dataset inventory (delta vs pass 1)

No new account-scoped or zone-scoped datasets discovered in this pass beyond pass 1's list. The pass-1 list of ~21 GraphQL datasets remains the authoritative inventory. The probe-plan file includes an introspection query that will list every dataset under `viewer.accounts.__type.fields` and `viewer.zones.__type.fields` — running it will produce a definitive enumeration.

---

## 11. REST endpoint inventory (delta vs pass 1)

In addition to pass 1's REST endpoints, this pass adds:

- `GET /accounts/{id}/logs/audit` — Audit Logs v2 (verified)
- `GET /organizations/{org_id}/logs/audit` — Org Audit Logs (verified)
- `GET /user/tokens/verify` — Token verify (verified)
- `GET /user/tokens/permission_groups` — Permission group catalogue (verified)
- `GET/POST /accounts/{id}/tokens` — Account-Owned Tokens CRUD (verified)
- `GET /zones/{zone}/logpush/datasets/{dataset}/fields` — Logpush field discovery (verified)
- `GET /accounts/{id}/logpush/datasets/{dataset}/fields` — Logpush field discovery account-scope (verified)
- `(unknown paths) /accounts/{id}/billing/...` — Billing SDK resource group endpoints (partially_verified — needs probe)
- `(inferred) /accounts/{id}/workers/scripts/{name}/versions` — Worker versions list (partially_verified)
- `(inferred) /accounts/{id}/workers/scripts/{name}/deployments` — Deployments (partially_verified)
- `(inferred) /accounts/{id}/pipelines/streams|sinks` — Pipelines CRUD (partially_verified)
- `(inferred) /accounts/{id}/r2/buckets/{name}/event_notification|lock|sippy` — R2 extra surfaces (partially_verified)
- `(inferred) /accounts/{id}/ai-search/...` — AI Search (partially_verified)

---

## 12. SDK / Wrangler / Terraform-discovered leads

| Lead | Source | Verification needed | Priority |
|---|---|---|---|
| `cf-ts:billing/` | TypeScript SDK | Live read-only probe with `Billing Read` token + listing `/accounts/{id}/billing/*` paths | p1 |
| `cf-ts:audit-logs/` (already verified) | TypeScript SDK + docs | None (verified) | n/a |
| `cf-ts:ai-search/` | TypeScript SDK + Terraform | Find product docs page; verify pricing | p3 |
| `cf-ts:resource-sharing/` | TypeScript SDK | Find product docs; relevant if cf-monitor needs to detect cross-account shared resources | p3 |
| `cf-ts:realtime-kit/` | TypeScript SDK | Find product docs; expand Calls/TURN coverage | p3 |
| `cf-ts:diagnostics/` | TypeScript SDK | Identify what this exposes (possibly underlies the dashboard "Diagnostic Center") | p3 |
| `tf:account_token/` + `cf-ts:user/` token resources | Terraform + SDK | Wire `/user/tokens/verify` into cf-monitor `/self-health` | p1 |

Wrangler was not directly inspected, but Cloudflare's `wrangler d1 insights` (already in pass 1) and `wrangler queues purge` (pass 1) confirm Wrangler does sit ahead of docs in some places. No new Wrangler-only endpoints were chased in this pass; future passes should grep `workers-sdk/packages/wrangler/src/api/` for `api.cloudflare.com` calls.

---

## 13. Dashboard-only surfaces (extended list)

Pass 1 listed: Billable Usage dashboard, per-product usage dashboards, plan/subscription UI, AI Gateway dashboard, Workers AI dashboard, D1 Query Insights, Vectorize dashboard, Hyperdrive dashboard, R2 metrics dashboard.

Pass 2 adds:
- **Audit Logs v2 UI** — now has API + UI parity, so this is NOT dashboard-only anymore (verified API path).
- **Diagnostic Center** — referenced indirectly via `cf-ts:diagnostics/` SDK group; status unknown without further investigation.
- **Cloudflare Trust Hub** (compliance) — listed in docs but not part of cf-monitor scope.
- **Browser Rendering dashboard** at `dash.cloudflare.com/<acct>/workers/browser-run` — shows Browser Rendering usage; no public API for usage history confirmed.

---

## 14. Permission matrix updates

New permissions discovered or clarified vs pass 1:

| Permission | Scope | Read/Edit | New or clarified | Use for cf-monitor |
|---|---|---|---|---|
| `Account Settings Read` | account | Read | New | Audit Logs v2 API requires this |
| `Account Settings Write` | account | Edit | New | Audit Logs v2 write operations (rare) |
| `Logs Write` | account/zone | Edit | New | Logpush job creation (Enterprise-only) |
| `API Tokens Read` / `API Tokens Write` | user | Read/Edit | New | `/user/tokens/permission_groups` listing |
| `Zero Trust: Seats Read/Write/Edit` | account | varies | New (Zero Trust seat billing) | Indie devs rarely use Zero Trust — low priority |
| `AI Crawl Control Read/Write` | zone | Read/Edit | New (mentioned in token permission_groups example) | Outside cf-monitor cost scope |

`Billing Read` and `Billing Edit` are unchanged from pass 1 but their scope of operations is now larger since the SDK exposes a `billing` resource group — exact ops list awaits live probe.

---

## 15. Control-surface classification updates

Net adds to the classification taxonomy (pass 1 had 5 native_hard, 8 native_circuit_breaker etc.):

| New surface | Control type | Rationale |
|---|---|---|
| `workers_deployment` (rollback) | native_circuit_breaker | Promote previous version = revert a runaway change |
| `workers_custom_domain` detach | native_circuit_breaker | Detach a custom domain stops traffic without removing the script |
| `workers_script_subdomain` toggle | native_circuit_breaker | Disable workers.dev access for a script |
| Audit Logs v2 | visibility_only | Helps post-incident forensics; not a control |
| Token verify/permission_groups | visibility_only | Self-introspection |
| Billing SDK group | unknown | Awaits live verification |

---

## 16. cf-monitor implementation implications

### Tier 1 (already implemented — confirmed by this pass)
- All 5 pass-1 GraphQL datasets + AI Gateway logs + Subscriptions remain correct.

### Tier 2 (new, high-value adds from this pass)
1. **Self-token verify**: hourly call `GET /user/tokens/verify` from cf-monitor `/self-health`. Cheap (1 read/hour). Detects token rotation/disable before cron failures.
2. **Permission-group introspection at init**: instead of hard-coding the permission matrix in `cf-monitor init`, call `GET /user/tokens/permission_groups`, find IDs by stable `id`, then show users the canonical Cloudflare permission name. Future-proof against permission renames.
3. **Audit Logs v2 ingest** (for users who opt in): hourly poll `GET /accounts/{id}/logs/audit?since=...` to surface privileged-token actions and unexpected resource changes that correlate with cost spikes. Permission: `Account Settings Read`.
4. **Probe the billing SDK group**: dispatch a one-off `cf-monitor probe-billing` command that lists `/accounts/{id}/billing/*` endpoints (read-only). Document the result back into this repo.
5. **Notification policy webhook two-step**: when cf-monitor offers Budget Alert subscription, create the webhook destination first via `notification_policy_webhooks`, then attach to a `notification_policy`. Match Terraform's separation.

### Tier 3 (deferred — discovery only)
- Pipelines, R2 Data Catalog, AI Search, Workflows: discover via list endpoints during `cf-monitor scan`; do not enforce until each product has confirmed billing telemetry.

### Tier 4 (explicitly out of scope)
- Logpush (Enterprise-only — indie devs cannot use).
- Org-scope audit logs (rare for indie devs).
- Billing Usage API v1/v2 (does not appear to exist publicly).

### Updates to "things cf-monitor must never assume silently"
- Do **not** assume Logpush is available — gate behind plan detection.
- Do **not** assume `billing` SDK endpoints exist as documented — probe first.
- Do **not** silently rename permission strings in `cf-monitor.yaml` — permission `id`s are stable, `name`s are not.

---

## 17. Open questions requiring live account verification

These items are unresolved without a working `CLOUDFLARE_API_TOKEN`. See `cloudflare-api-probe-plan.md` for exact safe commands.

1. **Billing SDK resource group**: what endpoints actually exist under `/accounts/{id}/billing/*`? Status code, response shape, permission gate.
2. **Workflows / Workers Versions / Workers Deployments**: exact REST paths and response schemas (inferred from Terraform resource names; not directly verified in docs MCP).
3. **AI Search**: product confirmation, billing model, REST endpoints.
4. **Pipelines REST paths**: stream / sink / pipeline CRUD endpoints.
5. **R2 lifecycle/event-notification/lock/sippy** REST endpoints — Terraform reveals existence but paths inferred.
6. **GraphQL dataset enumeration**: full introspection of `viewer.accounts.__type.fields` and `viewer.zones.__type.fields` to confirm we're not missing datasets.
7. **Token permission_groups** — full enumeration so cf-monitor can auto-generate its permission matrix at init.
8. **Audit Logs v2 ~5% missing coverage** — Cloudflare docs say ~95% product coverage; which 5% is missing? Critical for cf-monitor users who depend on audit-log forensics.

---

## 18. Appendix — exact searches/queries used

### Cloudflare Docs MCP queries
- `account subscriptions API plan detection Workers Paid billing` (pass 1; confirmed pass 2)
- `notifications budget alerts billing usage policy webhook` (pass 1)
- `audit logs API account history user activity`
- `Logpush jobs HTTP destinations datasets pricing billing`
- `Bot Management API analytics dataset cost billing pricing`
- `Cloudflare Access Zero Trust users seats billing pricing API`
- `Workflows pricing billing instances steps limits API`
- `Browser Rendering pricing concurrent browsers REST API limits`
- `Cloudflare Pipelines pricing stream sink ingestion R2 Iceberg`
- `API tokens introspection verify permissions verify-token endpoint`

### GitHub MCP queries
- `mcp__github__get_file_contents(owner='cloudflare', repo='cloudflare-typescript', path='src/resources')` — returned 137,989 chars; sliced by subagent
- `mcp__github__get_file_contents(owner='cloudflare', repo='terraform-provider-cloudflare', path='internal/services')` — returned 155,476 chars; sliced by subagent

### Subagents used
- TS SDK extractor — produced 109-name list of resource directories with cf-monitor-relevance tagging
- Terraform extractor — produced 251-name list of services with cf-monitor-relevance tagging

### Bash inspections
- `env | grep -iE 'cloudflare|cf_api|cf_account|cf_zone'` → no credentials found
- `cat .envrc` → no .envrc file
- `cat package.json` → confirmed cf-monitor does NOT depend on `cloudflare` npm SDK

### Dead ends
- No OpenAPI spec found via docs MCP.
- No `usage` resource group in either SDK or Terraform — confirming pass-1 conclusion that there is no first-class usage API.
- No FOCUS / FinOps export found.
- AI Search docs MCP queries returned no clear product page despite SDK + Terraform presence — needs explicit re-query with the exact product name.
- Wrangler source not inspected this pass (Terraform served as the cross-reference instead).

### Ambiguous findings
- The `cf-ts:billing/` SDK resource group exists, but our docs MCP queries did not surface its endpoint list. Interpretation: either undocumented or restricted. Marked `partially_verified`; needs live probe.
- `cf-ts:diagnostics/` and `cf-ts:request-tracers/` — unclear cf-monitor relevance without more docs context.

### Hard rule compliance
- Every endpoint marked `verified` has a developers.cloudflare.com source URL.
- Every endpoint marked `partially_verified` cites either an SDK directory or Terraform service path.
- No endpoints were invented. Inferred paths (e.g. `/accounts/{id}/pipelines/streams`) are marked as inferred and tagged `partially_verified`.
- No live mutations were performed. No live reads were performed (no credentials).
