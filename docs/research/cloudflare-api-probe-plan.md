# Cloudflare API Probe Plan — Pass 2 Live-Verification Commands

**Generated**: 2026-05-27
**Purpose**: Exact, **safe, read-only** commands a maintainer can run with a real Cloudflare API token to verify the partially-verified findings in pass 2 ([`cloudflare-api-surface-deep-dive.md`](./cloudflare-api-surface-deep-dive.md)) and the open questions in pass 1.

> **Hard rules** (from the brief and re-stated here):
> - **Only GET / list / read** requests. No POST / PUT / PATCH / DELETE.
> - **No `_create`, `_update`, `_delete`, `_purge`, `_set`, `_rotate`** verbs.
> - **No commands that may incur meaningful cost** (e.g. provoke a Workers AI inference run, write to AE, ingest into Pipelines).
> - **Redact** account IDs, zone IDs, names, emails, tokens, secrets, URLs, business identifiers before pasting results back into `docs/research/cloudflare-api-probe-results.md`.

When you've run these, file the captured results at `docs/research/cloudflare-api-probe-results.md`. Replace any `?` / `unknown` / `partially_verified` markers in the deep-dive doc accordingly.

---

## Required credentials

Export before running any command below:

```bash
export CLOUDFLARE_API_TOKEN="…"            # Read-only token preferred
export CLOUDFLARE_ACCOUNT_ID="…"           # 32-char hex
export CLOUDFLARE_ZONE_ID="…"              # Only required for zone-scoped probes
```

**Recommended token permissions for safety**: `Billing Read`, `Account Settings Read`, `API Tokens Read`, `Account Analytics`, `Workers Scripts Read`, `Workers KV Storage Read`, `Workers R2 Storage Read`, `D1 Read`, `Queues Read`, `AI Gateway:Read`, `Workers AI Read`, `Vectorize Read`, `Hyperdrive Read`, `Pages Read`, `Notifications Read`. **Do not** grant any `*Edit`/`*Write` permission to the probe token.

---

## Section A — Token sanity / self-introspection

These are the cheapest, safest probes. Run these first.

### A.1 Verify token is active

```bash
curl -sS "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq .
```

**Expected**: `{ "success": true, "result": { "id": "…", "status": "active", "not_before": "…", "expires_on": "…" } }`. Token IP/TTL restrictions do **not** apply to this endpoint per docs.

### A.2 List all permission groups (used to auto-generate cf-monitor's permission matrix)

```bash
curl -sS "https://api.cloudflare.com/client/v4/user/tokens/permission_groups" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result[] | {id, name, scopes}' | head -200
```

**Expected**: array of `{id, name, description, scopes[]}`. Save the full output — useful for cf-monitor to map permission `id` → canonical `name`.

---

## Section B — Billing SDK group probe (HIGHEST PRIORITY)

This is the most material unknown in pass 2. The cloudflare-typescript SDK exposes `src/resources/billing/` but the endpoints under it are not in product docs.

> **Caution**: if any of these probes return 403, that's fine — it just means the permission is wrong or the endpoint is restricted. Capture the status code + error message verbatim.

### B.1 Inspect what paths the SDK exposes under `billing`

First, retrieve the SDK index for the billing module via GitHub MCP (no creds needed for this part):

```
mcp__github__get_file_contents(owner='cloudflare', repo='cloudflare-typescript', path='src/resources/billing/index.ts')
```

Likely subpaths to look for: `profile`, `history`, `usage`, `summary`, `subscriptions`, `invoices`, `payment_methods`. The SDK file should reveal which exist.

### B.2 Probe the most-likely billing paths

```bash
# Most general
curl -sS -o /tmp/billing-root.json -w "HTTP %{http_code}\n" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/billing" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
jq . /tmp/billing-root.json

# Profile
curl -sS -o /tmp/billing-profile.json -w "HTTP %{http_code}\n" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/billing/profile" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
jq . /tmp/billing-profile.json

# History
curl -sS -o /tmp/billing-history.json -w "HTTP %{http_code}\n" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/billing/history" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
jq . /tmp/billing-history.json

# Usage (long shot)
curl -sS -o /tmp/billing-usage.json -w "HTTP %{http_code}\n" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/billing/usage" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
jq . /tmp/billing-usage.json
```

