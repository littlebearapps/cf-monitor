# Cloudflare API Surface — Delta (Pass 1 → Pass 2)

**Generated**: 2026-05-27
**Pass 1**: [`cloudflare-api-surface.md`](./cloudflare-api-surface.md) + [`.json`](./cloudflare-api-surface.json)
**Pass 2**: [`cloudflare-api-surface-deep-dive.md`](./cloudflare-api-surface-deep-dive.md) + [`.deep.json`](./cloudflare-api-surface.deep.json)

This document is the most important output of pass 2. It answers the brief's 8 delta questions.

---

## Headline: what changed

- **New surfaces discovered**: 21 (Audit Logs v2 GA, billing SDK group, token verify, token permission_groups list, account-owned tokens CRUD, worker_version/deployment/secret/custom_domain/script_subdomain, R2 lifecycle/event/lock/sippy/managed-domain, Pipelines stream/sink/pipeline, R2 Data Catalog, AI Search, Web Analytics, notification_policy_webhooks split, Logpush field discovery, Logpull retention)
- **Surfaces confirmed**: 47 of pass-1's 51
- **Corrections / downgrades to pass 1**: 4
- **No-go surfaces confirmed**: 8 (see §3)
- **New permissions added to the matrix**: 5

---

## 1. New high-value surfaces

These deserve a `p1` or `p2` slot in cf-monitor's roadmap.

### 1.1 Audit Logs v2 (p2)

**Endpoint**: `GET /accounts/{account_id}/logs/audit`
**Permission**: `Account Settings Read`
**Retention**: 18 months
**Status**: GA since 2026-03-10

**Why high value**: cf-monitor's existing `/usage` view shows *what was consumed*. Audit Logs v2 shows *who did it and when* — the missing piece for correlating a cost spike with a privileged-token action (e.g. someone enabled R2 Sippy migration last night). Indie devs typically don't have org-level audit visibility; this is the first time CF gives them parity with Enterprise.

**Implementation**: hourly poll `?since=<last_seen>` from a new `collect-audit-events` cron handler. Write to AE under `blob1="audit"`. Surface in dashboard alongside cost spikes. Strictly opt-in (privacy: token actions include user IDs).

**Open question**: which ~5% of Cloudflare products are still NOT covered by Audit Logs v2? Critical for users who rely on full forensics.

### 1.2 API token verify (p1)

**Endpoint**: `GET /user/tokens/verify`
**Permission**: none (token authenticates itself)

**Why high value**: cf-monitor's `/self-health` cron should hourly check that its own token is still valid. Cheap (1 read/hour, no usage drift). Detects rotation/disable before a cron fails silently.

**Important detail from docs**: token IP/TTL restrictions do **not** apply to this endpoint — so cf-monitor's worker can call it from any CF colo without being affected by a token's IP allowlist.

### 1.3 API token permission_groups list (p2)

**Endpoint**: `GET /user/tokens/permission_groups`
**Permission**: `API Tokens Read`

**Why high value**: pass 1's permission matrix is hard-coded in `cloudflare-api-surface.md`. Cloudflare docs explicitly say: *"the permission `name` is cosmetic and subject to change"*. cf-monitor should fetch this list at install time, store the stable `id`s in its config, and show the canonical (current) name in CLI output.

### 1.4 Browser Rendering cost surface (p2)

Pass 1 mentioned Browser Rendering in passing; pass 2 fully documents it. Indie devs running Puppeteer/Playwright via Browser Rendering can rack up $0.09/browser-hour silently — long-running session that doesn't close = cumulative charges.

**Recommendation**: extend the runtime binding proxy to track Browser Rendering session duration, surface a "browser hours so far this month" metric in `/usage`. Workers Paid REST API rate limit is now 10 req/sec on Paid (3x the previous 3 req/sec).

### 1.5 Workers deployment rollback (p2)

**Resources**: `worker_version`, `workers_deployment` (Terraform-confirmed; REST paths inferred — needs live verification).

**Why high value**: pass 1's emergency actions were destructive (detach route, deploy safe-mode no-op). Rolling back to a previous version is **less destructive** — preserves the worker, just reverts code. cf-monitor's emergency CLI should expose `cf-monitor rollback <worker>` before `cf-monitor disable <worker>`.

### 1.6 Billing SDK resource group (p1 — unknown payoff)

**SDK path**: `cloudflare-typescript/src/resources/billing/`
**Status**: existence confirmed; endpoints not surfaced via docs MCP

This is the single most material unknown from pass 2. Pass 1 stated "no billing API exists for indie developers". The TypeScript SDK contradicts this by exposing a `billing` resource group. Three possibilities:
1. Endpoints exist but are restricted (enterprise / approval-required).
2. Endpoints exist but are undocumented (cf-monitor could be the first public consumer).
3. The SDK group is a placeholder.

