# Self-Monitoring

cf-monitor monitors itself. It tracks cron execution, counts its own errors, writes self-telemetry to Analytics Engine, and alerts you if it becomes unhealthy. If cf-monitor breaks, you'll know.

## How it works

Every time cf-monitor runs a handler (tail, scheduled, or fetch), it records:

1. **Cron execution timestamps** — per-handler KV keys with the last run time, duration, and success status of each cron handler
2. **Error counts** — per-handler and total daily counters in KV
3. **AE telemetry** — a data point per handler invocation for historical analysis

All self-monitoring operations are fail-open. If KV or AE is unreachable, cf-monitor continues working normally — it just can't report on its own health until KV recovers.

## Cron staleness detection

cf-monitor knows the expected schedule and maximum staleness for each cron handler:

| Handler | Schedule | Max staleness |
|---------|----------|---------------|
| `gap-detection` | Every 15 min | 45 min |
| `cost-spike` | Every 15 min | 45 min |
| `collect-metrics` | Hourly | 150 min (2.5 hr) |
| `collect-account-usage` | Hourly | 150 min (2.5 hr) |
| `budget-check` | Hourly | 150 min (2.5 hr) |
| `synthetic-health` | Hourly | 150 min (2.5 hr) |
| `daily-rollup` | Daily | 1500 min (25 hr) |
| `worker-discovery` | Daily | 1500 min (25 hr) |

If a handler hasn't run within its max staleness window, it's flagged as stale. Staleness thresholds are 3x the expected interval, giving generous margin for transient issues.

**First boot**: After initial deployment, all handlers show `lastRun: null` — this is reported as healthy, not stale. Handlers populate their timestamps on first execution.

## The /self-health endpoint

```
GET /self-health
```

Returns structured health status with HTTP status codes:

- **200** — healthy (no stale crons, fewer than 50 errors today)
- **503** — unhealthy (stale crons detected or 50+ errors today)

### Example response (healthy)

```json
{
  "healthy": true,
  "staleCrons": [],
  "todayErrors": 2,
  "handlerErrors": {
    "tail": 2
  },
  "crons": {
    "gap-detection": { "lastRun": "2026-03-22T14:15:03Z", "stale": false },
    "cost-spike": { "lastRun": "2026-03-22T14:15:03Z", "stale": false },
    "collect-metrics": { "lastRun": "2026-03-22T14:00:01Z", "stale": false },
    "collect-account-usage": { "lastRun": "2026-03-22T14:00:02Z", "stale": false },
    "budget-check": { "lastRun": "2026-03-22T14:00:03Z", "stale": false },
    "synthetic-health": { "lastRun": "2026-03-22T14:00:04Z", "stale": false },
    "daily-rollup": { "lastRun": "2026-03-22T00:00:01Z", "stale": false },
    "worker-discovery": { "lastRun": "2026-03-22T00:00:02Z", "stale": false }
  }
}
```

### Example response (unhealthy)

```json
{
  "healthy": false,
  "staleCrons": ["collect-metrics", "budget-check"],
  "todayErrors": 12,
  "handlerErrors": {
    "scheduled:collect-metrics": 8,
    "scheduled:budget-check": 4
  },
  "crons": {
    "collect-metrics": { "lastRun": "2026-03-22T08:00:01Z", "stale": true },
    "budget-check": { "lastRun": "2026-03-22T08:00:03Z", "stale": true }
  }
}
```

## Slack alerts

When cron staleness is detected, cf-monitor sends a Slack alert:

> :warning: cf-monitor self-check: stale crons detected — collect-metrics, budget-check

Alerts are deduplicated once per day (`self:stale:{date}` key, 24-hour TTL) — you won't be spammed if the same handlers stay stale.

## Self-telemetry in Analytics Engine

Every handler invocation writes a data point to AE with a special format:

- **blob1**: `'cf-monitor'` (worker name)
- **blob2**: `'self:{durationMs}:{1|0}'` (e.g. `self:250:1` for a 250ms success)
- **blob3**: handler name (e.g. `scheduled:budget-check`, `tail`, `fetch`)
- **doubles[0]**: `1` (invocation count)
- **index**: `cf-monitor:self:{handlerName}`

### Querying self-telemetry

**Invocation counts per handler:**

```sql
SELECT blob3 AS handler, count() AS invocations
FROM "cf-monitor"
WHERE blob2 LIKE 'self:%'
GROUP BY handler
ORDER BY invocations DESC
```

**Average duration per handler (last 24 hours):**

```sql
SELECT
  blob3 AS handler,
  count() AS invocations,
  AVG(CAST(SPLIT(blob2, ':')[2] AS INT)) AS avg_duration_ms
FROM "cf-monitor"
WHERE blob2 LIKE 'self:%'
  AND timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY handler
```

**Error rate (success=0 invocations):**

```sql
SELECT blob3 AS handler, count() AS errors
FROM "cf-monitor"
WHERE blob2 LIKE 'self:%:0'
GROUP BY handler
```

## KV state

Self-monitoring uses these KV key patterns, all with 48-hour TTL:

| Key | Value | Purpose |
|-----|-------|---------|
| `self:v2:cron:{handler}` | JSON `{lastRun, durationMs, success}` | Per-handler cron timestamp (v0.3.7+) |
| `self:v1:cron:last_run` | JSON blob | Legacy fallback — read by `getSelfHealth()` for handlers that haven't run since upgrade |
| `self:v1:error:{handler}:{YYYY-MM-DD}` | Integer string | Per-handler daily error count |
| `self:v1:errors:count:{YYYY-MM-DD}` | Integer string | Total daily error count |

Per-handler keys (v2) eliminate the read-merge-write race condition that occurred when concurrent crons (e.g. daily-rollup + worker-discovery) both wrote to the same blob. Each handler now writes only its own key — no read needed, no race possible. The v1 blob expires naturally via its 48-hour TTL.

## Manually triggering staleness check

```bash
curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/cron/staleness-check \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

This runs the staleness detection logic immediately and sends a Slack alert if any handlers are stale.

## Cost impact

Self-monitoring adds approximately:

- **~115 KV writes/day** — cron timestamps (1 write per handler execution, no read needed) + error counters
- **~150 KV reads/day** — health checks read per-handler keys in parallel (8 reads per `/self-health` call)
- **~310 AE writes/day** — self-telemetry data points (free tier)

Total: ~265 KV operations/day, well under the 1,000 KV ops/day budget.

## Troubleshooting

**`/self-health` returns 503 with stale crons**: See [Troubleshooting — Self-monitoring shows stale crons](../troubleshooting.md#self-monitoring-shows-stale-crons).

**Error counts seem high**: Check `wrangler tail cf-monitor` for the handler name that's erroring. Common causes: expired API token, GitHub rate limit, Slack webhook revoked.

**No self-telemetry in AE**: Self-telemetry uses the same `CF_MONITOR_AE` binding as SDK telemetry. If AE writes work for consumer workers but not self-telemetry, check `wrangler tail cf-monitor` for `[cf-monitor:self]` warning messages.

**`/self-health` shows all `lastRun: null`**: Normal after first deploy. Wait for each handler's schedule to fire (up to 24 hours for daily handlers). To accelerate, trigger handlers manually via admin endpoints.
