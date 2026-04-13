# Synthetic Health Checks

cf-monitor runs an hourly self-test of its own circuit breaker pipeline. If any step fails, you find out before a real budget event relies on a broken CB.

## What it does

Every hour (on the `0 * * * *` schedule), `runSyntheticHealthCheck()` executes this 4-step sequence against a dedicated test feature ID (`cf-monitor:test:synthetic-cb`):

1. **Trip** the test CB via `tripFeatureCb()` with a 60-second TTL
2. **Verify** `checkFeatureCb()` returns `STOP`
3. **Reset** via `resetFeatureCb()` (writes `GO` with 60s TTL — see [Budgets & Circuit Breakers → Fast propagation](./budgets-and-circuit-breakers.md#fast-propagation))
4. **Verify** `checkFeatureCb()` returns `GO`

If any verification step fails, the handler logs an error with a `[cf-monitor:health]` prefix and aborts (leaving the test CB to expire via TTL).

Source: `src/worker/crons/synthetic-health.ts`.

## Setup

**Zero setup required.** The check runs automatically on every cf-monitor deployment. It only touches `CF_MONITOR_KV` — no secrets, no API tokens, no external calls.

If you don't want the check to run (e.g. to save ~4 KV ops/hour), you would need to remove the cron handler registration in `src/worker/scheduled-handler.ts` and redeploy. There is no YAML flag for this yet.

## How to tell if it's working

### Option 1 — read Workers logs

```bash
direnv exec . wrangler tail cf-monitor --format json | grep "cf-monitor:health"
```

Healthy output (once per hour):

```
[cf-monitor:health] Synthetic CB health check passed
```

Failure output (either step 2 or step 4 failed):

```
[cf-monitor:health] Synthetic CB trip failed — KV.get returned GO after put(STOP)
[cf-monitor:health] Synthetic CB reset failed — KV.get returned STOP after delete
```

### Option 2 — check `/self-health`

The self-monitoring endpoint reports the last successful run of the synthetic-health handler. See [Self-monitoring](./self-monitoring.md) for details.

```bash
curl https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/self-health
```

If `synthetic-health` appears in `staleCrons`, the hourly run has not succeeded for more than ~3× its expected interval.

## Manually trigger

If you've just deployed a code change that touches the CB pipeline and want to validate immediately (rather than wait up to 60 minutes):

```bash
curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/cron/synthetic-health \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

Then inspect `wrangler tail` for the pass/fail log line.

## When it fails

Common causes:

| Symptom | Likely cause |
|---------|--------------|
| "trip failed — returned GO after put(STOP)" | KV edge cache inconsistency. Usually self-heals within a minute. If persistent, there's a genuine KV issue. |
| "reset failed — returned STOP after delete" | Same. The `GO` + 60s TTL write pattern is designed to minimise this; persistent failures suggest a KV outage or a bug in `resetFeatureCb()`. |
| Handler never runs (`/self-health` shows stale) | `cf-monitor` worker is not deployed, or the scheduled handler is erroring out before reaching synthetic-health. Check `wrangler tail cf-monitor`. |
| All of the above after a code change to `src/sdk/circuit-breaker.ts` | The change probably broke the CB contract. Rolling back is safer than shipping. |

## What it does NOT test

- Real budget enforcement (use `POST /admin/cron/budget-check` for that)
- Slack delivery (use `POST /admin/test/slack-dry-run`)
- GitHub issue creation (use `POST /admin/test/github-dry-run`)
- Tail event ingestion (there is no synthetic version; verify by looking at `GET /errors` after a real worker error)

The synthetic health check is narrow by design: it validates that the CB primitives work, nothing more.
