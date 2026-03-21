# Troubleshooting

Common issues and their solutions when using cf-monitor.

## Monitor worker not receiving tail events

**Symptoms**: No errors appearing in `GET /errors`, no fingerprints in KV.

**Causes and fixes**:

1. **Missing tail_consumers** — check your worker's wrangler config includes `"tail_consumers": [{ "service": "cf-monitor" }]`. Run `npx cf-monitor wire` to verify.

2. **Propagation delay** — after deploying a new worker or changing `tail_consumers`, Cloudflare takes 30-60 seconds to activate the tail binding. Wait a minute and test again.

3. **Monitor worker not deployed** — run `npx cf-monitor status` to check if the monitor worker is healthy.

4. **Worker name mismatch** — `tail_consumers` references the monitor worker by name. Ensure it matches the `name` field in the monitor worker's wrangler config (default: `cf-monitor`).

## No metrics in Analytics Engine

**Symptoms**: `npx cf-monitor status` works but AE SQL queries return no data.

**Causes and fixes**:

1. **AE write propagation** — Analytics Engine writes take 30-90 seconds to become queryable. This is a platform limitation, not a bug.

2. **Missing CF_MONITOR_AE binding** — check your worker's wrangler config includes the `analytics_engine_datasets` binding. The binding name must be `CF_MONITOR_AE`.

3. **No traffic** — AE data is only written when your worker handles requests. Hit your worker and wait 60 seconds.

4. **Zero metrics** — if all binding operations return zero (e.g. no D1 calls), the SDK skips the AE write to save cost. This is by design.

## Circuit breaker won't reset

**Symptoms**: Worker returns 503 even after waiting for TTL to expire.

**Causes and fixes**:

1. **KV edge propagation** — KV TTL expiration can take up to 60 seconds to propagate across Cloudflare's edge. Wait a full minute after expected expiry.

2. **Manual reset** — force a reset via the admin endpoint:
   ```bash
   curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/cb/reset \
     -H "Content-Type: application/json" \
     -d '{"featureId": "your-feature-id"}'
   ```

3. **Monthly budget also tripped** — daily budgets reset via TTL, but if the monthly budget is also exceeded, the CB will be re-tripped on the next hourly check. Increase the monthly budget or wait for the month to roll over.

4. **Account-level CB** — check if the account CB is active:
   ```bash
   curl https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/status
   ```
   Clear it with:
   ```bash
   curl -X POST .../admin/cb/account -H "Content-Type: application/json" -d '{"status":"clear"}'
   ```

## CLI init fails

**Symptoms**: `npx cf-monitor init` errors out.

**Causes and fixes**:

1. **Missing API token** — set `CLOUDFLARE_API_TOKEN` in your environment or pass `--api-token`.

2. **Wrong account ID** — the account ID is a 32-character hex string. Find it in the Cloudflare dashboard under Account Home > Account ID (right sidebar).

3. **Insufficient permissions** — the API token needs: Workers KV Storage (Edit), Account Analytics (Read), Workers Scripts (Edit).

4. **Network issues** — the CLI makes API calls to `api.cloudflare.com`. Ensure you're not behind a proxy that blocks these.

## Worker name shows as 'worker'

**Symptoms**: feature IDs all start with `worker:` instead of your actual worker name.

**Causes and fixes**:

1. **WORKER_NAME not set** — run `npx cf-monitor wire --apply` to automatically inject `WORKER_NAME` from your wrangler config's `name` field.

2. **Manual fix** — add to your wrangler config:
   ```jsonc
   { "vars": { "WORKER_NAME": "my-worker-name" } }
   ```

3. **SDK override** — set `workerName` in the monitor config:
   ```typescript
   monitor({ workerName: 'my-worker', fetch: handler });
   ```

**Detection chain**: `config.workerName` > `env.WORKER_NAME` > `env.name` > `'worker'`

## Budget warnings not appearing in Slack

**Symptoms**: budgets are being exceeded (CB trips visible) but no Slack messages.

**Causes and fixes**:

1. **SLACK_WEBHOOK_URL not set** — run `npx cf-monitor secret SLACK_WEBHOOK_URL` and paste your Slack incoming webhook URL.

2. **Deduplication** — budget warnings are deduplicated for 1 hour (daily) or 24 hours (monthly). If you just resolved the issue and it triggered again, the alert may be suppressed.

3. **Test the payload** — verify Slack payload formatting:
   ```bash
   curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/test/slack-dry-run \
     -H "Content-Type: application/json" \
     -d '{"type":"budget-warning","featureId":"test","metric":"kv_reads","current":900,"limit":1000}'
   ```

## GitHub issues not being created

**Symptoms**: errors are captured (fingerprints in KV) but no GitHub issues appear.

**Causes and fixes**:

1. **GITHUB_REPO or GITHUB_TOKEN not set** — both are required. Run:
   ```bash
   npx cf-monitor secret GITHUB_TOKEN
   ```
   And ensure `github.repo` is set in cf-monitor.yaml.

2. **Token permissions** — the token needs `repo` scope (classic PAT) or `issues: write` permission (fine-grained PAT).

3. **Rate limit** — max 10 issues per script per hour. If you've triggered many errors quickly, wait for the rate window to pass.

4. **Test the format** — use the dry-run endpoint to see what would be created:
   ```bash
   curl -X POST .../admin/test/github-dry-run \
     -H "Content-Type: application/json" \
     -d '{"scriptName":"my-worker","outcome":"exception","errorMessage":"test error"}'
   ```

## Feature IDs are wrong or unexpected

**Symptoms**: budget keys and AE data use unexpected feature IDs.

**Causes and fixes**:

1. **Path normalisation** — cf-monitor strips numeric segments (`/users/123` becomes `users`), UUIDs, and limits paths to 2 segments. This is intentional to prevent feature ID explosion.

2. **Explicit control** — use the `features` map for routes that need specific IDs:
   ```typescript
   monitor({
     features: {
       'POST /api/scan': 'scanner:social',
       'GET /api/users/:id': 'api:users',
     },
     fetch: handler,
   });
   ```

3. **Single bucket** — for simple workers, use `featureId` to put everything in one budget:
   ```typescript
   monitor({ featureId: 'my-worker:all', fetch: handler });
   ```

## Debug endpoints

These endpoints are always available on the monitor worker for troubleshooting:

| Endpoint | What it tells you |
|----------|-------------------|
| `GET /_health` | Is the monitor worker running? |
| `GET /status` | Account health, CB states, GitHub/Slack config status |
| `GET /errors` | Recent error fingerprints and their GitHub issue URLs |
| `GET /budgets` | Which circuit breakers are currently active |
| `GET /workers` | Which workers have been discovered on the account |