Record for each: HTTP status code, top-level response keys, success/error messages.

### B.3 Probe subscriptions (known-good baseline from pass 1)

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/subscriptions" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result[] | {rate_plan: .rate_plan.id, period_start: .current_period_start, period_end: .current_period_end}'
```

**Expected** (pass 1 verified): array with `rate_plan.id`, `current_period_start`, `current_period_end`.

---

## Section C — Audit Logs v2

### C.1 Recent audit events (account scope)

```bash
SINCE=$(date -u -d '24 hours ago' +"%Y-%m-%dT%H:%M:%SZ")
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/logs/audit?since=${SINCE}&per_page=10" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result | length, .result[0]'
```

**Expected**: number of events in the last 24h, and the shape of one event (actor, action_type, action_result, resource, ray_id, etc.).

### C.2 Verify available filter parameters

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/logs/audit?per_page=1&actor.type=user" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq .
```

Try other filters from the brief: `actor.type=Cloudflare_admin`, `actor.type=account`, `actor.type=system`, `resource_scope=zones`, `resource_scope=accounts`.

---

## Section D — GraphQL introspection (dataset enumeration)

### D.1 List every field on `viewer.accounts` (the account-scope dataset root)

```bash
curl -sS "https://api.cloudflare.com/client/v4/graphql" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "query": "{ __type(name: \"AccountsViewer\") { fields { name type { name kind ofType { name kind } } } } }"
  }' | jq '.data.__type.fields[] | .name' | sort
```

**Expected**: an alphabetised list of every dataset field name available under `viewer.accounts(...)`. Compare against pass-1 + pass-2 documented datasets; flag any not yet inventoried.

### D.2 List every field on `viewer.zones`

```bash
curl -sS "https://api.cloudflare.com/client/v4/graphql" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "query": "{ __type(name: \"ZonesViewer\") { fields { name type { name kind ofType { name kind } } } } }"
  }' | jq '.data.__type.fields[] | .name' | sort
```

### D.3 Search the GraphQL schema for billing/usage keywords

```bash
curl -sS "https://api.cloudflare.com/client/v4/graphql" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "query": "{ __schema { types { name fields { name } } } }"
  }' > /tmp/cf-graphql-schema.json

jq -r '.data.__schema.types[]
       | select(.fields != null)
       | .name as $type
       | .fields[]
       | "\($type).\(.name)"' /tmp/cf-graphql-schema.json \
  | grep -iE '(cost|usage|bill|charge|requests?|cpu|duration|storage|bytes|rows|operations|invocations|errors|subrequests|tokens|neurons|backlog|concurrency|transformations|minutes|cache|bandwidth)' \
  | sort -u
```

**Expected**: long list of `Type.fieldName` pairs that look billing/cost-related. Use this to find datasets/fields pass 1+2 missed.

---

## Section E — Resource discovery (already in pass 1, run for completeness)

These are pure reads with low impact. Useful to confirm the live state of cf-monitor's discovery paths.

```bash
# Workers scripts
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result | length'

# D1 databases
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result | length'

# R2 buckets
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result.buckets | length'

# KV namespaces
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces?per_page=100" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result | length'

# Queues
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/queues" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result | length'

# Vectorize indexes
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/vectorize/indexes" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result | length'

# AI Gateways
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai-gateway/gateways?per_page=50" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result | length'

# Pages projects
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result | length'

# Hyperdrive configs
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/hyperdrive/configs" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result | length'

# Pipelines
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pipelines" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq .
```

For each, capture the status code, count, and one sample object (`.result[0]`) with redactions.

---

## Section F — Inferred-path verification

### F.1 Workers versions + deployments (Terraform-discovered, REST inferred)

Pick one worker script that exists in your account (`SCRIPT_NAME`):

