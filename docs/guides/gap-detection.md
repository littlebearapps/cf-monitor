# Gap Detection

cf-monitor identifies workers on your account that aren't sending telemetry — showing you where monitoring coverage is missing so nothing falls through the cracks.

## How it works

The gap detection cron runs every 15 minutes (`*/15 * * * *`). It compares two lists:

1. **Discovered workers** — from the `workers:list` KV key (populated by [worker discovery](./worker-discovery.md))
2. **Active workers** — workers that have sent telemetry in the last hour

Workers present in (1) but not (2) are flagged as gaps.

### Detection methods

**Primary: Analytics Engine SQL** (when `CLOUDFLARE_API_TOKEN` is set)

Queries AE for workers that have written telemetry data points in the last 60 minutes. This is the most accurate method — it detects actual SDK telemetry, not just traffic.

**Fallback: KV timestamps** (when no API token)

Checks `workers:{name}:last_seen` KV keys, written by the SDK on each invocation. If a worker's `last_seen` timestamp is older than 1 hour, it's flagged as a gap. This method works without an API token but relies on the SDK heartbeat.

### Exclusions

- **cf-monitor itself** is always excluded (it monitors, it doesn't report to itself)
- Workers matching `exclude` patterns in `cf-monitor.yaml` are skipped
- If `workers:list` doesn't exist yet (discovery hasn't run), gap detection silently returns

## Alerts

When gaps are detected, a Slack alert is sent listing the affected workers. Alerts are deduplicated once per day (`gap:{date}` key, 24-hour TTL) to prevent repeated notifications for the same gap.

## Common causes of gaps

| Cause | Fix |
|-------|-----|
| Worker not wired | Run `npx cf-monitor wire --apply` to add `tail_consumers` |
| Worker has no traffic | Normal — low-traffic workers may not appear active |
| Worker deployed after last discovery | Wait for next daily discovery or trigger `POST /admin/cron/worker-discovery` |
| AE write propagation delay | AE writes take 30-90 seconds to become queryable — transient gap alerts may resolve themselves |
| Worker excluded in config | Check `exclude` patterns in `cf-monitor.yaml` |

## API

| Endpoint | Purpose |
|----------|---------|
| `GET /status` | Includes gap count in the status response |
| `POST /admin/cron/gap-detection` | Manually trigger gap detection |

## Troubleshooting

**False positives for low-traffic workers**: Workers that receive no requests won't generate telemetry. Consider excluding them via the `exclude` config or accepting the gap alert as informational.

**Gap alerts after new deployment**: Newly deployed workers won't be in the `workers:list` until the next daily discovery run. Trigger discovery manually: `POST /admin/cron/worker-discovery`.

**Gaps despite wired workers**: Check that the worker's `tail_consumers` config is correct (`"service": "cf-monitor"`) and that the worker has `CF_MONITOR_AE` and `CF_MONITOR_KV` bindings. Run `npx cf-monitor coverage` to see the full picture.
