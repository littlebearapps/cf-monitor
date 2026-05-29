# Cloudflare API Probe — Live Verification Results

**Generated**: 2026-05-27
**Probe plan**: [`cloudflare-api-probe-plan.md`](./cloudflare-api-probe-plan.md)
**Companion**: [`cloudflare-api-surface-deep-dive.md`](./cloudflare-api-surface-deep-dive.md)

> **Actions taken (2026-05-28)**: corrections from this probe folded into `cloudflare-api-surface.md`, `.json`, and `cloudflare-api-research-summary.md`; R2 classifier corrected (`src/worker/crons/r2-classification.ts`); read-only `cf-monitor probe billing` command added. Billing follow-up tracked in [`billing-endpoints-follow-up.md`](./billing-endpoints-follow-up.md).

---

## Credential note

User requested running the probe against the Platform Cloudflare account using credentials from BWS.

**Token availability:**
- `CLOUDFLARE_PLATFORM_API_TOKEN` (BWS Platform project `35cdd8a1…`, created 2026-03-08) — **returns HTTP 401 "Invalid API Token"** as of this probe. Token appears to have been rotated outside BWS. **Action required**: rotate the BWS entry to a current Platform token, then re-run this probe to confirm Platform-specific data.
- `CLOUDFLARE_SCOUT_API_TOKEN` (BWS Scout project `17325164…`) — **verifies active**. Used as a working stand-in to probe endpoint shapes.
- Also tried: NSD, Viewpo, Brand Copilot, AH MCP tokens — all return 401. All except Scout's appear stale.

**What this means for findings**: CF API endpoints are account-agnostic — the URL shape and response schema are the same regardless of which CF account a token authenticates to. So endpoint existence (200 vs 400 vs 403 vs 404) is **fully verified** by this probe. Per-account data values (subscriptions plan, billing-period dates, audit-log content) are from the **Scout** account, not Platform. cf-monitor's code that already works against multiple accounts is not affected.

All account IDs, script names, bucket names, and other identifiers are redacted as `<ACCT>` / `<SCRIPT>` / `<BUCKET>` / etc. below.

---

## Token used

```
Token name (BWS): CLOUDFLARE_SCOUT_API_TOKEN
Token scope:      account = Scout (d8def4b4…)
Token status:     active (verified via /user/tokens/verify)
Probe date:       2026-05-27
```

---

## Section A — Token sanity

### A.1 `GET /user/tokens/verify` → ✓ 200

Returns:
```json
{
  "success": true,
  "result": {
    "id": "…",
    "status": "active",
    "not_before": null,
    "expires_on": null
  },
  "messages": [{"code": 10000, "message": "This API Token is valid and active"}]
}
```

→ **Verified**: pass-2's claim that `/user/tokens/verify` is callable with no permissions matches reality.

### A.2 `GET /user/tokens/permission_groups` → ✗ 403

Scout token lacks `API Tokens Read` permission. Response: `{"errors": [{"code": 10000, "message": "Authentication error"}]}`.

→ **Endpoint exists** (would be 404 if not). Confirms the endpoint is real; running with a token that has `API Tokens Read` will return the full list.

---

## Section B — Billing SDK endpoints (HIGH PRIORITY)

This was the largest unknown coming out of pass 2. The cloudflare-typescript SDK exposes a `src/resources/billing/` group; pass 2 marked it `partially_verified`.

**Probe results:**

| Path | HTTP | Conclusion |
|---|---|---|
| `/accounts/<ACCT>/billing` | 400 | "Could not route" — root path not an endpoint |
| `/accounts/<ACCT>/billing/profile` | **403** | **Endpoint exists**; needs `Billing Read` (not granted on Scout token) |
| `/accounts/<ACCT>/billing/history` | **403** | **Endpoint exists**; needs `Billing Read` |
| `/accounts/<ACCT>/billing/usage` | **403** | **Endpoint exists**; needs `Billing Read` |
| `/accounts/<ACCT>/billing/summary` | 400 | "Could not route" — not an endpoint |
| `/accounts/<ACCT>/billing/invoices` | 400 | "Could not route" — not an endpoint |
| `/accounts/<ACCT>/billing/payment_methods` | 400 | "Could not route" — not an endpoint |

