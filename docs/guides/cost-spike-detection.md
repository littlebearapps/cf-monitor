# Cost Spike Detection

cf-monitor compares each worker's hourly resource usage against its 24-hour baseline and alerts when any metric exceeds 200% of the average. This catches anomalies that stay *within* budget but are still unusual — like a worker suddenly doing 10× more D1 reads than normal.

## What it does

Every 15 minutes (`*/15 * * * *`), `detectCostSpikes()` queries Analytics Engine for:

- **Current hour** (last 60 minutes) — per-worker totals for each cost metric
- **Baseline** (last 24 hours) — summed, then divided by 24 to get a per-hour average

For each `(worker, metric)` pair where both values exceed `MIN_METRIC_VALUE` (10), it computes `ratio = current / baseline_avg`. If `ratio ≥ 2.0`, a Slack alert is sent with a **1-hour dedup key** (`spike:{worker}:{metric}:{hour}`).

Metrics tracked: `d1_writes`, `d1_reads`, `kv_writes`, `kv_reads`, `ai_neurons`, `r2_class_a`, `r2_class_b`, `queue_messages`.

Source: `src/worker/crons/cost-spike.ts`.

## Setup

### Required

| Requirement | Why |
|-------------|-----|
| `CLOUDFLARE_API_TOKEN` with **Account Analytics: Read** | The cron queries AE via the CF GraphQL API |
| `CF_ACCOUNT_ID` | Needed to target the AE query at your account |
| `CF_MONITOR_AE` binding with data in it | The baseline is computed from your own workers' AE writes — if no worker is wrapped with `monitor()`, there is nothing to compare |

### Optional (for alerts)

| Requirement | Why |
|-------------|-----|
| `SLACK_WEBHOOK_URL` | Without it, spikes are detected but you won't be notified. Check `wrangler tail cf-monitor` for `[cost-spike]` log entries. |

If `CLOUDFLARE_API_TOKEN` or `CF_ACCOUNT_ID` is missing, the handler exits early with no error.

## Tuning the threshold

> 🚧 **Config key exists but is not yet wired in v0.3.7.** `cf-monitor.yaml` accepts `monitoring.spike_threshold` and the schema validates it (range ≥ 1.5, default 2.0), but `src/worker/crons/cost-spike.ts:7` hardcodes `const SPIKE_THRESHOLD = 2.0;`. Values you set in YAML are currently ignored.

```yaml
# cf-monitor.yaml — parses but has no effect in v0.3.7
monitoring:
  spike_threshold: 3.0    # Intended: 300% of baseline before alerting
```

Until the threshold becomes configurable, the only way to change it is to fork cf-monitor and edit the constant.

## Alert shape

A Slack alert looks like:

> :chart_with_upwards_trend: **Cost Spike: `my-account`**
>
> **Worker:** `my-worker`
> **Metric:** `d1_reads`
> **Current:** 45,000 (last hour)
> **Baseline:** 4,200/hr (24h avg)
> **Ratio:** 10.7×
> **Est. cost:** $0.045

The estimated cost uses the `CF_PRICING` table in `src/constants.ts`. Pricing is approximate and excludes plan-included allowances.

## Dedup behaviour

Each `(worker, metric, hour)` triplet gets at most one Slack message per hour. If `my-worker`'s `d1_reads` is spiking for 3 hours straight, you get 3 alerts (one per hour) — not one every 15 minutes.

To suppress an alert during a known event, either:
- Wait for the hour to tick over (the dedup key uses `currentHourKey()`)
- Let the baseline "catch up" — after 24 hours of elevated traffic, the new level becomes the baseline and ratios normalise

## Relationship to budgets

Cost spike detection is **Layer 4** (observational) in the [Budgets & Circuit Breakers](./budgets-and-circuit-breakers.md) stack. It does NOT trip a circuit breaker — it only alerts. If a spike also crosses a daily budget, the hourly `budget-check` cron handles the CB trip separately.

| Layer | Triggers on | Effect |
|-------|-------------|--------|
| Per-invocation limits (1) | Single request exceeds `RequestLimits` | Throws, request returns 500 |
| Daily budget (2) | Accumulated daily usage ≥ 100% of limit | CB trips, requests return 503 |
| Monthly budget (2b) | Accumulated monthly usage ≥ 100% of limit | CB trips |
| Circuit breakers (3) | Any of the above, or manual trip via admin | 503 until TTL expires |
| **Cost spike (4)** | **Current hour ≥ 2× 24h baseline for this worker/metric** | **Slack alert only** |

## Manually trigger

```bash
curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/cron/cost-spike \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

## When it's noisy

Because baselines reset on a rolling 24-hour window, the most common false positives are:

- **Cold-start periods** — a worker that's been idle for hours will spike to ~∞× when it does anything. Mitigated by `MIN_METRIC_VALUE: 10` (both current and baseline must exceed 10), but still fires if a worker goes from 0 to 50.
- **Daily batch jobs** — a worker that runs once a day will spike 24× on that hour. Consider excluding batch workers via the `exclude:` pattern in `cf-monitor.yaml`.
- **Traffic growth** — steady month-over-month growth may trigger repeated alerts. The baseline adapts within 24 hours, so this self-corrects.

## When it's quiet but shouldn't be

If you expect spikes (e.g. during a load test) and don't see alerts:

1. Check `CLOUDFLARE_API_TOKEN` and `CF_ACCOUNT_ID` — `npx cf-monitor status` confirms both
2. Check `SLACK_WEBHOOK_URL` is set
3. Confirm the worker in question is wrapped with `monitor()` and is writing to AE — query `SELECT count() FROM "cf-monitor" WHERE blob1 = 'my-worker'`
4. Confirm baseline has accumulated — a worker needs 24 hours of data before meaningful comparisons are possible
5. Check dedup — `wrangler kv key get "alert:spike:my-worker:d1_reads:2026-04-13T14" --namespace-id YOUR_KV_ID`
