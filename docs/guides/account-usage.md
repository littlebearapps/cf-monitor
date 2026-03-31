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

### Services NOT available

AI Gateway, Vectorize, Queues, Workflows, and Hyperdrive do not have GraphQL Analytics datasets. They use REST APIs or dashboard-only metrics and may be added in a future version.

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
