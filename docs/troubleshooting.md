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
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
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
   curl -X POST .../admin/cb/account \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"status":"clear"}'
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

## GitHub issues not being created

**Symptoms**: Errors are captured (visible in `GET /errors`) but no GitHub issues are created in the repo.

**Causes and fixes**:

1. **Missing `GITHUB_TOKEN` secret** — set it via `npx cf-monitor secret set GITHUB_TOKEN`. This must be a GitHub PAT with `repo` or `issues:write` scope.

2. **Missing `GITHUB_REPO` var or config** — check that either:
   - `GITHUB_REPO` is set in `.cf-monitor/wrangler.jsonc` vars, OR
   - `CF_MONITOR_CONFIG` is set (automatically embedded since v0.3.6 when `--github-repo` is passed to `init` or `cf-monitor.yaml` has `github.repo` configured)

3. **`cf-monitor.yaml` not re-embedded** — if you added `github.repo` to `cf-monitor.yaml` after initial deploy, run `npx cf-monitor deploy` to re-embed the config.

4. **Rate limited** — cf-monitor limits to 10 issues per script per hour. Check `GET /errors` for rate limit entries.

5. **Deduplication** — if the same error fingerprint already has a GitHub issue, cf-monitor won't create a duplicate. Check KV key `err:fp:{fingerprint}`.

**Verify**: Run `npx cf-monitor status` — the response shows whether GitHub is configured.

## Budget enforcement not working

**Symptoms**: usage accumulates in KV (`budget:usage:daily:*` keys) but no circuit breakers trip and no Slack warnings appear.

**Causes and fixes**:

1. **No budget config keys** — check KV for `budget:config:*` keys. If empty, the hourly budget-check cron will auto-seed defaults from `PAID_PLAN_DAILY_BUDGETS` on the next run. Trigger it manually:
   ```bash
   curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/cron/budget-check \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
   ```

2. **Config-sync not run** — if you set custom budgets in `cf-monitor.yaml`, push them to KV:
   ```bash
   npx cf-monitor config sync
   ```

3. **Seed flag active** — auto-seeding is prevented for 24 hours after the last seed (to avoid hourly KV writes). If you need to re-seed immediately, delete the flag:
   ```bash
   wrangler kv key delete "budget:config:__seeded__" --namespace-id YOUR_KV_NAMESPACE_ID
   ```

4. **`__account__` fallback** — even without per-feature configs, the `__account__` config applies to all features. If this is missing too, auto-seeding failed. Check `wrangler tail cf-monitor` for errors.

## Budget warnings not appearing in Slack

**Symptoms**: budgets are being exceeded (CB trips visible) but no Slack messages.

**Causes and fixes**:

1. **SLACK_WEBHOOK_URL not set** — run `npx cf-monitor secret set SLACK_WEBHOOK_URL` and paste your Slack incoming webhook URL.

2. **Deduplication** — budget warnings are deduplicated for 1 hour (daily) or 24 hours (monthly). If you just resolved the issue and it triggered again, the alert may be suppressed.

3. **Test the payload** — verify Slack payload formatting:
   ```bash
   curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/test/slack-dry-run \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"type":"budget-warning","featureId":"test","metric":"kv_reads","current":900,"limit":1000}'
   ```

## GitHub issues not being created

**Symptoms**: errors are captured (fingerprints in KV) but no GitHub issues appear.

**Causes and fixes**:

1. **GITHUB_REPO or GITHUB_TOKEN not set** — both are required. Run:
   ```bash
   npx cf-monitor secret set GITHUB_TOKEN
   ```
   And ensure `github.repo` is set in cf-monitor.yaml.

2. **Token permissions** — the token needs `repo` scope (classic PAT) or `issues: write` permission (fine-grained PAT).

3. **Rate limit** — max 10 issues per script per hour. If you've triggered many errors quickly, wait for the rate window to pass.

