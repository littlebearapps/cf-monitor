# Cloudflare API Discovery Log — Pass 2

**Generated**: 2026-05-27
**Purpose**: Exact searches, queries, files inspected, and dead ends from the deep-dive pass. Future maintainers can re-run any of these to refresh the inventory.

---

## Cloudflare Docs MCP queries (in order issued)

All issued via `mcp__cloudflare-docs__search_cloudflare_documentation(query: <text>)`.

1. `account subscriptions API plan detection Workers Paid billing` — confirmed pass-1 finding, surfaced billing permissions page
2. `notifications budget alerts billing usage policy webhook` — confirmed Budget Alerts (Apr 2026), Pay-as-you-go only
3. `billing usage API account billable metrics invoice REST endpoint` — surfaced billing-permissions page; no public Billing Usage API found
4. `Workers plan free paid standard usage model included allowance` — confirmed Standard usage model default since 2023-10-30
5. `GraphQL Analytics API endpoint datasets account level zone level introspection` — surfaced introspection docs + Email Service zone-scoped datasets
6. `AI Gateway billing spending limit rate limit Bring Your Own Key BYOK` — surfaced BYOK, rate-limiting, dynamic routing docs
7. `R2 buckets storage class A class B operations infrequent access metrics` — surfaced full R2 pricing + storage classes
8. `workersInvocationsAdaptive d1AnalyticsAdaptiveGroups kvOperationsAdaptiveGroups r2OperationsAdaptiveGroups` — confirmed dataset coverage
9. `Workers script settings API cron triggers tail consumers update placement` — surfaced cron triggers, Workers for Platforms custom limits
10. `Vectorize REST API metrics index list query pricing` — surfaced Vectorize REST + pricing pages
11. `Queues API purge consumer concurrency backlog metrics queueBacklogAdaptiveGroups` — surfaced realtime backlog endpoint + GraphQL datasets
12. `Durable Objects metrics storage alarms WebSockets billing pricing` — surfaced DO pricing + WebSocket 20:1 ratio
13. `Notifications API policies create alert types webhook destinations` — confirmed webhook payload schema + generic webhook IP/port restrictions
14. `resource tag account tags Workers KV R2 D1 add update API` — surfaced Resource Tagging public beta announcement
15. `workers analytics engine retention pricing SQL query limits` — surfaced AE limits (250 data points/invocation, 3-month retention)
16. `Images Stream metrics analytics billing GraphQL dataset` — surfaced Stream GraphQL datasets, Images pricing
17. `Cloudflare API token permissions list workers KV D1 R2 read edit` — surfaced full token permissions reference
18. `AI Gateway create gateway POST cache logging unified billing` — surfaced AI Gateway create endpoint, Unified Billing changelog
19. `Cloudflare Pages projects deployments API GraphQL pagesFunctionsInvocations` — surfaced Pages REST + Pages Functions metrics
20. `workers script content settings api PUT subdomain enabled disable cron` — surfaced Workers for Platforms custom limits + script subdomain docs
21. **PASS-2 ADDS START**
22. `audit logs API account history user activity` — **major find**: Audit Logs v2 GA 2026-03-10, REST API path, 18-month retention, `Account Settings Read` permission, Logpush dataset
23. `Logpush jobs HTTP destinations datasets pricing billing` — confirmed Logpush is **Enterprise-only** (Free/Pro/Business=No)
24. `Bot Management API analytics dataset cost billing pricing` — returned no useful hits this query (Bot Mgmt billing surfaces are dashboard-only for cost; firewall analytics dataset covers events)
25. `Cloudflare Access Zero Trust users seats billing pricing API` — surfaced Zero Trust seat management + `Zero Trust: Seats Read/Write/Edit` permissions
26. `Workflows pricing billing instances steps limits API` — confirmed Workflows billed as Workers; 25K steps + 50K concurrent instance raises (Mar/Apr 2026)
27. `Browser Rendering pricing concurrent browsers REST API limits` — confirmed $0.09/browser-hour pricing, 10 req/sec rate limit (Mar 2026)
28. `Cloudflare Pipelines pricing stream sink ingestion R2 Iceberg` — confirmed Pipelines open beta, Terraform support since Apr 2026, no billing yet beyond R2
29. `API tokens introspection verify permissions verify-token endpoint` — **major find**: `/user/tokens/verify` + `/user/tokens/permission_groups` endpoints

---

## GitHub MCP queries

1. `mcp__github__get_file_contents(owner='cloudflare', repo='cloudflare-typescript', path='src/resources')`
   - Returned 137,989 chars (oversized).
   - Saved to `/home/nathan/.claude/projects/.../tool-results/mcp-github-get_file_contents-1779877391329.txt`.
   - Sliced by general-purpose subagent.
   - **Output**: 109 top-level resource directories — see `cloudflare-api-surface-deep-dive.md` §6.6.

2. `mcp__github__get_file_contents(owner='cloudflare', repo='terraform-provider-cloudflare', path='internal/services')`
   - Returned 155,476 chars (oversized).
   - Saved to `/home/nathan/.claude/projects/.../tool-results/mcp-github-get_file_contents-1779877392378.txt`.
   - Sliced by general-purpose subagent.
   - **Output**: 251 service subdirectories — see `cloudflare-api-surface-deep-dive.md` §6.

---

## Subagents dispatched

| Agent type | Task | Token usage |
|---|---|---|
| general-purpose | Slice + summarise cloudflare-typescript src/resources/ listing | ~82K tokens |
| general-purpose | Slice + summarise terraform-provider-cloudflare internal/services/ listing | ~88K tokens |

