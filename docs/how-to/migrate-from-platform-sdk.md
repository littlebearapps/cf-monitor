# Migrating from platform-consumer-sdk

This guide walks you through migrating from `@littlebearapps/platform-consumer-sdk` to `@littlebearapps/cf-monitor`. The migration simplifies your monitoring infrastructure from 10+ workers per account down to 1.

## Why migrate?

| | platform-consumer-sdk | cf-monitor |
|---|---|---|
| **Workers** | 10+ platform workers + agents | 1 worker per account |
| **Storage** | D1 (61 migrations) + KV + Queue | AE + KV only |
| **Config** | services.yaml + budgets.yaml + sync | 1 cf-monitor.yaml |
| **Setup** | 7+ manual steps | 3 CLI commands |
| **SDK API** | 18 sub-path exports | 1 export: `monitor()` |
| **Cross-account** | HMAC secrets, agents | Not needed |

## Automated migration

cf-monitor includes a migration CLI that reads your existing config and generates the equivalent cf-monitor setup:

```bash
npx cf-monitor migrate --from platform-consumer-sdk
```

This reads your existing `.platform-agent.json`, `services.yaml`, and `budgets.yaml`, then generates `cf-monitor.yaml` with equivalent settings.

## Manual migration

### Step 1: Install cf-monitor

```bash
npm install @littlebearapps/cf-monitor
```

### Step 2: Update your worker code

```typescript
// Before
import { platformWorker } from '@littlebearapps/platform-consumer-sdk/worker';

export default platformWorker({
  project: 'scout',
  workerName: 'scout-harvester',
  cronFeature: (cron) => ({
    '0 2 * * *': 'scout:cron:arxiv-harvest',
  })[cron],
  requestLimits: { d1Writes: 500 },
  fetch: handler,
  scheduled: cronHandler,
});

// After
import { monitor } from '@littlebearapps/cf-monitor';

export default monitor({
  limits: { d1Writes: 500 },
  features: {
    '0 2 * * *': 'cron:arxiv-harvest',
  },
  fetch: handler,
  scheduled: cronHandler,
});
```

**Key changes:**

- `platformWorker()` → `monitor()`
- `project` parameter — **removed**. cf-monitor operates at account scope, not project scope
- `workerName` — **auto-detected** from `env.WORKER_NAME` (set by `wire --apply`). Only specify if you need a custom name
- `cronFeature` function → `features` map (simpler)
- `requestLimits` → `limits`
- Remove `completeTracking()` from `finally` blocks — cf-monitor handles cleanup automatically

### Step 3: Update wrangler bindings

| Old binding | New binding | Type |
|-------------|-------------|------|
| `PLATFORM_CACHE` | `CF_MONITOR_KV` | KV |
| `PLATFORM_ANALYTICS` | `CF_MONITOR_AE` | Analytics Engine |
| `PLATFORM_TELEMETRY` | *(remove)* | Queue — no longer needed |
| `TELEMETRY_QUEUE` | *(remove)* | Queue producer — no longer needed |

```jsonc
// Before
{
  "kv_namespaces": [
    { "binding": "PLATFORM_CACHE", "id": "..." }
  ],
  "analytics_engine_datasets": [
    { "binding": "PLATFORM_ANALYTICS", "dataset": "cf-monitor" }
  ],
  "queues": {
    "producers": [{ "binding": "TELEMETRY_QUEUE", "queue": "platform-telemetry" }]
  }
}

// After
{
  "kv_namespaces": [
    { "binding": "CF_MONITOR_KV", "id": "..." }
  ],
  "analytics_engine_datasets": [
    { "binding": "CF_MONITOR_AE", "dataset": "cf-monitor" }
  ],
  "tail_consumers": [
    { "service": "cf-monitor" }
  ],
  "vars": {
    "WORKER_NAME": "my-worker"
  }
}
```

Or use the CLI to auto-wire: `npx cf-monitor wire --apply`

### Step 4: Remove old infrastructure

After verifying cf-monitor is working:

1. **Remove platform-agent worker** from dedicated accounts
2. **Delete platform-telemetry queue** and its DLQ
3. **Remove HMAC secrets** (`CENTRAL_HMAC_SECRET`, `PROXY_TOKEN_ID`, `PROXY_TOKEN_SECRET`)
4. **Uninstall the old SDK**: `npm uninstall @littlebearapps/platform-consumer-sdk`

### Step 5: Set up cf-monitor

```bash
npx cf-monitor init --account-id YOUR_ACCOUNT_ID \
  --github-repo owner/repo \
  --slack-webhook https://hooks.slack.com/...

npx cf-monitor deploy
```

## Feature ID mapping

The old SDK used `project:category:name` format (e.g. `scout:cron:arxiv-harvest`). cf-monitor uses `worker:handler:discriminator` (e.g. `my-worker:cron:0-2-x-x-x`).

If you need the old naming style, use `featurePrefix`:

```typescript
monitor({
  featurePrefix: 'scout',  // → scout:fetch:GET:api-items, scout:cron:0-2-x-x-x
  fetch: handler,
});
```

Or use the `features` map for exact control over specific routes.

## Budget migration

Platform-consumer-sdk used `budgets.yaml` with per-project budgets. cf-monitor uses `cf-monitor.yaml` with per-account budgets, or auto-seeds defaults from your CF plan.

If you had custom budgets, move them to `cf-monitor.yaml`:

```yaml
budgets:
  daily:
    d1_writes: 100000    # Was in budgets.yaml under your project
    kv_writes: 5000
  monthly:
    d1_writes: 2000000
```

Or let cf-monitor auto-seed from your plan detection — the defaults are sensible for most workloads.

## Verification checklist

After migration, verify everything works:

```bash
# Monitor worker is healthy
npx cf-monitor status

# All workers are discovered
npx cf-monitor coverage

# Budget enforcement is active
curl https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/budgets

# Slack alerts work
curl -X POST .../admin/test/slack-dry-run \
  -H "Content-Type: application/json" \
  -d '{"type":"budget-warning","featureId":"test","metric":"kv_reads","current":900,"limit":1000}'
```

## Rollback plan

Both SDKs can coexist temporarily since they use different KV and AE binding names. If you need to roll back:

1. Restore `PLATFORM_CACHE`, `PLATFORM_ANALYTICS`, and `PLATFORM_TELEMETRY` bindings
2. Change `monitor()` back to `platformWorker()`
3. Re-deploy the affected workers

Remove the old bindings only after you've verified cf-monitor is stable.
