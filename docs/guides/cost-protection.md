# Cost Protection

cf-monitor exists because of a real billing incident. This guide explains how it prevents billing surprises on your Cloudflare account.

## The $4,868 story

In January 2026, two bugs on a Cloudflare Workers project produced a combined $4,868 in overage charges:

- **An infinite D1 write loop** ran for 3 days before anyone noticed, inserting 4.8 billion rows ($3,434 in D1 write charges)
- **A deployment bug** caused a worker to restart repeatedly, each restart triggering a fresh data sync ($910 in additional writes)

The monitoring system at the time was centralised — it collected telemetry from all accounts into a single D1 database. When the monitored projects moved to dedicated Cloudflare accounts, the monitoring broke, and the bugs went undetected.

cf-monitor was built to ensure this never happens again.

## Five layers of protection

### Layer 1: Per-invocation limits

**What**: hard limits on binding operations per single worker invocation.

**When**: checked synchronously, on every proxied method call. A `RequestBudgetExceededError` is thrown the moment a limit is exceeded.

**Default limits**: d1Writes: 1000, d1Reads: 5000, kvWrites: 200, kvReads: 1000, aiRequests: 50, r2ClassA: 100, queueMessages: 500.

**Why it works**: the infinite write loop from January 2026 would have been stopped on its very first invocation at row 1,001.

### Layer 2: Hourly budget enforcement

**What**: daily and monthly budget limits per feature, checked every hour.

**When**: the `budget-check` cron runs at `0 * * * *`, compares accumulated usage in KV against configured limits.

**Thresholds**: Slack warning at 70%, critical at 90%, circuit breaker trip at 100%.

**Why it works**: even if per-invocation limits are generous, this catches sustained overuse within hours rather than discovering it on the invoice.

### Layer 3: Circuit breakers

**What**: automatic kill switches at feature, account, and global levels.

**When**: tripped by budget enforcement (Layer 2). All subsequent requests to the affected feature return 503. Auto-resets after TTL (default: 1 hour).

**Why it works**: once a budget is hit, the feature stops immediately. No human intervention needed.

### Layer 4: Cost spike detection

**What**: anomaly detection comparing current hourly costs to a 24-hour baseline.

**When**: runs every 15 minutes via the `cost-spike` cron. Alerts when usage exceeds 200% of baseline (configurable).

**Why it works**: catches unusual patterns that fall within budget limits but are still abnormal — like a sudden 10x increase in D1 reads from a new code path.

### Layer 5: Fail-open design

**What**: if cf-monitor itself has an error, your worker keeps running normally.

**When**: always. Every internal operation is wrapped in try-catch.

**Why it works**: monitoring should never become the problem. A KV outage shouldn't bring down your production workers.

## Cloudflare pricing reference

cf-monitor tracks costs using these per-unit prices (Workers Paid plan):

| Resource | Price per unit | Free tier |
|----------|---------------|-----------|
| D1 reads | $0.25 / 1M queries | 5B rows/month |
| D1 writes | $0.75 / 1M queries | 50M rows/month |
| KV reads | $0.50 / 1M | 10M/month |
| KV writes | $5.00 / 1M | 1M/month |
| R2 Class A (mutations) | $0.0015 / 1K | 1M/month |
| R2 Class B (reads) | $0.01 / 1M | 10M/month |
| AI neurons | $0.011 / 1K | 10K/day free |
| Queue messages | $0.40 / 1M | — |
| DO requests | $0.15 / 1M | — |
| Vectorize queries | $0.01 / 1K | 30M queried dimensions/month |

## cf-monitor's own cost

cf-monitor is designed to add negligible cost to your account:

| Operation | Per event | Typical daily total |
|-----------|-----------|-------------------|
| Tail handler | ~1 KV read + ~1 KV write per **unique** error | < 100 ops |
| Cron handler | ~10 KV reads + ~5 AE writes per hourly run | ~360 ops |
| AE writes | Free (all metrics go to Analytics Engine) | 0 cost |
| **Total KV ops** | | **< 1,000/day** |

At $0.50/M reads and $5/M writes, cf-monitor costs well under $0.01/day even on busy accounts.

Analytics Engine writes are free up to 100M/month — cf-monitor typically uses a few thousand per day.

## Budget configuration examples

### Conservative (free plan)

```yaml
budgets:
  daily:
    d1_writes: 10000
    d1_reads: 100000
    kv_writes: 500
    kv_reads: 10000
  monthly:
    d1_writes: 200000
    kv_writes: 10000
```

### Standard (paid plan)

```yaml
budgets:
  daily:
    d1_writes: 100000
    d1_reads: 1000000
    kv_writes: 5000
    kv_reads: 100000
    ai_requests: 5000
    r2_class_a: 10000
  monthly:
    d1_writes: 2000000
    kv_writes: 100000
```

### Per-invocation (in worker code)

```typescript
monitor({
  limits: {
    d1Writes: 100,       // Very tight for a simple API
    kvWrites: 20,
    aiRequests: 5,
  },
  fetch: handler,
});
```

## Further reading

- [Budgets & Circuit Breakers](./budgets-and-circuit-breakers.md) — detailed mechanics of budget enforcement and CB states
- [Configuration Reference](../configuration.md) — all budget configuration options
- [Troubleshooting](../troubleshooting.md) — what to do when a circuit breaker trips