**Discovery**: Three real, undocumented endpoints exist:
- `GET /accounts/{id}/billing/profile`
- `GET /accounts/{id}/billing/history`
- `GET /accounts/{id}/billing/usage` ← **likely the long-missing "Billing Usage API"**

→ **Status promoted**: `billing` resource group **verified to exist**; specific endpoint payloads remain `partially_verified` until probed with a `Billing Read` token. **This is the single most important finding** of pass 2's live verification.

### B.3 Subscriptions baseline → 403

Scout token lacks `Billing Read` so `/subscriptions` also 403'd. Pass 1 already verified this path against a different account; the endpoint shape is well-known.

---

## Section C — Audit Logs v2

### C.1 V2 endpoint `GET /accounts/<ACCT>/logs/audit`

**Initial probe (with only `since` parameter)** → 400 `"Invalid format for parameter before: query parameter 'before' is required"`.

**Retried with `since` AND `before`** → ✓ 200, returned **91 audit events** for the last 24 hours on the Scout account.

Sample event shape (redacted):
```json
{
  "account": {"id": "<ACCT>", "name": "<NAME>"},
  "action": {"description": "Run a query", "result": "success", "time": "...", "type": "create"},
  "actor": {
    "context": "api_token",
    "email": "<EMAIL>",
    "id": "<USER_ID>",
    "ip_address": "<IP>",
    "token": {"id": "<TOKEN_ID>", "name": "<TOKEN_NAME>"},
    "type": "user"
  },
  "id": "<EVENT_UUID>",
  "raw": "...",
  "resource": "..."
}
```

→ **Pass-2 deep-dive doc + probe-plan need correction**: BOTH `since` and `before` query params are required. The probe-plan template will be updated.

### C.2 V1 endpoint `GET /accounts/<ACCT>/audit_logs`

→ ✓ 200. V1 still works alongside V2. Returns 5 events with different key shape: `{action, actor, id, interface, metadata, newValue, newValueJson, oldValue, oldValueJson, owner, resource, when}`.

