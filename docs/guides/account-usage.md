# Account Usage

cf-monitor collects account-wide resource usage from the Cloudflare GraphQL Analytics API, showing how much of your plan's included allowances you've used.

## How it works

The `collect-account-usage` cron runs hourly (`0 * * * *`). It queries the CF GraphQL Analytics API for the last 24 hours of usage across 5 services:

| Service | GraphQL Dataset | Metrics collected |
|---------|----------------|-------------------|
| Workers | `workersInvocationsAdaptive` | requests, cpuTime (µs → converted to ms) |
| D1 | `d1AnalyticsAdaptiveGroups` | rowsRead, rowsWritten |
| KV | `kvOperationsAdaptiveGroups` | reads, writes, deletes, lists |
| R2 | `r2OperationsAdaptiveGroups` | Class A (mutations), Class B (reads) |
| Durable Objects | `durableObjectsInvocationsAdaptiveGroups` | requests |

### Services NOT available via GraphQL

Vectorize, Queues, Workflows, and Hyperdrive do not have GraphQL Analytics datasets. They use REST APIs or dashboard-only metrics and may be added in a future version.

AI Gateway is collected via its own **REST Logs API** by a separate cron (`collect-ai-gateway-usage`) — see [AI Gateway usage](#ai-gateway-usage) below.

### Query isolation

Each service is queried in a separate GraphQL request. If one service query fails (e.g. you don't use D1), the others still return data. This uses 5 requests per collection cycle, well within Cloudflare's 25 requests per 5 minutes rate limit.

### D1 date filter format

D1's `d1AnalyticsAdaptiveGroups` dataset requires `date_geq`/`date_leq` filters (YYYY-MM-DD format), not `datetime_geq` (ISO 8601). Other services use `datetime_geq`/`datetime_lt`. cf-monitor handles this automatically.

## Storage

Daily snapshots are stored in KV with a 32-day TTL:

```
usage:account:{YYYY-MM-DD} -> JSON ServiceUsageSnapshot
```

The 32-day retention allows billing period lookback across month boundaries.

## Data accuracy

> **Important**: Usage data from the GraphQL Analytics API is approximate and should not be used as a measure for billing purposes. The API has a ~60 second aggregation delay, and adaptive sampling may reduce precision for high-traffic accounts.

## API

```
GET /usage
```

Returns the latest snapshot with plan context:

```json
{
  "collected_at": "2026-03-22T10:00:00Z",
  "disclaimer": "Approximate — from CF GraphQL Analytics API...",
  "plan": "paid",
  "billingPeriod": { "start": "2026-03-02T00:00:00Z", "end": "2026-04-02T00:00:00Z" },
  "services": {
    "workers": { "requests": 1234567, "cpuMs": 456789 },
    "d1": { "rowsRead": 500000, "rowsWritten": 10000 },
    "kv": { "reads": 200000, "writes": 5000, "deletes": 100, "lists": 50 }
  }
}
```

## CLI

```bash
npx cf-monitor usage          # Formatted table with colour-coded % bars
npx cf-monitor usage --json   # Raw JSON output
```

The CLI shows per-service usage against your plan's included allowances, with colour-coded percentage bars (green < 70%, yellow 70-90%, red > 90%).

## Manual trigger

```bash
curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/cron/collect-account-usage \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

## Requirements

Uses the same `CLOUDFLARE_API_TOKEN` as worker discovery — no additional token needed. The token's default Workers permissions include GraphQL Analytics read access.

## Troubleshooting

**"No usage data collected yet"**: The hourly cron hasn't run yet. Trigger it manually (see above) or wait up to 60 minutes.

**Missing services in output**: If a service has zero activity in the last 24 hours, it won't appear in the snapshot. This is correct behaviour.

**GraphQL errors in logs**: The CF GraphQL API occasionally returns transient errors. cf-monitor logs these as warnings and retries on the next hourly cycle. Individual service failures don't affect other services.

## AI Gateway usage

AI Gateway is a special case: Cloudflare doesn't expose its usage via GraphQL Analytics, but it does expose a **per-request log REST API**. The `collect-ai-gateway-usage` cron runs hourly (alongside the GraphQL collection) and pulls the previous hour of logs across all gateways on the account.

### How it works

For each gateway returned by `GET /accounts/{id}/ai-gateway/gateways`, the cron paginates `GET /accounts/{id}/ai-gateway/gateways/{gw}/logs?start_date=...&end_date=...` (up to 5 pages × 1000 logs/page per gateway per hour — hot gateways trigger a Slack `ai-gateway-pagecap` alert). Each log row contributes to an in-memory aggregate keyed by `(gateway_id, provider, model)`:

| Field | Source |
|-------|--------|
| `requests` | row count |
| `tokens_in`, `tokens_out` | summed per-row fields |
| `cost` | summed per-row `cost` field (USD, pass-through pricing from CF) |
| `cached` | count of rows with `cached === true` |
| `errors` | count of rows with `success === false` |
| `p50_duration_ms` | median of per-row `duration` fields, sorted in-memory |

Aggregates are written **per (gateway, provider, model)** as a row in Analytics Engine (positions 20–26 in AE_FIELDS), and merged into a daily KV blob at `usage:account:ai-gateway:{YYYY-MM-DD}` (32-day TTL). Cross-hour p50 is approximated by a request-weighted average of per-hour p50s — exact percentiles across an entire day aren't possible without storing all raw durations.

### Token scope

The cron requires the **AI Gateway: Read** permission on your `CLOUDFLARE_API_TOKEN`. Without it, the call returns 403 and the cron logs once per UTC day before skipping — fail-open semantics, identical to the `Account Settings: Read` handling in plan detection.

### Storage and cost

| Resource | Per-hour cost on a typical account |
|----------|------------------------------------|
| REST API calls | 1 list-gateways + ≤ 5 log pages per gateway = ~6–11 requests/hour (well under CF's 1200 req/5 min token rate limit) |
| KV writes | 1 merged daily blob/hour = 24/day |
| AE writes | 1 per distinct `(gateway, provider, model)` per hour. e.g. Platform account: ~6/hour, ~144/day. |

No new D1, no Queues. cf-monitor's own AE writes still sit well inside the 100M/month free tier.

### API

```
GET /usage              → service usage incl. aiGateway totals (requests, tokens, cost, cached, errors)
GET /usage/ai-gateway   → full per-gateway/provider/model breakdown for today
GET /usage/ai-gateway?date=2026-05-20   → same for a specific day (last 32 days only)
```

Example `/usage/ai-gateway` response:

```json
{
  "account": "platform",
  "date": "2026-05-27",
  "status": "ok",
  "snapshot": {
    "date": "2026-05-27",
    "gateways": {
      "platform": {
        "providers": {
          "openai": {
            "models": {
              "gpt-4o": {
                "requests": 412,
                "tokens_in": 8400,
                "tokens_out": 2100,
                "cost": 0.084,
                "cached": 36,
                "errors": 2,
                "p50_duration_ms": 320
              }
            }
          },
          "google-ai-studio": {
            "models": {
              "gemini-2.5-flash-lite": {
                "requests": 1280,
                "tokens_in": 24000,
                "tokens_out": 12000,
                "cost": 0.018,
                "cached": 0,
                "errors": 4,
                "p50_duration_ms": 180
              }
            }
          }
        }
      }
    },
    "totals": {
      "requests": 1692,
      "tokens_in": 32400,
      "tokens_out": 14100,
      "cost": 0.102,
      "cached": 36,
      "errors": 6
    },
    "lastUpdated": 1735000000000,
    "disclaimer": "First-party Cloudflare AI Gateway logs..."
  },
  "timestamp": 1735000000000
}
```

### Manual trigger

```bash
curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/cron/collect-ai-gateway-usage \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Caveats

- The 5-page-per-hour cap is a safety stop, not a limit on Cloudflare's side. If a gateway processes > 5000 requests in a single hour, the page cap is hit and a Slack alert fires (`ai-gateway-pagecap`). The truncation only affects that hour's aggregate; the next hour starts fresh. Future versions may make the cap configurable.
- The `cost` field reflects what Cloudflare's gateway captured at request time — typically the provider's published per-token rate, with no markup. Custom cost overrides via the `cf-aig-custom-cost` header are honoured. Cloudflare's [AI Gateway pricing docs](https://developers.cloudflare.com/ai-gateway/) are authoritative.
- The cron itself is fail-open: any error (network, 401/403, schema mismatch, JSON parse failure) is logged and the worker continues. The consumer worker invoking AI Gateway is never affected.