```bash
SCRIPT_NAME="<your-worker-name>"

# Versions
curl -sS -o /dev/null -w "HTTP %{http_code} versions\n" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/versions" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

# Deployments
curl -sS -o /dev/null -w "HTTP %{http_code} deployments\n" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/deployments" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

# Schedules (already known good)
curl -sS -o /dev/null -w "HTTP %{http_code} schedules\n" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/schedules" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

# Settings
curl -sS -o /dev/null -w "HTTP %{http_code} settings\n" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/settings" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

# Tail consumers
curl -sS -o /dev/null -w "HTTP %{http_code} tail\n" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/tail" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
```

**Expected for `versions` and `deployments`**: HTTP 200. If 404, the inferred path is wrong — capture the actual error.

### F.2 R2 bucket lifecycle / event-notification / lock / sippy

Pick one R2 bucket (`BUCKET_NAME`):

```bash
BUCKET_NAME="<your-bucket-name>"

for ENDPOINT in lifecycle event-notification lock sippy cors; do
  echo "--- ${ENDPOINT} ---"
  curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${BUCKET_NAME}/${ENDPOINT}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
done
```

### F.3 AI Search (existence confirmation)

```bash
curl -sS -o /tmp/ai-search.json -w "HTTP %{http_code}\n" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai-search/instances" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
jq . /tmp/ai-search.json

# Alternate path candidate
curl -sS -o /tmp/aisearch-alt.json -w "HTTP %{http_code}\n" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/aisearch/instances" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
jq . /tmp/aisearch-alt.json
```

### F.4 Pipelines list

```bash
curl -sS -o /tmp/pipelines.json -w "HTTP %{http_code} pipelines\n" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pipelines" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

curl -sS -o /tmp/pipelines-streams.json -w "HTTP %{http_code} streams\n" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pipelines/streams" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

curl -sS -o /tmp/pipelines-sinks.json -w "HTTP %{http_code} sinks\n" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pipelines/sinks" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
```

### F.5 Queue realtime backlog (pass-1 finding, verify)

```bash
QUEUE_ID="<your-queue-id>"

curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/queues/${QUEUE_ID}/metrics" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq .
```

**Expected**: `{ backlog_count, backlog_bytes, oldest_message_timestamp_ms }`.

---

## Section G — GraphQL spot-checks for known datasets

Run one sample query per pass-1 dataset to confirm naming + permissions are still correct.

```bash
TODAY=$(date -u +"%Y-%m-%d")
YESTERDAY=$(date -u -d '1 day ago' +"%Y-%m-%d")

# Workers invocations
curl -sS "https://api.cloudflare.com/client/v4/graphql" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"query\":\"{ viewer { accounts(filter: { accountTag: \\\"${CLOUDFLARE_ACCOUNT_ID}\\\" }) { workersInvocationsAdaptive(limit: 5, filter: { datetime_geq: \\\"${YESTERDAY}T00:00:00Z\\\", datetime_lt: \\\"${TODAY}T00:00:00Z\\\" }) { dimensions { scriptName } sum { requests errors } } } } }\"}" \
  | jq '.data.viewer.accounts[0].workersInvocationsAdaptive[0]'

# D1 (note date_geq, NOT datetime_geq — cf-monitor #58)
curl -sS "https://api.cloudflare.com/client/v4/graphql" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"query\":\"{ viewer { accounts(filter: { accountTag: \\\"${CLOUDFLARE_ACCOUNT_ID}\\\" }) { d1AnalyticsAdaptiveGroups(limit: 5, filter: { date_geq: \\\"${YESTERDAY}\\\", date_leq: \\\"${TODAY}\\\" }) { sum { rowsRead rowsWritten } } } } }\"}" \
  | jq '.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups[0]'

# KV ops
curl -sS "https://api.cloudflare.com/client/v4/graphql" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"query\":\"{ viewer { accounts(filter: { accountTag: \\\"${CLOUDFLARE_ACCOUNT_ID}\\\" }) { kvOperationsAdaptiveGroups(limit: 5, filter: { datetime_geq: \\\"${YESTERDAY}T00:00:00Z\\\", datetime_lt: \\\"${TODAY}T00:00:00Z\\\" }) { dimensions { actionType } sum { requests } } } } }\"}" \
  | jq '.data.viewer.accounts[0].kvOperationsAdaptiveGroups[0]'

# R2 ops
curl -sS "https://api.cloudflare.com/client/v4/graphql" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"query\":\"{ viewer { accounts(filter: { accountTag: \\\"${CLOUDFLARE_ACCOUNT_ID}\\\" }) { r2OperationsAdaptiveGroups(limit: 5, filter: { datetime_geq: \\\"${YESTERDAY}T00:00:00Z\\\", datetime_lt: \\\"${TODAY}T00:00:00Z\\\" }) { dimensions { actionType bucketName } sum { requests } } } } }\"}" \
  | jq '.data.viewer.accounts[0].r2OperationsAdaptiveGroups[0]'

# Workers cpuTime quantile (sanity for cf-monitor #93 workaround)
curl -sS "https://api.cloudflare.com/client/v4/graphql" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"query\":\"{ viewer { accounts(filter: { accountTag: \\\"${CLOUDFLARE_ACCOUNT_ID}\\\" }) { workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: \\\"${YESTERDAY}T00:00:00Z\\\", datetime_lt: \\\"${TODAY}T00:00:00Z\\\" }) { quantiles { cpuTimeP50 } } } } }\"}" \
  | jq '.'
```