4. **Test the format** — use the dry-run endpoint to see what would be created:
   ```bash
   curl -X POST .../admin/test/github-dry-run \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
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

## Usage data shows "No usage data collected yet"

**Symptoms**: `npx cf-monitor usage` or `GET /usage` returns no data.

**Causes and fixes**:

1. **First cron hasn't run** — account usage is collected hourly on the `0 * * * *` schedule. Wait for the next hour, or trigger manually:
   ```bash
   curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/cron/collect-account-usage \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
   ```

2. **Missing CLOUDFLARE_API_TOKEN** — the same API token used for worker discovery is used for GraphQL queries. Ensure it's set as a secret on the cf-monitor worker.

3. **No services in use** — if your account has zero D1, KV, R2, etc. activity in the last 24 hours, the usage snapshot will show empty services. This is correct behaviour.

4. **GraphQL API unavailable** — the CF GraphQL Analytics API occasionally returns errors. Check the monitor worker's logs for `[cf-monitor:usage]` messages.

## Plan shows as "paid" when account is actually free

**Symptoms**: `GET /status` or `npx cf-monitor status` shows `plan: "paid"` on a Workers Free account.

**Causes and fixes**:

1. **Token lacks billing permission** — plan detection requires the `Account Settings: Read` permission (`#billing:read`) on your API token. Without it, cf-monitor conservatively defaults to "paid" (which means higher budget limits — safe but less protective for free accounts). Add the permission to your token for accurate detection.

2. **Cached result** — the detected plan is cached in KV for 24 hours. If you recently upgraded/downgraded your plan, wait for cache expiry or delete the `config:plan` KV key manually.

## Debug endpoints

These endpoints are always available on the monitor worker for troubleshooting:

| Endpoint | What it tells you |
|----------|-------------------|
| `GET /_health` | Is the monitor worker running? |
| `GET /status` | Account health, plan, billing period, CB states, GitHub/Slack config |
| `GET /errors` | Recent error fingerprints and their GitHub issue URLs |
| `GET /budgets` | Active circuit breakers, billing period |
| `GET /workers` | Which workers have been discovered on the account |
| `GET /plan` | Detected plan type, billing period, days remaining, plan allowances |
| `GET /usage` | Account-wide per-service usage from CF GraphQL (approximate) |
| `GET /self-health` | Self-monitoring: stale crons, error counts, handler breakdown |

## Admin endpoints returning 401

**Symptoms**: All `POST /admin/*` requests return `{"error":"Unauthorized"}`.

**Causes and fixes**:

1. **ADMIN_TOKEN not set** — set the secret on the cf-monitor worker:
   ```bash
   openssl rand -hex 32   # Generate a token
   npx cf-monitor secret set ADMIN_TOKEN
   ```

2. **Missing Authorization header** — admin requests require:
   ```bash
   curl -X POST .../admin/cron/budget-check \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
   ```

3. **Wrong token** — ensure the token in the header matches what was set via `secret set`. Tokens are case-sensitive.

4. **Missing "Bearer " prefix** — the header must be `Authorization: Bearer <token>`, not `Authorization: <token>`.

See [Security — Admin endpoint authentication](./security.md#admin-endpoint-authentication) for details.

## Self-monitoring shows stale crons

**Symptoms**: `GET /self-health` returns `503` with `staleCrons` listing one or more handlers.

**Causes and fixes**:

1. **Cron recently deployed** — after first deploy, it may take up to the cron interval (15 min or 1 hour) for all cron handlers to run once. Wait for the next scheduled execution.

2. **Worker not running** — check `npx cf-monitor status` and `wrangler tail cf-monitor` for errors.

3. **KV propagation** — self-monitoring timestamps are stored in KV with 48-hour TTL. Edge cache inconsistency may briefly show stale data.

4. **Actual failure** — if a specific cron handler consistently appears stale, check `wrangler tail cf-monitor` for errors during that handler's schedule. Common causes: API token expired, GitHub rate limit, Slack webhook revoked.

5. **Race condition (pre-v0.3.7)** — versions before v0.3.7 stored all cron timestamps in a single KV blob. When two crons ran concurrently (e.g. daily-rollup + worker-discovery at midnight), the last writer clobbered the other's timestamp, causing a false stale alert. Upgrade to v0.3.7+ which uses per-handler KV keys.