**Recommendation**: write a `cf-monitor probe-billing` command that lists `/accounts/{id}/billing/*` with a read-only `Billing Read` token, captures the responses verbatim, and contributes results back to this repo. Should be one-time, not a cron.

---

## 2. New low-value surfaces

Discovered but probably not worth implementing.

| Surface | Why low value |
|---|---|
| **Logpush field-discovery + Logpull retention** | Logpush is Enterprise-only. Indie devs (cf-monitor's audience) cannot use either. |
| **R2 Data Catalog / Pipelines** | Open beta; Cloudflare not currently billing. Re-evaluate once pricing GA. |
| **Web Analytics resources** | Free product; not cost-relevant. |
| **AI Search** | Pricing model unknown; not yet relevant. |
| **R2 sippy / event-notifications / lock** | Useful as scan-time *flags* (cost-spike root-cause hints), but no recurring telemetry value. |
| **Workers `workers_secret` / `workers_script_subdomain`** | Visibility-only; could be `cf-monitor scan` outputs but not core paths. |
| **Org-scope audit logs** | Indie devs rarely in orgs. |
| **Workers for Platforms custom limits** | Already mentioned in pass 1; relevant only for dispatch-Worker users. |

---

## 3. Confirmed no-go surfaces

These were searched again in pass 2 and confirmed not-publicly-available.

| Surface | Why no-go |
|---|---|
| **Account-wide $-spend hard cap** | No CF equivalent of AWS Budgets enforce mode. Confirmed. |
| **Public OpenAPI / JSON-schema spec download** | Not published. cloudflare-typescript SDK is presumed generated from an internal spec. |
| **Billing Usage API v1/v2** | Phrase does not match any documented public endpoint. |
| **FOCUS / FinOps export** | Enterprise sales-channel only. |
| **AI Gateway credit balance read API** | Unified Billing exists but balance read not surfaced. |
| **Vectorize / Hyperdrive / AI Gateway / Workflows / Cache Reserve GraphQL Analytics datasets** | All confirmed absent. |
| **Per-script cost API (vs per-account)** | Workers cost surfaces only at account level. Per-script attribution = GraphQL `workersInvocationsAdaptive`. |
| **Logpush for PAYG** | Enterprise-only. |

---

## 4. Corrections to previous research

### Correction A: "No billing API exists" → "Billing SDK resource group exists; endpoints unverified"

**Pass 1 claim**: cf-monitor must rely on `/subscriptions` + GraphQL + static allowance catalogue because *no billing API exists for indie developers*.

**Pass 2 correction**: A `billing` resource group exists in the cloudflare-typescript SDK. We could not enumerate its endpoints via docs MCP. The claim "no billing API exists" should be **downgraded to "no billing API is documented in product prose; SDK indicates one exists; live verification required"**.

This is the strongest reason for a follow-up live-probe pass.

### Correction B: Logpush availability

**Pass 1 implication**: Logpush was treated as generally available (cited in passing under "Observability/logging").

**Pass 2 correction**: Logpush is **Enterprise-only** (`Free=No, Pro=No, Business=No, Enterprise=Yes`). Indie devs cannot use Logpush. cf-monitor must not suggest Logpush as a remediation path for PAYG users.

### Correction C: Audit Logs omission

**Pass 1**: did not mention Audit Logs.

**Pass 2**: Audit Logs v2 went GA on 2026-03-10 with a public API. This is a high-value capability that pass 1 missed.

### Correction D: Notification policy webhooks are a separate resource

**Pass 1**: described notification policies + webhook destinations as a combined surface.

**Pass 2**: Terraform models them as **two separate resources** (`notification_policy`, `notification_policy_webhooks`). cf-monitor's "register as webhook destination for Budget Alerts" recommendation must explicitly perform a two-step create.

---

## 5. Changes to implementation roadmap

| Pass-1 tier | Item | Change |
|---|---|---|
| Tier 1 (done) | Subscriptions, 5 GraphQL datasets, AI Gateway logs, scripts list, runtime proxies | **No change** — confirmed. |
| Tier 2 (next) | Queues realtime backlog REST | **No change** — still p2 |
| Tier 2 (next) | Vectorize stored-vector polling | **No change** — still p2 |
| Tier 2 (next) | Pages projects discovery | **No change** — still p2 |
| Tier 2 (next) | Budget Alert webhook subscription | **Refine** — two-step (webhook destination then policy attachment) |
| Tier 2 (next) | Confidence labels on `/usage` | **No change** |
| **NEW Tier 1** | Probe `/accounts/{id}/billing/*` (one-shot via `cf-monitor probe-billing` command) | **New, high-priority** |
| **NEW Tier 2** | Hourly `GET /user/tokens/verify` from /self-health | **New** |
| **NEW Tier 2** | Auto-generate permission matrix at init via `/user/tokens/permission_groups` | **New** |
| **NEW Tier 2** | Hourly Audit Logs v2 ingest (opt-in) | **New** |
| **NEW Tier 2** | Browser Rendering cost guard (binding proxy + REST rate-limit awareness) | **New** |
| **NEW Tier 2** | Workers rollback control (worker_version + workers_deployment endpoints) | **New** |
| Tier 4 (unsupported) | Account-wide spend cap | **No change** — still does not exist |
| Tier 4 (unsupported) | Logpush integration | **Reinforced** — confirmed Enterprise-only |

---

## 6. Required live verification

cf-monitor cannot ship the new Tier-1 / Tier-2 work without verifying these against a live account. The probe-plan file ([`cloudflare-api-probe-plan.md`](./cloudflare-api-probe-plan.md)) lists exact safe commands. Specifically:

1. `/accounts/{id}/billing/*` enumeration with `Billing Read` token.
2. `/user/tokens/verify` and `/user/tokens/permission_groups` round-trip.
3. Audit Logs v2 first call: `/accounts/{id}/logs/audit?per_page=10` with `Account Settings Read`.
4. GraphQL `__type` introspection on `viewer.accounts` + `viewer.zones`.
5. Inferred Worker endpoints: `/workers/scripts/{name}/versions` and `/deployments`.
6. Inferred R2 endpoints: bucket lifecycle/lock/event-notification/sippy.

---

## 7. Cloudflare permissions to add or clarify

Add to cf-monitor's read-only default token requirements (only when the feature is enabled):

- `Account Settings Read` (for Audit Logs v2)
- `API Tokens Read` (for permission_groups list)
- (None new for `GET /user/tokens/verify` — token authenticates itself)

Add to cf-monitor's opt-in controller token (only for emergency actions):

- `Workers Scripts Edit` (already in pass 1) — also covers worker_version + workers_deployment + workers_secret + workers_custom_domain
- `Notifications Write` (already in pass 1) — covers the two-step webhook + policy creation

No new permissions needed for the *highest-priority* additions (token verify, Audit Logs v2 read).

---

## 8. Implementation priority changes

Net effect on cf-monitor's tier list:

- **Tier 1 (new)**: `cf-monitor probe-billing` one-shot command — verify if `/accounts/{id}/billing/*` exists publicly. Highest unknown payoff in this pass.
- **Tier 1 (continued)**: hourly token verify for /self-health.
- **Tier 2 (new)**: permission-matrix auto-generation, Audit Logs v2 ingest, Browser Rendering guard, Workers rollback control.
- **Tier 3 (deferred)**: Pipelines / R2 Data Catalog / AI Search discovery.
- **Tier 4 (never)**: Logpush integration — confirmed Enterprise-only.

---

## 9. Updated recommended next implementation prompt

> Given pass-2 research at `docs/research/cloudflare-api-surface-deep-dive.md` and the delta at `cloudflare-api-surface-delta.md`, implement the **Tier-1 and Tier-2 additions in two PRs**:
>
> **PR 1 — Visibility additions** (read-only token, no behaviour change):
> 1. Add hourly `GET /user/tokens/verify` to the `/self-health` endpoint. Cache result in KV (`self:v1:token:status`, 70-min TTL). Fail open on any error; surface as 503 if status != "active".
> 2. Add a one-shot `cf-monitor probe-billing` CLI command that hits `/accounts/{id}/billing/`, `/accounts/{id}/billing/profile`, `/accounts/{id}/billing/history`, and any other paths the SDK suggests (use `mcp__github__get_file_contents(cloudflare/cloudflare-typescript, src/resources/billing/index.ts)` to enumerate). Write raw responses to `./billing-probe.json` and remind the user to PR them back to `docs/research/`.
> 3. Add a `collect-audit-events` cron (hourly, opt-in via `cf-monitor.yaml: audit_logs.enabled: true`) that polls `GET /accounts/{id}/logs/audit?since=<last_seen>`. Write to AE under `blob1="audit"`. Surface `event_count_24h` in `/usage`. Require explicit user opt-in because audit logs contain user IDs.
> 4. Modify the `cf-monitor init` flow: when constructing the suggested API token, first call `GET /user/tokens/permission_groups`, find the IDs for the required permissions by stable `id`, and use those IDs (not names) in the token template URL.
>
> **PR 2 — Native control additions** (opt-in controller token only):
> 5. Add a `cf-monitor rollback <worker>` CLI command using `worker_version` + `workers_deployment` endpoints. Require `--confirm` flag. Show diff between current and target version before applying.
> 6. Modify the existing Budget Alert subscription flow into a **two-step create**: first POST to `/accounts/{id}/alerting/v3/destinations/webhooks`, then attach to a new policy via `/accounts/{id}/alerting/v3/policies`. Reflect Terraform's split.
>
> **Constraints**: keep all additions fail-open. New cron handlers must respect existing per-invocation request limits. Label every new cost number with confidence (`billing_authoritative`, `analytics_estimate`, `runtime_metered`). Do **not** add Logpush integration — confirmed Enterprise-only.
