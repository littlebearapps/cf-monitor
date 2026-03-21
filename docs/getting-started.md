# Getting Started with cf-monitor

This guide walks you through installing cf-monitor, deploying the monitor worker, and wrapping your first Cloudflare Worker with automatic monitoring.

## Prerequisites

- **Node.js 22+** (also works with Node 20)
- **A Cloudflare account** (free or paid)
- **At least one deployed Worker** on the account you want to monitor
- **Wrangler CLI** installed (`npm install -g wrangler`)
- **A Cloudflare API token** with Workers and Analytics Engine permissions

## Step 1: Install the SDK

```bash
npm install @littlebearapps/cf-monitor
```

This adds cf-monitor as a dependency. It includes both the runtime SDK (the `monitor()` wrapper) and the CLI (`npx cf-monitor`).

## Step 2: Initialise

```bash
npx cf-monitor init --account-id YOUR_ACCOUNT_ID
```

This provisions two resources on your Cloudflare account:

- **KV namespace** (`cf-monitor`) — stores circuit breaker state, budget counters, error fingerprints
- **Analytics Engine dataset** (`cf-monitor`) — stores all metrics (90-day retention, free tier)

It also generates two files:

- `cf-monitor.yaml` — configuration (account, GitHub, Slack, budgets)
- `wrangler.cf-monitor.jsonc` — wrangler config for the monitor worker

### Optional: add GitHub and Slack

If you want automatic GitHub issues for errors and Slack alerts for budget warnings:

```bash
npx cf-monitor init \
  --account-id YOUR_ACCOUNT_ID \
  --github-repo owner/repo \
  --slack-webhook https://hooks.slack.com/...
```

## Step 3: Deploy the monitor worker

```bash
npx cf-monitor deploy
```

This deploys a single worker called `cf-monitor` on your account. This one worker handles:

- **Tail events** — captures errors from all tailed workers
- **Cron jobs** — gap detection, budget enforcement, metrics collection, worker discovery
- **API endpoints** — status, errors, budgets, workers

## Step 4: Wire your workers

```bash
npx cf-monitor wire --apply
```

This scans your directory for wrangler config files and adds:

- `tail_consumers: [{ "service": "cf-monitor" }]` — sends tail events to the monitor
- `CF_MONITOR_KV` binding info in a comment (you add the actual binding)
- `CF_MONITOR_AE` binding info in a comment (you add the actual binding)
- `WORKER_NAME` variable — set from the wrangler config's `name` field

Run without `--apply` first to preview changes:

```bash
npx cf-monitor wire          # Preview only
npx cf-monitor wire --apply  # Apply changes
```

### Manual wiring (alternative)

Add these to each worker's wrangler config:

```jsonc
{
  "kv_namespaces": [
    { "binding": "CF_MONITOR_KV", "id": "YOUR_KV_ID" }
  ],
  "analytics_engine_datasets": [
    { "binding": "CF_MONITOR_AE", "dataset": "cf-monitor" }
  ],
  "tail_consumers": [
    { "service": "cf-monitor" }
  ],
  "vars": {
    "WORKER_NAME": "my-worker-name"
  }
}
```

## Step 5: Wrap your worker

Replace your worker's default export with the `monitor()` wrapper:

```typescript
// Before
export default {
  async fetch(request, env, ctx) {
    return new Response('Hello');
  },
};

// After
import { monitor } from '@littlebearapps/cf-monitor';

export default monitor({
  fetch: async (request, env, ctx) => {
    return new Response('Hello');
  },
});
```

That's it. `monitor()` automatically:

- Detects your worker name, bindings, and feature IDs
- Tracks all D1, KV, R2, AI, Queue, DO, Vectorize, and Workflow operations
- Checks circuit breakers before each invocation
- Writes metrics to Analytics Engine
- Accumulates daily/monthly budget counters in KV
- Adds a health endpoint at `/_monitor/health`

## Step 6: Verify

After deploying your wrapped worker, verify monitoring is working:

```bash
# Check monitor health
npx cf-monitor status

# See which workers are monitored
npx cf-monitor coverage
```

You can also hit the monitor worker's API directly:

```
GET https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/_health
GET https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/status
GET https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/workers
```

## Step 7: Configure alerts (optional)

### GitHub Issues

Set the GitHub token as a secret:

```bash
npx cf-monitor secret GITHUB_TOKEN
# Paste your token when prompted
```

The token needs `repo` scope (classic) or `issues: write` permission (fine-grained).

### Slack Alerts

```bash
npx cf-monitor secret SLACK_WEBHOOK_URL
# Paste your Slack incoming webhook URL
```

### GitHub Webhooks (bidirectional sync)

To sync issue close/reopen/mute events back to cf-monitor:

1. Set the webhook secret: `npx cf-monitor secret GITHUB_WEBHOOK_SECRET`
2. In your GitHub repo, go to Settings > Webhooks > Add webhook
3. Payload URL: `https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/webhooks/github`
4. Content type: `application/json`
5. Secret: the same value you set above
6. Events: select "Issues"

## Next steps

- [Configuration Reference](./configuration.md) — all cf-monitor.yaml and SDK options
- [Error Collection](./guides/error-collection.md) — how fingerprinting and GitHub issues work
- [Budgets & Circuit Breakers](./guides/budgets-and-circuit-breakers.md) — per-invocation limits and budget enforcement
- [Cost Protection](./guides/cost-protection.md) — how cf-monitor prevents billing surprises
- [Troubleshooting](./troubleshooting.md) — common issues and solutions
