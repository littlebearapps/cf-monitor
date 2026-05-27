# Day 0 (pre-baseline) — 2026-05-27 (Wed, 08:04 UTC)

**Purpose**: same-day head-start snapshot of production cf-monitor v0.3.11 captured the evening before the official Day 1 window starts. Records here so tomorrow's [`day1.md`](./day1.md) baseline can be compared against today's read.

**Scope**: production endpoint GETs only. **No integration suite re-run, no AI Gateway feature observation** — those belong to tomorrow's Day 1 so the per-day samples don't overlap.

**Verdict**: 🟢 healthy across the board.

## Production cf-monitor health checks (v0.3.11)

| Endpoint | HTTP | RTT | Result |
|---|---|---|---|
| `GET /_health` | 200 | 114 ms | `healthy:true, account:platform` |
| `GET /self-health` | 200 | 187 ms | `healthy:true, staleCrons:[], errors:0` — see cron table below |
| `GET /status` | 200 | 135 ms | `plan:paid, workers.count:23, CB.global:inactive, CB.account:active, github+slack:configured` |
| `GET /budgets` | 200 | 118 ms | `count:0` (no tripped CBs); `billingPeriod: 2026-05-02 → 2026-06-02` |
| `GET /workers` | 200 | 93 ms | `count:23` — exact list matches `cloudflare-infrastructure.md` (incl. `nsd-cost-alarm`, `nsd-leads-gateway`) |
| `GET /errors` | 200 | 621 ms | `count:13` historical fingerprints, all linked to `littlebearapps/platform` issues |
| `GET /usage` | 200 | 127 ms | 24h aggregates populated; `services.aiGateway:` absent (v0.3.11 doesn't collect AI Gateway) |

## Cron staleness (Day 0 snapshot)

| Handler | Schedule | Last run (UTC) | Stale? |
|---|---|---|---|
| `gap-detection` | */15 | 2026-05-27T08:00:40.615Z | no |
| `cost-spike` | */15 | 2026-05-27T08:00:40.114Z | no |
| `collect-metrics` | hourly | 2026-05-27T08:00:41.154Z | no |
| `collect-account-usage` | hourly | 2026-05-27T08:00:41.134Z | no |
| `budget-check` | hourly | 2026-05-27T08:00:41.733Z | no |
| `synthetic-health` | hourly | 2026-05-27T08:00:40.811Z | no |
| `daily-rollup` | daily | 2026-05-27T00:00:34.535Z | no |
| `worker-discovery` | daily | 2026-05-27T00:00:41.915Z | no |

All 8 production handlers fired within their `maxStaleMinutes` thresholds. Snapshot taken ~4 min after the hourly top-of-hour cron batch — everything fresh.

**Note**: `collect-ai-gateway-usage` is **absent** from this list — it ships with v0.4.0 and production is still on v0.3.11. Expected.

## /usage snapshot (Day 0 baseline numbers)

Collected at `2026-05-27T08:00:39Z` (24h rolling window).

| Service | Metric | Used | Monthly allowance | % of monthly (proj) |
|---|---|---|---|---|
| Workers | requests | 7,195 | 10M | ~2.2% |
| Workers | cpuMs | 3,396 | 30M | trivial |
| D1 | rowsRead | 2,442,075 | 5B | 1.5% |
| D1 | rowsWritten | 29,883 | 50M | 1.8% |
| KV | reads | 5,909 | 10M | 1.8% |
| KV | writes | 1,938 | 1M | 5.9% (highest %, but well-headed) |
| KV | deletes | 221 | 1M | trivial |
| KV | lists | 68 | 1M | trivial |
| R2 | classA | 180,885 | 1M | 18.1% (highest, worth watching) |
| R2 | classB | 4 | 10M | trivial |

**Watch in coming days**: R2 classA is the biggest projected-monthly % at 18%, still comfortable but worth tracking the daily trend through Day 7.

## Error fingerprints in flight (13)

All 13 fingerprints in `/errors` have a corresponding GitHub issue URL (sync working). Fingerprints span the legacy 32-char hex format (older error-collector entries) and the newer 8-char hex format (post-v0.3.8 normalisation work). Distribution:

- 11 fingerprints in the new 8-char format → recent activity.
- 2 fingerprints in the old 32-char format (`c443d1d6...`, `e6b146f3...`) → historical, issues #186 and #250 — probably long-resolved, KV TTL just hasn't reaped them.

No action — they're tracked, just noting them so tomorrow's `/errors.count` Δ shouldn't surprise.

## Day 1 baseline expectations (for tomorrow)

When you run `day1.md` tomorrow, expect:

- `/self-health` should still be `healthy:true` with `staleCrons:[]`.
- `/budgets.count` should still be 0.
- `/workers.count` likely still 23 (NSD work is stable).
- `/errors.count` may be +0/+1/+2 vs today (organic growth).
- `/usage` daily numbers should be slightly higher (24h rolling window catches more activity).
- New 24h Δ measurable for the first time on Day 2.

## Raw capture

Full HTTP responses captured to `/tmp/cfmon-day0-prod-baseline.txt` for cross-reference. Not committed (transient, regenerable).

## Not done today (deliberate, tomorrow's work)

- Integration suite re-run + AI Gateway perf measurement.
- Billing dashboard $/day capture (CF $ figures lag 24-48h anyway; tomorrow's first read is fine).
- Issue triage for tracking issues #115/116/117 (let GitHub assignees see them overnight first).

---

**Next**: tomorrow morning (2026-05-28) execute [`day1.md`](./day1.md) as the official Day 1.