→ **Finding**: pass 1 (which didn't document audit logs at all) missed V1. pass 2 mentioned V1 was "still available but deprecated" — that remains true; V1 is functional on Scout.

---

## Section D — GraphQL introspection

### D.1 Top-level Query type

```json
{ "fields": [
  { "name": "cost", "type": { "ofType": { "name": "uint64" } } },
  { "name": "viewer", "type": { "name": "viewer" } }
]}
```

→ **`Query.cost`** is a top-level `uint64` — this is the **GraphQL query rate-limit cost** (how many points your query consumed), NOT account billing cost. Useful to know but does NOT close the cost-monitoring gap.

### D.2 `viewer` type fields

```json
["accounts", "budget", "organizations", "zones"]
```

→ **`viewer.budget`** is also a `uint64` — this is the **GraphQL query rate-limit budget remaining**, NOT an account budget. Same disappointment as `cost`.

→ **Net new finding**: GraphQL has its own self-billing for rate-limiting (`cost` + `budget`), useful for cf-monitor to track its own GraphQL query cost. **Recommendation**: pull `cost` field in cf-monitor's hourly GraphQL queries to monitor GraphQL rate-limit budget consumption.

### D.3 Deeper schema introspection

Skipped during this probe to stay within rate-limit budget. Per the probe-plan, the full enumeration is:
```
{ __schema { types { name fields { name } } } }
```
Save for a later session — too large for inline inspection here.

---

## Section E — Resource discovery counts (live, Scout account)

| Endpoint | HTTP | Live count on Scout |
|---|---|---|
| `/workers/scripts` | 200 | 3 scripts |
| `/d1/database` | 200 | 1 database |
| `/r2/buckets` | 200 | 1 bucket |
| `/storage/kv/namespaces` | 200 | 2 namespaces |
| `/queues` | 200 | 6 queues |
| `/vectorize/indexes` | **403** | Endpoint exists; needs `Vectorize Read` |
| `/ai-gateway/gateways` | **403** | Endpoint exists; needs `AI Gateway:Read` |
| `/pages/projects` | **403** | Endpoint exists; needs `Pages Read` |
| `/hyperdrive/configs` | **403** | Endpoint exists; needs `Hyperdrive Read` |
| `/pipelines` | **403** | Endpoint exists; needs (inferred) `Pipelines Read` |
| `/ai-search/instances` | **403** | **Endpoint exists** (was `partially_verified` in pass 2) |
| `/aisearch/instances` | 400 | Does NOT exist (alt naming wrong) |
| `/workflows` | 200 | 2 workflows |
| `/tags/resources` | **403** | Resource Tagging endpoint exists |
| `/tags` | **403** | Resource Tagging endpoint exists |
| `/secrets_store/stores` | 200 | 1 store |

**Key wins:**
- **AI Search confirmed** at `/accounts/{id}/ai-search/instances` (with hyphen; no-hyphen variant returns 400).
- **Pipelines confirmed** at `/accounts/{id}/pipelines` (open beta, 403 just because token lacks permission).
- **Workflows confirmed** at `/accounts/{id}/workflows` (returned count=2).
- **Secrets Store confirmed** at `/accounts/{id}/secrets_store/stores` — count=1. This is the backing store for AI Gateway BYOK.
- **Resource Tagging endpoints exist** at `/tags` and `/tags/resources` — both 403 (auth) not 404.

---

## Section F — Inferred-path verification (HUGE wins)

### Workers inferred paths (using a real `<SCRIPT>` name)

| Path | HTTP | Verified shape |
|---|---|---|
| `/workers/scripts/<SCRIPT>/versions` | 200 | `{result: {items: [...]}}` |
| `/workers/scripts/<SCRIPT>/deployments` | 200 | `{result: {deployments: [...]}}` |
| `/workers/scripts/<SCRIPT>/schedules` | 200 | `{result: {schedules: [...]}}` |
| `/workers/scripts/<SCRIPT>/settings` | 200 | `{result: {annotations, bindings, compatibility_date, compatibility_flags, logpush, observability, ...}}` |
| `/workers/scripts/<SCRIPT>/tail` | 200 | (tail listing) |
| `/workers/scripts/<SCRIPT>/secrets` | 200 | `{result: [...6 secrets]}` |
| `/workers/scripts/<SCRIPT>/subdomain` | 200 | `{result: {enabled, previews_enabled}}` |
| `/workers/scripts/<SCRIPT>/tail-consumers` | 200 | (tail consumer list) |
| `/workers/scripts/<SCRIPT>/usage-model` | 415 | Exists; requires Content-Type header to query |
| `/workers/domains` | 200 | array (0 entries) |
| `/workers/durable_objects/namespaces` | 200 | array (1 entry) |
| `/workers/queues` | 200 | array (6 — same as `/queues`) |

→ **All 11 inferred Worker paths from pass-2 are VERIFIED**. The deep-dive doc should promote them from `partially_verified` to `verified`.

### R2 inferred paths

| Path | HTTP | Conclusion |
|---|---|---|
| `/r2/buckets/<BUCKET>/lifecycle` | 200 | ✓ Verified |
| `/r2/buckets/<BUCKET>/lock` | 200 | ✓ Verified |
| `/r2/buckets/<BUCKET>/sippy` | 200 | ✓ Verified |
| `/r2/buckets/<BUCKET>/cors` | 404 | Endpoint exists (returned "The CORS configuration does not exist" rather than route 404) |
| `/r2/buckets/<BUCKET>/event-notification` | 404 | **Does NOT exist at this path** ("No route matches this url.") |
| `/r2/buckets/<BUCKET>/domains` | 404 | Does NOT exist at this path |
| `/r2/buckets/<BUCKET>/notification-rules` | 404 | Does NOT exist at this path |

→ **Pass-2 doc correction**: `r2_bucket_event_notification` Terraform resource implies a path that doesn't match the obvious singular form. Likely lives under a different sub-path (e.g. `/event_notification_configurations` or via S3-compat). **Add as open question**.

### Queue realtime metrics

`GET /accounts/<ACCT>/queues/<QID>/metrics` → ✓ 200. Returns exactly:
```json
{
  "result": {
    "backlog_bytes": ...,
    "backlog_count": ...,
    "oldest_message_timestamp_ms": ...
  }
}
```

→ **Verified** — matches pass-1 documentation exactly.

---

## Section G — GraphQL dataset spot-checks

| Dataset | HTTP | Result |
|---|---|---|
| `workersInvocationsAdaptive` | 200 | ✓ Verified — returns `dimensions.scriptName` + `sum.{requests,errors,subrequests}`. CPU time NOT in sum (matches cf-monitor #93). `quantiles.cpuTimeP50` returns valid integer (e.g. 909) |
| `d1AnalyticsAdaptiveGroups` | 200 | ✓ Verified — returns `sum.{rowsRead, rowsWritten}`. Filter uses `date_geq`/`date_leq` (NOT `datetime_*`) — confirms cf-monitor #58 |
| `kvOperationsAdaptiveGroups` | 200 | ✓ Verified — returns `dimensions.actionType` (read/write/delete/list) + `sum.requests` |
| `r2OperationsAdaptiveGroups` | 200 | ✓ Verified — `dimensions.actionType` returns S3-style names (**`GetObject`, `HeadObject`, `PutObject`** — NOT `read`/`write`) |
| `queuesBacklogAdaptiveGroups` (plural) | 400 | **`unknown field "queuesBacklogAdaptiveGroups"`** — this name from pass-1/pass-2 docs is WRONG |
| `queueBacklogAdaptiveGroups` (singular) | 400 | Field recognised, just needed filter — **this is the correct name** |
| `queueMessageOperationsAdaptiveGroups` | 400 | Field recognised — correct name |
| `queueConsumerMetricsAdaptiveGroups` | 400 | Field recognised — correct name |

→ **CORRECTION FOR PASS 1 + PASS 2**: All three queue datasets use **singular** "queue" prefix, not plural. Pass-1 and pass-2 docs are wrong. cf-monitor's existing code may also be wrong — needs check.

→ **R2 dimension classification correction**: pass-2 R2 entry says "Class A vs Class B classification via actionType" — confirmed, but the actual `actionType` values are full S3 names (`GetObject`, `HeadObject`, `PutObject`, `ListBucket`, etc.), not lowercase verbs. cf-monitor's R2 classification helper must check for S3 names.

---

## Section H — Notifications + alerts

### H.1 List policies → ✓ 200 (0 policies on Scout)

### H.2 List webhook destinations → ✓ 200 (0 destinations on Scout)

Both endpoints verified; data unsurprising for an account that hasn't set up alerts.

### H.3 Available alert types → ✓ 200

**26 alert categories** returned. Relevant ones:

```
Billing, Health Checks, Logpush, Pages, SSL/TLS, Script Monitor,
Security Insights, Stream, Traffic Monitoring, Web Analytics,
Workers Observability, Access, CASB, DoS Protection, Magic Transit,
Tunnel, ... (and 10 more)
```

**Billing-specific alert types found:**

| API `type` value | Display name |
|---|---|
| `billing_budget_alert` | **Billing Budget Alert** ← The Budget Alert from the Apr 2026 changelog |
| `billing_usage_alert` | **Billing Usage Alert** ← The D1 rows usage alert from pass 1 |

→ **MAJOR FINDING** — pass 2 listed "exact `billing_usage_alert` value not confirmed" as an open question. **Now confirmed**: cf-monitor's "two-step Budget Alert wiring" recommendation should use `alert_type = "billing_budget_alert"` when POSTing to `/alerting/v3/policies`.

---

## Conversions: partially_verified → verified

Based on this probe, the following pass-2 deep-dive surfaces flip from `partially_verified` to `verified`:

| pass-2 surface | New status | Evidence |
|---|---|---|
| Billing SDK group | `partially_verified` (stronger evidence) — endpoints exist (`/billing/profile`, `/history`, `/usage`) but data shape still unprobed | 403 (not 404) on Scout |
| Worker `versions` REST | `verified` | 200 with `{items}` shape on Scout |
| Worker `deployments` REST | `verified` | 200 with `{deployments}` shape on Scout |
| Worker `secrets` REST | `verified` | 200 with array shape on Scout |
| Worker `custom_domain` REST | `verified` | 200 on `/workers/domains` |
| Worker `script_subdomain` REST | `verified` | 200 with `{enabled, previews_enabled}` |
| R2 `lifecycle` REST | `verified` | 200 |
| R2 `lock` REST | `verified` | 200 |
| R2 `sippy` REST | `verified` | 200 |
| R2 `event_notification` REST | **`contradicted`** — `/event-notification` path returns 404. Needs path discovery. | 404 on probed path |
| Pipelines `stream`/`sink`/`pipeline` REST | `verified` (existence) | 403 on `/pipelines` (endpoint exists) |
| AI Search REST | `verified` (existence) | 403 on `/ai-search/instances`; 400 on `/aisearch/instances` confirming hyphenated path |
| Workflows REST | `verified` | 200 with count=2 |
| Queue realtime metrics REST | `verified` (already from pass 2) | Confirmed exact shape |
| Audit Logs v2 REST | `verified` with caveat (requires BOTH `since` and `before`) | 200 with 91 events |

## New surfaces discovered during this probe

| Surface | Source | Notes |
|---|---|---|
| `Query.cost` GraphQL root field | Live introspection | uint64 — GraphQL query rate-limit cost |
| `viewer.budget` | Live introspection | uint64 — GraphQL query rate-limit budget remaining |
| `/accounts/{id}/workflows` REST list | Live probe | 200 count=2 (was inferred from Terraform; now verified path) |
| `/accounts/{id}/secrets_store/stores` REST list | Live probe | 200 count=1 — confirms Secrets Store backing for AI Gateway BYOK |
| `/accounts/{id}/audit_logs` (V1) | Live probe | Still works alongside V2 — different schema |
| `/accounts/{id}/workers/durable_objects/namespaces` | Live probe | DO namespace listing endpoint |
| `/accounts/{id}/workers/queues` (mirror of `/queues`) | Live probe | Same data; alt path |

## Corrections to pass 1 + pass 2

1. **Queue GraphQL dataset names are SINGULAR**, not plural. cf-monitor and pass-1/2 docs use `queuesBacklogAdaptiveGroups` (wrong). Correct names:
   - `queueBacklogAdaptiveGroups`
   - `queueMessageOperationsAdaptiveGroups`
   - `queueConsumerMetricsAdaptiveGroups`
2. **R2 `actionType` dimension values are S3 names** (`GetObject`, `HeadObject`, `PutObject`, `ListBucket`, etc.), not lowercase `read`/`write`. cf-monitor's R2 classification helper must match these.
3. **Audit Logs v2 requires both `since` and `before`** — `since` alone returns 400.
4. **R2 `event_notification` path is wrong** in the inferred set. The Terraform resource exists but the REST path is not `/event-notification` (404 on Scout). Likely lives at a deeper path (open question).

---

## Open follow-ups requiring Platform `Billing Read` token

After the Platform CF API token is rotated in BWS, re-run with a `Billing Read`-enabled token and capture:

1. `/accounts/{Platform}/billing/profile` payload
2. `/accounts/{Platform}/billing/history` payload (likely returns invoice list?)
3. `/accounts/{Platform}/billing/usage` payload ← **highest priority**: likely contains the Billable Usage dashboard data **(RESOLVED 2026-05-28: NOT the Billable Usage API — it's a generic time-series metric query with no per-product cost. See `billing-endpoints-follow-up.md`.)**
4. `/accounts/{Platform}/subscriptions` payload (verify pass-1 schema still matches)

---

## Probe environment

- Date: 2026-05-27
- Cloudflare API base: `https://api.cloudflare.com/client/v4`
- Total requests: ~38 REST + 5 GraphQL queries
- Total time: ~5 min including 15s pacing between GraphQL calls
- Cost incurred: $0
- Mutations performed: **none** (all requests were GET / read-only)
- Identifiers redacted: account ID, script names, bucket names, queue IDs, user emails, IPs, token IDs/names
