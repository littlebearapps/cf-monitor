# Slack Alerts

cf-monitor sends Slack alerts for budget warnings, errors, gap detections, cost spikes, and self-monitoring staleness — all with KV-based deduplication so you don't get spammed.

## Setup

1. Create a Slack incoming webhook in your workspace ([Slack docs](https://api.slack.com/messaging/webhooks))
2. Set it as a secret on the cf-monitor worker:

```bash
npx cf-monitor secret SLACK_WEBHOOK_URL
# Paste your webhook URL when prompted
```

Or include it during init:

```bash
npx cf-monitor init --account-id YOUR_ID --slack-webhook https://hooks.slack.com/...
```

## Alert types

### Budget warnings

Sent when a feature's daily or monthly usage hits warning thresholds.

| Threshold | Emoji | Dedup window |
|-----------|-------|-------------|
| 70% of daily budget | Warning | 1 hour |
| 90% of daily budget | Critical | 1 hour |
| 100% (CB trips) | Circuit breaker | 1 hour |
| 70% of monthly budget | Warning | 24 hours |
| 90% of monthly budget | Critical | 24 hours |

Each alert shows: feature ID, metric name, current usage vs limit, and percentage.

### Error alerts

Sent when a new error is captured from a tailed worker. Shows: worker name, error outcome, priority level, and a link to the GitHub issue (if configured).

Dedup: tied to the error fingerprint — one alert per unique error.

### Gap alerts

Sent when workers are not sending telemetry. Shows: account name and a list of workers that haven't reported in the last hour.

Dedup: once per day (`gap:{date}` key, 24-hour TTL).

### Cost spike alerts

Sent when hourly usage exceeds the spike threshold (default: 200% of 24-hour baseline). Shows which metric spiked and by how much.

Dedup: once per metric per hour.

### Self-monitoring staleness

Sent when cf-monitor's own cron handlers haven't run within their expected intervals. Shows which handlers are stale.

Dedup: once per day (`self:stale:{date}` key, 24-hour TTL).

## Deduplication

All Slack alerts use KV-based deduplication. Before sending an alert, cf-monitor checks for a dedup key in KV (`budget:warn:{dedupKey}`). If the key exists, the alert is suppressed. If not, the alert is sent and the key is written with a TTL matching the dedup window.

This prevents alert storms during sustained incidents while still notifying you when a new issue arises.

## Message format

Alerts use Slack's Block Kit format with:

- **Header block** — alert type + account name
- **Fields block** — structured key-value pairs (feature, metric, usage, percentage)

## Testing

Use the dry-run endpoint to test Slack message formatting without sending to your webhook:

```bash
curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/test/slack-dry-run \
  -H "Content-Type: application/json" \
  -d '{"type":"budget-warning","featureId":"test","metric":"kv_reads","current":900,"limit":1000}'
```

## Troubleshooting

**No alerts appearing**: Verify `SLACK_WEBHOOK_URL` is set — run `npx cf-monitor status` and check the `slack` field.

**Duplicate alerts**: Dedup keys have TTLs. If you resolved an issue and it immediately recurred, the dedup window may have expired. This is working as intended — you want to know about recurrence.

**Alert formatting broken**: Slack Block Kit has strict requirements. If your webhook URL is for a legacy Slack integration (not an incoming webhook), it may not support blocks. Create a new incoming webhook via the Slack API.
