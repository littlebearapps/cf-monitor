# Day 2 — 2026-05-29 (Fri) — Verify Day-1 issues + 24h delta

## Goals

1. Re-check every endpoint captured in [`day1.md`](./day1.md) and compute deltas.
2. Verify any P0/P1/P2 issues filed Day 1 are open with reasonable triage status.
3. Track AI Gateway log accumulation on `platform` over the last 24h (should be small — `platform-auditor` runs once/day, `pattern-discovery` similar).
4. Re-run the AI Gateway integration test — perf should be flat ±20% of Day-1 sample.

## Production cf-monitor health checks (v0.3.11)

Run the same shell-block as Day 1, redirecting to `/tmp/cfmon-day2-prod.json`. Compare each field against `/tmp/cfmon-day1-prod-baseline.json`.

### Delta table (record actuals)

| Endpoint | Field | Day 1 | Day 2 | Δ | Action if Δ surprising |
|---|---|---|---|---|---|
| `/_health` | `healthy` | (record) | (record) | n/a | P0 if false |
| `/self-health` | `staleCrons.length` | (record) | (record) | should be 0 → 0 | P1 if any cron stale > 2× threshold |
| `/self-health` | `todayErrors` | (record) | (record) | < 50 either day | P1 if > 50 in 24h |
| `/status` | `workers.count` | (record) | (record) | should be stable | P2 if dropped (workers deleted?) |
| `/budgets` | `count` | (record) | (record) | flat or 0 | P1 if a new CB tripped overnight |
| `/errors` | `count` | (record) | (record) | small +Δ ok | P1 if large +Δ (>5 new fingerprints/day) |
| `/usage` | `usage.services.workers.requests` | (record) | (record) | growth normal | P2 if Δ → 0 (workers idle that shouldn't be) |
| `/usage` | `usage.services.kv.writes` | (record) | (record) | growth normal | P0 if Δ ≫ baseline (write storm) |
| `/usage` | `usage.services.d1.rowsWritten` | (record) | (record) | growth normal | **P0 if Δ ≫ baseline** (Jan 2026 incident pattern!) |

**Special check — D1 write rate**: the January 2026 incident pattern is sudden D1 write spike from infinite-loop bugs. If `d1.rowsWritten` Day 2 - Day 1 > 1M and no obvious cause: file P0 immediately.

## AI Gateway feature observation

```bash
cd cf-monitor
git checkout feature/ai-gateway-usage-collection
direnv exec . npm run test:integration 2>&1 | tee /tmp/cfmon-day2-int.log
grep -E "ai-gateway:perf|Test Files|Tests " /tmp/cfmon-day2-int.log | tail -10
```

### Compare against Day 1

| Metric | Day 1 (record) | Day 2 (record) | Δ | OK if |
|---|---|---|---|---|
| `cron_durationMs` p50 | _from day1.md_ | _record_ | ±20% | within ±20% |
| `cron_durationMs` max | _from day1.md_ | _record_ | ±20% | < 5000ms absolute |
| Integration pass count | _from day1.md_ | _record_ | 0 | no new failures |
| `body.ok` all-3 | _from day1.md_ | _record_ | true | always true |

If perf drifted > 20%: file P2 issue with both day's `cron_durationMs` arrays inline. (The cron is read-only and shouldn't drift unless CF API itself slowed.)

### AI Gateway log accumulation (read-only via MCP)

```text
mcp__cloudflare-ai-gateway__list_logs gateway_id=platform per_page=50
```

Capture `result_info.total_count`. Yesterday's baseline (2026-05-27) was `total_count=330` (30-day retention). 24h delta should be in single digits to low double digits given `platform-auditor` schedule.

Record:
| Day | total_count | 24h Δ |
|---|---|---|
| 2026-05-27 (baseline) | 330 | n/a |
| Day 1 (record) | _record_ | _record_ |
| Day 2 (record) | _record_ | _record_ |

**Action**: file P2 if 24h Δ > 100 (suggests a new or runaway consumer worker started using AI Gateway unexpectedly).

## Billing observation

Repeat the Day 1 dashboard capture. Record the same table from `day1.md` with today's numbers + 24h delta column.

| Service | Day 1 $/day | Day 2 $/day | 24h Δ | Action if > 2× |
|---|---|---|---|---|
| Workers | (record) | (record) | (record) | P0 |
| D1 | (record) | (record) | (record) | **P0** (Jan 2026 incident category) |
| KV | (record) | (record) | (record) | P1 |
| R2 | (record) | (record) | (record) | P1 |
| AI Gateway | (record) | (record) | (record) | P2 |
| Durable Objects | (record) | (record) | (record) | P1 |
| MTD total | (record) | (record) | (record) | n/a (informational) |

## Issue triage

### Pre-existing (from verification round)

```bash
gh issue view 115 116 117 -R littlebearapps/cf-monitor --json number,state,title,labels,updatedAt
```

| Issue | State | Last update | Notes |
|---|---|---|---|
| [#115](https://github.com/littlebearapps/cf-monitor/issues/115) accountId test | (record) | (record) | Trivial fix; can land today. |
| [#116](https://github.com/littlebearapps/cf-monitor/issues/116) budget-key prefix | (record) | (record) | Needs investigation. Don't auto-fix. |
| [#117](https://github.com/littlebearapps/cf-monitor/issues/117) metrics cron name | (record) | (record) | Trivial fix; can land today. |

### Day-1 issues to verify

If any P0/P1/P2 were filed yesterday — list each here, copy the title, and confirm:
- Issue is still open (closed too quickly is suspicious)
- Has a reasonable label
- Has an assignee or owner in the "Day 2 actuals" section

## Anomaly checklist

In addition to Day 1's list:
- **Slack quiet?** — if you usually see daily-rollup or budget warnings around midnight UTC and you got nothing, run `POST /admin/cron/daily-rollup` manually (with ADMIN_TOKEN) and check it returns ok.
- **GitHub issue creation latency** — pick the newest issue in `/errors` and check the corresponding GitHub URL was actually created (not just KV-fingerprinted).

## Tomorrow setup

- This day's findings → fill in actuals in this file + commit.
- New P0/P1 issues filed today → list explicitly in [`day3.md`](./day3.md) "Issue triage" section.
- If Day 1 baseline rows are still empty in this file, fill them from `day1.md` so trend tables stand on their own.

## Verification (do before closing this day)

- [ ] All "Day 2" cells in delta tables populated.
- [ ] AI Gateway perf within ±20% of Day-1 sample.
- [ ] Cloudflare dashboard deltas captured for all 6 services.
- [ ] GitHub issues #115/116/117 confirmed still open OR a comment added if fix landed.
- [ ] Any new P0/P1/P2 issues filed (and noted for [`day3.md`](./day3.md)).
