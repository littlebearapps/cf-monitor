# Gatus Heartbeat Integration

cf-monitor can ping an external uptime monitor (like [Gatus](https://github.com/TwiN/gatus)) after each scheduled handler runs, so you get an independent "is the cron alive" signal that doesn't depend on cf-monitor itself.

This is a **defence-in-depth** check: if cf-monitor is broken enough that even `/self-health` can't tell you, the absence of heartbeats at your Gatus instance will.

## How the ping works

Source: `src/sdk/heartbeat.ts`.

After every scheduled handler completes, cf-monitor calls `pingHeartbeat()` which fires a fire-and-forget POST:

```
POST {GATUS_HEARTBEAT_URL}?success={true|false}
Authorization: Bearer {GATUS_TOKEN}
```

- `success=true` if the scheduled handler completed without throwing
- `success=false` if it threw (the catch block still pings)
- Failures to reach Gatus are silently swallowed (`.catch(() => {})`) — never blocks cf-monitor

The ping fires from inside `ctx.waitUntil()`, so it doesn't delay handler completion.

## Setup

### 1. On the Gatus side

Create an endpoint of type `EXTERNAL`. The minimum Gatus config looks like:

```yaml
# gatus config.yaml
external-endpoints:
  - name: cf-monitor-cron
    group: cloudflare
    token: "CHANGE_ME_LONG_RANDOM_STRING"
    alerts:
      - type: slack
        send-on-resolved: true
        failure-threshold: 3
        success-threshold: 2
```

The `token` becomes Gatus's expected `Authorization: Bearer <token>` value. Generate it with `openssl rand -hex 32`.

The full heartbeat URL you'll pass to cf-monitor is:

```
https://YOUR_GATUS_INSTANCE/api/v1/endpoints/cloudflare_cf-monitor-cron/external
```

(Gatus composes this from `{group}_{name}`.)

### 2. On the cf-monitor side

Store the Gatus token as a wrangler secret:

```bash
npx cf-monitor secret set GATUS_TOKEN
# Paste the token from step 1 when prompted
```

Then add the URL to `cf-monitor.yaml`:

```yaml
monitoring:
  heartbeat_url: "https://YOUR_GATUS_INSTANCE/api/v1/endpoints/cloudflare_cf-monitor-cron/external"
  heartbeat_token: $GATUS_TOKEN
```

Re-deploy so the config gets re-embedded:

```bash
npx cf-monitor deploy
```

### 3. Verify

The next scheduled handler to run will ping Gatus. To force an immediate test:

```bash
curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/cron/synthetic-health \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

Within a few seconds, the Gatus endpoint should flip to "healthy". Check the Gatus UI or logs.

## What fires heartbeats

Every scheduled handler dispatch pings Gatus — not just successful crons. You get a heartbeat roughly:

- Every 15 minutes (from `gap-detection` + `cost-spike`)
- Every hour (from `budget-check`, `collect-metrics`, `collect-account-usage`, `synthetic-health`)
- Once a day (from `daily-rollup`, `worker-discovery`)

So Gatus should see a ping at least every 15 minutes under normal conditions. If the gap exceeds ~20 minutes, something is wrong.

## Opting out per-handler

You cannot currently disable heartbeats for specific crons — it's all-or-nothing based on whether `GATUS_HEARTBEAT_URL` and `GATUS_TOKEN` are both set. To disable heartbeats entirely, unset the secrets:

```bash
wrangler secret delete GATUS_HEARTBEAT_URL --name cf-monitor
wrangler secret delete GATUS_TOKEN --name cf-monitor
```

The SDK also exposes an `autoHeartbeat: false` option in `MonitorConfig` that suppresses the SDK-level heartbeat in wrapped consumer workers. This is separate from the cf-monitor worker's own cron heartbeats.

## Using a non-Gatus uptime monitor

Any service that accepts a POST with a Bearer token and a `?success=` query parameter works. Examples:

- **UptimeRobot Heartbeat** — construct the URL from the monitor's push endpoint
- **Healthchecks.io** — their URL format is compatible; pass the UUID endpoint as `heartbeat_url` and any string as `GATUS_TOKEN` (Healthchecks doesn't check it, but cf-monitor requires both)
- **Custom webhook** — receive the POST at your own endpoint, inspect the `?success=` query string, alert accordingly

cf-monitor doesn't parse the response body, so any 2xx/3xx/4xx/5xx status is fine — the call is fire-and-forget.

## Troubleshooting

**Gatus stays "unhealthy" after deploy** — the heartbeat fires only after a scheduled handler runs. Trigger one manually (see "Verify" above) or wait up to 15 minutes.

**401 Unauthorized in Gatus logs** — the token on the cf-monitor side doesn't match Gatus's `token:` config. Re-run `npx cf-monitor secret set GATUS_TOKEN`.

**Heartbeats arrive but `success=false`** — cf-monitor's scheduled handler threw. Check `wrangler tail cf-monitor` for the cause. The heartbeat is working correctly; the underlying cron isn't.

**No heartbeats at all** — both `heartbeat_url` and `heartbeat_token` must resolve. Check `GET /status` to confirm they're seen; if the URL is `undefined`, verify `cf-monitor.yaml` was re-embedded via `npx cf-monitor deploy`.
