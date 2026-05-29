# Day 3 — 2026-05-30 (Sat) — First-quartile + cron staleness deep dive

## Goals

1. 48h cumulative health check — production cf-monitor has now run on v0.3.11 across two full diurnal cycles.
2. Cron staleness deep dive — verify each of the 9 production cron handlers (per `CRON_HANDLER_REGISTRY`) has fired within its `maxStaleMinutes`.
3. Cost trend over 48h — first weekend-onset effect visible?
4. Issue burn-rate check — are Day 1-2 issues moving?

## Production cf-monitor health checks (v0.3.11)

Same shell-block as Day 2. Output → `/tmp/cfmon-day3-prod.json`.

### Trend table (record actuals)

| Field | Day 1 | Day 2 | Day 3 | OK band |
|---|---|---|---|---|
| `/self-health.staleCrons.length` | (record) | (record) | (record) | always 0 |
| `/self-health.todayErrors` | (record) | (record) | (record) | < 50 |
| `/status.workers.count` | (record) | (record) | (record) | 23 ± 1 |
| `/budgets.count` | (record) | (record) | (record) | 0 |
| `/errors.count` | (record) | (record) | (record) | small growth |
| `/usage.workers.requests` | (record) | (record) | (record) | growth |
| `/usage.d1.rowsWritten` | (record) | (record) | (record) | **bounded** |
| `/usage.kv.writes` | (record) | (record) | (record) | bounded |

**Trend rule**: each metric should be monotonically growing (counters) or flat (binary states). Sudden drops in cumulative-usage counters are usually time-window resets — sanity-check by looking at `/usage.collected_at`.

## Cron staleness deep dive

Pull `GET /self-health` and read the `crons` object. Cross-reference against `CRON_HANDLER_REGISTRY` from `src/constants.ts` (current registered handlers + their `maxStaleMinutes`):

| Handler | Schedule | maxStaleMinutes | Day 3 last_run (record) | Stale? |
|---|---|---|---|---|
| `gap-detection` | */15 | 45 | _record_ | _Y/N_ |
| `cost-spike` | */15 | 45 | _record_ | _Y/N_ |
| `collect-metrics` | hourly | 150 | _record_ | _Y/N_ |
| `collect-account-usage` | hourly | 150 | _record_ | _Y/N_ |
| `budget-check` | hourly | 150 | _record_ | _Y/N_ |
| `synthetic-health` | hourly | 150 | _record_ | _Y/N_ |
| `daily-rollup` | daily | 1500 | _record_ | _Y/N_ |
| `worker-discovery` | daily | 1500 | _record_ | _Y/N_ |

**Note**: `collect-ai-gateway-usage` is **not** yet in production v0.3.11 — it ships with v0.4.0. Expect it absent from production `/self-health`.

**Action**: file P1 issue per stale handler. Triage at next cron firing.

## AI Gateway feature observation

```bash
cd cf-monitor && git checkout feature/ai-gateway-usage-collection
direnv exec . npm run test:integration 2>&1 | tee /tmp/cfmon-day3-int.log
grep "ai-gateway:perf" /tmp/cfmon-day3-int.log
```

### Perf trend

| Metric | Day 1 | Day 2 | Day 3 | OK band |
|---|---|---|---|---|
| `cron_durationMs` p50 | _record_ | _record_ | _record_ | < 1000ms, ±20% Day-to-day |
| `cron_durationMs` max | _record_ | _record_ | _record_ | < 5000ms |
| AE rows after run | _record_ | _record_ | _record_ | bounded by gateway log volume |
| KV writes per run | _record_ | _record_ | _record_ | ≤ 1 |

### AI Gateway log accumulation

```text
mcp__cloudflare-ai-gateway__list_logs gateway_id=platform per_page=10
```

| Day | total_count | 24h Δ | 48h Δ vs Day 1 |
|---|---|---|---|
| Day 1 | _record_ | n/a | n/a |
| Day 2 | _record_ | _record_ | _record_ |
| Day 3 | _record_ | _record_ | _record_ |

**Action**: file P2 if 48h Δ > 200 (would suggest a new persistent consumer worker started writing to AI Gateway).

## Billing observation — 48h trend

| Service | Day 1 $/day | Day 2 $/day | Day 3 $/day | 48h Δ% | Action if > 2× |
|---|---|---|---|---|---|
| Workers | _record_ | _record_ | _record_ | _record_ | P0 |
| D1 | _record_ | _record_ | _record_ | _record_ | **P0** |
| KV | _record_ | _record_ | _record_ | _record_ | P1 |
| R2 | _record_ | _record_ | _record_ | _record_ | P1 |
| AI Gateway | _record_ | _record_ | _record_ | _record_ | P2 |
| Durable Objects | _record_ | _record_ | _record_ | _record_ | P1 |
| MTD total | _record_ | _record_ | _record_ | _record_ | informational |

**Weekend effect note**: traffic may dip Sat-Sun; record but don't escalate unless cf-monitor itself is generating unexpected cost (cf-monitor's overhead is fixed — daily-rollup + worker-discovery midnight + ~5 KV ops per cron firing).

## Issue triage

```bash
gh issue list -R littlebearapps/cf-monitor --state open --label "v0.4.0-rollout"
```

(Use the label only if you've been applying it. Otherwise just `--state open` and filter mentally.)

### Pre-existing tracking issues

| Issue | State | Last update | Days open | Notes |
|---|---|---|---|---|
| [#115](https://github.com/littlebearapps/cf-monitor/issues/115) | _record_ | _record_ | 3 | Trivial — should be closed by now? |
| [#116](https://github.com/littlebearapps/cf-monitor/issues/116) | _record_ | _record_ | 3 | Investigation — comments? |
| [#117](https://github.com/littlebearapps/cf-monitor/issues/117) | _record_ | _record_ | 3 | Trivial — should be closed by now? |

### Day-1 + Day-2 issues to verify

List every issue filed in those days. For each:
- Open + assigned: status quo.
- Open + unassigned: assign yourself or @ a maintainer.
- Closed: confirm the fix actually landed by re-running the affected health check.
- Closed + observed regression: re-open with a comment.

## Anomaly checklist

- **First weekend rollover**: did `daily-rollup` cron fire at midnight UTC Saturday and Sunday? `GET /self-health.crons['daily-rollup'].lastRun` should be within ~1500min of now.
- **CB churn**: `GET /budgets` over 24h. Any feature that has been tripping/resetting repeatedly?
- **Slack noise**: are you getting alerts that the dedup window isn't suppressing?

## Tomorrow setup

[`day4.md`](./day4.md) is the midpoint review. It will ask: "based on Days 1-3, do we expect to ship v0.4.0 on Day 7?" Populate this file's tables fully so Day 4 can quote them.

## Verification (do before closing this day)

- [ ] All trend rows populated.
- [ ] Cron staleness table fully checked.
- [ ] 48h cost delta computed.
- [ ] Issue triage decisions recorded.
- [ ] No new unexplained P0/P1 issues.
