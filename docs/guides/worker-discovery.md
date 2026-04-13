# Worker Discovery

cf-monitor auto-discovers all workers on your Cloudflare account — no manual registry needed.

> ⚠️ **Discovery is daily, not real-time.** The cron runs once every 24 hours at **midnight UTC**. A worker you deploy at 00:05 UTC won't be visible to cf-monitor until ~24 hours later unless you manually trigger discovery. "Auto-discovery" means you don't maintain a registry — it does not mean instant detection. Trigger manually after deploys if you want immediate visibility: `POST /admin/cron/worker-discovery`.

## How it works

The `worker-discovery` cron runs daily at midnight UTC (`0 0 * * *`). It calls the Cloudflare Workers Scripts API:

```
GET /accounts/{account_id}/workers/scripts
```

Each discovered worker is stored in KV:

- `workers:list` — JSON array of all worker names (25-hour TTL)
- `workers:{name}` — per-worker metadata: name, last modified date, discovery timestamp (25-hour TTL)

## What's excluded

cf-monitor always excludes itself from gap detection and coverage checks. Additionally, you can exclude workers by name pattern in your config:

```yaml
# cf-monitor.yaml
exclude:
  - "test-*"     # Skip test workers
  - "dev-*"      # Skip dev workers
```

Excluded workers are still discovered but won't trigger gap alerts.

## API

| Endpoint | Purpose |
|----------|---------|
| `GET /workers` | Returns the full list of discovered workers |
| `POST /admin/cron/worker-discovery` | Manually trigger discovery |

## Dependencies

- **Gap detection** depends on discovery — if discovery hasn't run yet, gap detection silently skips until the first `workers:list` key exists
- **Coverage CLI** (`npx cf-monitor coverage`) reads the same `workers:list` KV key

## Requirements

The `CLOUDFLARE_API_TOKEN` secret must be set on the cf-monitor worker. The token needs `Workers Scripts: Read` permission.

If no token is configured, discovery is skipped and `GET /workers` returns an empty list. Gap detection falls back to KV-based `last_seen` timestamps from SDK heartbeats.

## Troubleshooting

**Workers not appearing**: Discovery runs daily. Trigger it manually with `POST /admin/cron/worker-discovery` or wait for the next midnight UTC run.

**Empty worker list**: Check that `CLOUDFLARE_API_TOKEN` is set and has the correct permissions. Run `npx cf-monitor status` to verify.

**Stale data**: Worker metadata has a 25-hour TTL. If a worker was deleted from your account, it will disappear from the list within 25 hours.