If any of these return errors mentioning "field not found", capture the error verbatim — Cloudflare may have renamed/removed the dataset since pass 1.

---

## Section H — Notification policies + webhook destinations

```bash
# List policies
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/alerting/v3/policies" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result[] | {id, alert_type, name, enabled}'

# List webhook destinations (confirm two-step model: webhooks are a separate sub-resource)
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/alerting/v3/destinations/webhooks" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result[] | {id, name, type}'

# Available alert types for the account
curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/alerting/v3/available_alerts" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result | keys'
```

**Look for**: `billing_usage_alert`, `usage_billing_alert`, or any name that maps to "Budget Alert". Confirm the exact `alert_type` value cf-monitor must pass when creating a policy.

---

## Section I — What NOT to run

These are listed only to flag them as **prohibited** by the brief's hard rules:

- ❌ Any `POST` to `/alerting/v3/policies` (would create a policy — changes user state).
- ❌ Any `PUT` to `/workers/scripts/{name}` (would deploy/overwrite a script).
- ❌ Any `POST` to `/ai/run/...` (would consume Workers AI neurons — billable).
- ❌ Any `POST` to `/ai-gateway/.../logs/...` mutation paths (creates logs / fires events).
- ❌ Any call to `/queues/{id}/purge` (data loss).
- ❌ Any `DELETE` on any path.
- ❌ Any `POST` to `/pipelines/streams/{id}/ingest` (would inject events).

---

## After running

1. Save raw outputs (redacted) to `docs/research/cloudflare-api-probe-results.md`.
2. Update `cloudflare-api-surface-deep-dive.md`:
   - Move every `partially_verified` row whose endpoint now resolves to `verified`.
   - For any 404 / 403 result, add a row to the "Endpoints searched for but not found" table or annotate the existing row with the live response.
3. Update `cloudflare-api-surface.deep.json`:
   - Same — bump `verificationStatus` and `deltaStatus` per surface.
4. Open a follow-up issue or PR titled `docs(research): pass-2 live verification results` that links back to this probe-plan file.

---

## Estimated cost of running this entire probe plan

All commands above are GET requests. Approximate request count:

- Section A (token verify + permission_groups): 2 reads
- Section B (billing probes): ~4 reads (some may 404 / 403)
- Section C (audit logs): 2 reads
- Section D (GraphQL introspection): 3 GraphQL queries
- Section E (discovery): 10 reads
- Section F (inferred paths): ~12 reads
- Section G (GraphQL spot-checks): 5 GraphQL queries
- Section H (notifications): 3 reads
- **Total: ~41 reads + 8 GraphQL queries**

Cloudflare's free API rate limit is more than enough for this (the GraphQL rate limit is 25 requests / 5 minutes; pace the GraphQL queries with a 15-second gap between each if running back-to-back).

**Expected cost**: $0. None of these are billable operations on any plan.