Both agents reported back with alphabetised resource lists and cf-monitor-relevance flagging.

---

## Bash inspections

```bash
# Credential availability check
env | grep -iE '(cloudflare|cf_api|cf_account|cf_zone)' | sed 's/=.*/=<redacted>/'
# Result: no CF env vars present

# .envrc check
ls -la .envrc 2>/dev/null
# Result: no .envrc in repo root

# Package dependency check
cat package.json | head -40
# Result: cf-monitor does NOT depend on the `cloudflare` npm SDK
```

---

## GraphQL introspection queries prepared (not run — no creds)

Saved in `cloudflare-api-probe-plan.md`. Key queries:

```graphql
# Enumerate every account-scoped dataset
{ __type(name: "AccountsViewer") { fields { name type { name kind } } } }

# Enumerate every zone-scoped dataset
{ __type(name: "ZonesViewer") { fields { name type { name kind } } } }

# Look for billing/usage/cost-related field names
{ __schema { types { name fields { name } } } }
# Then grep for: cost, usage, bill, billed, charge, request, cpu, duration, storage,
# bytes, rows, operations, invocations, errors, subrequests, tokens, neurons,
# backlog, concurrency, transformations, minutes, cache, bandwidth
```

---

## Dead ends (recorded honestly)

| Search target | Where searched | Why dead end |
|---|---|---|
| Public CF OpenAPI spec download | docs MCP | Not published. cloudflare-typescript SDK is generated (likely via Stainless) from an internal spec. |
| Billing Usage API v1/v2 | docs MCP | Phrase does not match any documented endpoint. |
| FOCUS / FinOps export | docs MCP | Enterprise sales-channel only. |
| Account-wide $-spend cap (enforce mode) | docs MCP, Terraform | No CF primitive exists. Confirmed second pass. |
| Per-account credit balance read (Unified Billing) | docs MCP | Not surfaced. Open question for live probe. |
| Vectorize / Hyperdrive / AI Gateway / Workflows / Cache Reserve GraphQL Analytics datasets | docs MCP | Confirmed absent. |
| Per-script Workers cost API | docs MCP, SDK | Workers cost surfaces only at account level. |
| Workers Logs cost API | docs MCP | Workers Logs pricing exists but specific cost/usage API not surfaced. |
| AI Search docs page | docs MCP | Existence confirmed in SDK + Terraform but no docs page returned by our queries. Needs explicit product-name re-search. |
| `cf-ts:diagnostics/`, `cf-ts:request-tracers/` SDK groups | docs MCP | No clear product page tied to these names. |
| Wrangler source-level grep for `/accounts/` `/zones/` API paths | not run | Skipped this pass; Terraform serves as cross-reference. |
| Cloudflare Python / Go SDK source trees | not run | TypeScript SDK presumed authoritative. |

---

## Ambiguous findings (flagged for live verification)

1. **`cf-ts:billing/` resource group** — exists in SDK but endpoints not in docs. Three possibilities: restricted, undocumented, or placeholder. Probe required.
2. **Inferred Worker REST paths** (`/workers/scripts/{name}/versions`, `/deployments`) — Terraform resource names imply paths but docs do not confirm.
3. **Inferred Pipelines REST paths** (`/pipelines/streams|sinks|pipelines`) — same.
4. **Inferred R2 endpoint paths** (lifecycle, event_notification, lock, sippy) — Terraform-confirmed existence; paths inferred.
5. **AI Search** — product existence confirmed via SDK + Terraform; pricing model and docs page not located in our queries.
6. **`cf-ts:diagnostics/` SDK group** — unclear whether this exposes user-facing data or internal infra.

---

## Assumptions that were deliberately avoided

- We did **not** assume that an SDK resource group's existence implies a public API path. Inferred paths are marked `partially_verified` and tagged for live probe.
- We did **not** treat Terraform provider resources as proof of public API. Used as cross-reference only.
- We did **not** assume Logpush is available to PAYG users. Verified Enterprise-only.
- We did **not** assume pass-1 claims were exhaustive. Pass 2 found 21 new surfaces and 4 corrections.

---

## What to re-run for a pass 3

A maintainer planning a third pass should:

1. **Run the probe-plan with a read-only token** — closes the billing-SDK + inferred-path unknowns.
2. **Grep `cloudflare/workers-sdk/packages/wrangler/src/api/` for `api.cloudflare.com`** — surfaces endpoints used by Wrangler but not in docs.
3. **Inspect cloudflare-python SDK resource tree** as cross-reference (SDKs are auto-generated; deltas between TS and Python are unlikely but possible).
4. **Re-query docs MCP with exact AI Search product name** — likely "AI Search" or "AISearch" once Cloudflare publishes a product page.
5. **Watch the changelog** at `developers.cloudflare.com/changelog/` for billing/usage/budget entries. Pass 2 found at least one major addition (Audit Logs v2 GA) that pass 1 missed by 2 months.
6. **Re-check Vectorize / Hyperdrive / AI Gateway / Workflows / Cache Reserve** for GraphQL datasets in 6 months — these may add them.

---

## Credentials availability

No `CLOUDFLARE_API_TOKEN`, no `CLOUDFLARE_ACCOUNT_ID`, no `CLOUDFLARE_ZONE_ID` were available in this session's environment. All probe queries were therefore *prepared, not executed*. See `cloudflare-api-probe-plan.md` for the exact commands.
