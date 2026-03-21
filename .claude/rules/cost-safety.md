# Cost Safety Rules

cf-monitor exists because of a $4,868 billing incident. These rules are non-negotiable.

## Per-Invocation Limits (DEFAULT_REQUEST_LIMITS)

Every `monitor()` wrapper enforces default per-invocation limits:
- `d1Writes: 1000` — prevents infinite write loops
- `d1Reads: 5000`
- `kvWrites: 200` — KV writes cost 10x reads
- `kvReads: 1000`
- `aiRequests: 50`
- `r2ClassA: 100`
- `queueMessages: 500`

These throw `RequestBudgetExceededError` immediately. They are the first line of defence.

## Budget Enforcement (Hourly Cron)

The `budget-check.ts` cron reads daily usage from KV and compares against limits:
- **70%** → Slack warning (deduped 1hr)
- **90%** → Slack critical (deduped 1hr)
- **100%** → Circuit breaker TRIPPED + Slack alert

CB auto-resets after TTL (default 1hr).

## Monitor Worker's Own Cost

The cf-monitor worker itself must be cost-efficient:
- Tail handler: ~1 KV read (dedup) + ~1 KV write (fingerprint) per unique error
- Cron handler: ~10 KV reads + ~5 AE writes per hourly run
- Total: well under 1000 KV ops/day

## AE vs KV Cost Trade-off

| Operation | AE | KV |
|-----------|----|----|
| Write | Free (100M/month) | $5/M |
| Read/Query | Free (SQL API) | $0.50/M |

Always prefer AE writes over KV writes for metrics. Use KV only for state (CB, dedup, config).
