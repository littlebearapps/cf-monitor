# Day 4 — 2026-05-31 (Sun) — Midpoint review + release readiness

## Goals

1. Synthesise Days 1-3 into a midpoint health verdict: green / amber / red.
2. Capture a clean perf re-measurement for AI Gateway cron — Days 1-3 used the same `test-cf-monitor` deploy cycle; today verify the perf measurement is repeatable.
3. **Release readiness assessment**: based on Days 1-3, do we expect Day 7's go/no-go to be a go? If amber/red, surface what would need to change.
4. Issue burn-rate check — are Day 1-3 issues moving toward closure?

## Production cf-monitor health checks (v0.3.11)

Same as Days 1-3. Output → `/tmp/cfmon-day4-prod.json`.

### 72h trend signal

For each tracked field below, look at the 4-point series (D1→D2→D3→D4). Mark:
- 🟢 **stable** — flat or expected growth pattern
- 🟡 **drifting** — slope changed but no policy breach
- 🔴 **alert** — outside OK band (file an issue)

| Field | D1 | D2 | D3 | D4 | Signal |
|---|---|---|---|---|---|
| `/self-health.staleCrons.length` | _record_ | _record_ | _record_ | _record_ | _🟢/🟡/🔴_ |
| `/self-health.todayErrors` | _record_ | _record_ | _record_ | _record_ | _🟢/🟡/🔴_ |
| `/budgets.count` (tripped CBs) | _record_ | _record_ | _record_ | _record_ | _🟢/🟡/🔴_ |
| `/errors.count` growth/day | _record_ | _record_ | _record_ | _record_ | _🟢/🟡/🔴_ |
| `/usage.d1.rowsWritten` daily Δ | _record_ | _record_ | _record_ | _record_ | _🟢/🟡/🔴_ |
| `/usage.kv.writes` daily Δ | _record_ | _record_ | _record_ | _record_ | _🟢/🟡/🔴_ |
| Cloudflare $/day | _record_ | _record_ | _record_ | _record_ | _🟢/🟡/🔴_ |

## AI Gateway feature observation — perf repeatability

Run the integration test **twice** in succession (5min apart) to verify the perf number isn't a fluke:

```bash
cd cf-monitor && git checkout feature/ai-gateway-usage-collection
direnv exec . npm run test:integration 2>&1 | tee /tmp/cfmon-day4a-int.log
# Wait 5 min for CF KV/Workers cooldown
sleep 300
direnv exec . npm run test:integration 2>&1 | tee /tmp/cfmon-day4b-int.log
grep "ai-gateway:perf" /tmp/cfmon-day4*-int.log
```

### Perf trend (now with Day 4a + 4b)

| Metric | Baseline | D1 | D2 | D3 | D4a | D4b | OK band |
|---|---|---|---|---|---|---|---|
| `cron_durationMs` p50 | 615 | _r_ | _r_ | _r_ | _r_ | _r_ | < 1000ms |
| `cron_durationMs` max | 775 | _r_ | _r_ | _r_ | _r_ | _r_ | < 5000ms |
| `cron_durationMs` stdev | n/a | _r_ | _r_ | _r_ | _r_ | _r_ | small |

**If D4a and D4b diverge by > 50%**, file P2 issue — suggests CF API or worker isolate state has variance we should understand before shipping.

## Release readiness assessment

Score each line; ✓ = ready / ✗ = blocks v0.4.0 release.

| Line | Status |
|---|---|
| ✓/✗ — All Days 1-3 production health metrics are 🟢 (no 🔴, ≤1 🟡 with explanation) | _decide_ |
| ✓/✗ — All Days 1-3 AI Gateway perf samples within OK band | _decide_ |
| ✓/✗ — Cloudflare $/day is flat or trending down (not unexpectedly up) | _decide_ |
| ✓/✗ — Tracking issues #115/116/117 progressed (closed, or have agreed plan) | _decide_ |
| ✓/✗ — Any P0/P1 filed Days 1-3 are now closed (or have an explicit "won't fix" justification) | _decide_ |
| ✓/✗ — No new P0/P1 filed in Day 3 that hasn't been triaged | _decide_ |

**Verdict**:
- All ✓ → **green** to ship v0.4.0 on Day 7. Day 5 will be burndown, Day 6 will be pre-release rehearsal, Day 7 ship.
- 1 ✗ in P2 / cosmetic territory → **amber**. Ship v0.4.0 anyway with a known-issue note in the release.
- Any ✗ in P0/P1 / billing territory → **red**. Don't ship v0.4.0 on Day 7. Either extend the window or release a smaller patch.

Record verdict here: _green/amber/red, reason in one sentence_.

## Billing — 4-day cumulative review

| Service | D1 | D2 | D3 | D4 | 4-day total | MTD attribution |
|---|---|---|---|---|---|---|
| Workers | _r_ | _r_ | _r_ | _r_ | _r_ | _r_ |
| D1 | _r_ | _r_ | _r_ | _r_ | _r_ | _r_ |
| KV | _r_ | _r_ | _r_ | _r_ | _r_ | _r_ |
| R2 | _r_ | _r_ | _r_ | _r_ | _r_ | _r_ |
| AI Gateway | _r_ | _r_ | _r_ | _r_ | _r_ | _r_ |
| Durable Objects | _r_ | _r_ | _r_ | _r_ | _r_ | _r_ |
| **MTD total** | _r_ | _r_ | _r_ | _r_ | _r_ | _r_ |

**Action**: if any service is on track to exceed monthly allowance, file P1 issue with the projection.

## Issue triage

Goal: every P0/P1 filed in the first 3 days should be closed by end of Day 4. P2 by Day 5. P3 batched.

```bash
gh issue list -R littlebearapps/cf-monitor --state open --json number,title,labels,createdAt | \
  python3 -c "
import sys, json
issues = json.load(sys.stdin)
for i in issues:
    labels = [l['name'] for l in i.get('labels', [])]
    print(f\"#{i['number']:4d} | {i['createdAt'][:10]} | {','.join(labels):30s} | {i['title']}\")"
```

For each open issue:
- If labelled P0/P1 and filed Day 1: **escalate today** if no progress.
- If labelled P0/P1 and filed Day 2-3: assign + acknowledge timeline.
- If labelled P2: confirm it's in the burndown for Day 5.
- If labelled P3: confirm it's batched (won't fix until next cycle).

## Anomaly checklist

- **Weekend completes**: Friday-Sunday traffic patterns shouldn't have surprised cf-monitor. If `gap-detection` fired anomalies over the weekend, were they real or false-positive?
- **MTD billing**: Did May 2026 close (it's the last day of May!) within budget? If MTD ≥ expected, dig into which service overran.
- **Mid-month vs end-of-month effects**: any cron behaviour that's specifically end-of-month (e.g. monthly budget reset)? Test that `budget-check` correctly transitions to the new period at midnight UTC tonight.

## Tomorrow setup

[`day5.md`](./day5.md) is issue burndown. Carry forward:
- All open P2 issues with planned-fix dates.
- The Day 4 verdict (green/amber/red).
- Any specific "must-fix-before-ship" items.

## Verification

- [ ] 72h trend table complete with signal column.
- [ ] Perf re-measurement done with Day 4a + Day 4b.
- [ ] Release readiness verdict recorded.
- [ ] 4-day cumulative billing reviewed.
- [ ] Issue burndown next-actions assigned.
