# Day 5 — 2026-06-01 (Mon) — Issue burndown

## Goals

1. Every P0/P1 from Days 1-4 should be **closed** today. P2 should be closed or have an explicit plan + owner.
2. Production cf-monitor v0.3.11 health pass — quick check, no new issues expected.
3. AI Gateway feature — perf sample to confirm we're still in band.
4. Catch any month-rollover surprises (May → June 2026 boundary fell at midnight UTC).

## Production cf-monitor health checks (v0.3.11)

Same as Days 1-4. Output → `/tmp/cfmon-day5-prod.json`.

### Quick-look table (record actuals)

| Field | Day 4 | Day 5 | Signal | Notes |
|---|---|---|---|---|
| `/self-health.healthy` | _r_ | _r_ | _🟢/🟡/🔴_ | Must be `true` |
| `/self-health.staleCrons.length` | _r_ | _r_ | _🟢/🟡/🔴_ | Must be 0 |
| `/budgets.count` | _r_ | _r_ | _🟢/🟡/🔴_ | Should be 0 |
| `/errors.count` daily Δ | _r_ | _r_ | _🟢/🟡/🔴_ | Small + uneventful |
| `/usage` collected_at recency | _r_ | _r_ | _🟢/🟡/🔴_ | < 2h old |

## Month-rollover checks (specific to today)

The June 2026 billing period started at midnight UTC. Verify:

1. **`/plan` endpoint** — `billingPeriod` field should now reflect 2026-06-01 → 2026-07-01 (or your actual CF billing cycle):

   ```bash
   curl -s "$PROD_URL/plan" | python3 -m json.tool | grep -A2 billingPeriod
   ```

2. **Monthly KV keys** — `budget:usage:monthly:*` keys for the new period start today. Old keys (`budget:usage:monthly:*:2026-05*`) should still exist (32-day TTL) but no new writes.

   ```bash
   # Spot-check via test-cf-monitor (don't read production KV directly)
   ```

3. **`budget-check` cron** — should have transitioned at midnight UTC. Verify it didn't trip any CB during the transition. If a CB was tripped overnight that wasn't there yesterday: **P0**, likely a budget-config edge case at period boundary.

## AI Gateway feature observation

```bash
cd cf-monitor && git checkout feature/ai-gateway-usage-collection
direnv exec . npm run test:integration 2>&1 | tee /tmp/cfmon-day5-int.log
grep "ai-gateway:perf" /tmp/cfmon-day5-int.log
```

### Perf single-shot vs baseline

| Metric | Baseline | Day 5 actual | Trend |
|---|---|---|---|
| `cron_durationMs` p50 | 615 ms | _r_ | _flat/drift_ |
| `cron_durationMs` max | 775 ms | _r_ | _flat/drift_ |
| Integration pass | 56/4 | _r_ | _stable_ |

## Issue burndown

This is the focus of the day.

```bash
gh issue list -R littlebearapps/cf-monitor --state open --json number,title,labels,createdAt,assignees > /tmp/cfmon-day5-open.json
```

### Closure target

For every issue in `/tmp/cfmon-day5-open.json`:

| Issue | Severity | Days open | Action today |
|---|---|---|---|
| _#nnn_ | P0 | _n_ | **Close today** — apply fix, re-test, verify, close. |
| _#nnn_ | P1 | _n_ | **Close today** — same as above. |
| _#nnn_ | P2 | _n_ | Close if trivial; else explicit "fix on Day 6 or roll to next sprint" comment. |
| _#nnn_ | P3 | _n_ | Bulk-batch into a "polish backlog" issue if not already. |

Track three numbers explicitly:

| Bucket | Day 4 count (record) | Day 5 count (record) | Δ |
|---|---|---|---|
| Open P0 | _r_ | _r_ | _Δ_ |
| Open P1 | _r_ | _r_ | _Δ_ |
| Open P2 | _r_ | _r_ | _Δ_ |

### Pre-existing #115/116/117

These should ideally be closed by today:
- [#115](https://github.com/littlebearapps/cf-monitor/issues/115) — trivial test edit.
- [#116](https://github.com/littlebearapps/cf-monitor/issues/116) — investigation. If still open, **add a "blocker for v0.4.0?" comment** asking whether SDK behaviour matches docs.
- [#117](https://github.com/littlebearapps/cf-monitor/issues/117) — trivial test edit.

If #116 turns into a real SDK bug that the v0.4.0 path depends on, **escalate to P0** and reassess the release.

## Anomaly checklist

- **Month-rollover Slack alerts** — was a budget warning fired in the transition that shouldn't have been (e.g. monthly counter hitting 100% of last month's limit before resetting)?
- **`daily-rollup` cron on the boundary** — did it succeed last night?
- **GitHub Actions billing** — separate from CF, but cf-monitor's CI ran on push to feature branch; check no test flakes.

## Tomorrow setup

[`day6.md`](./day6.md) is pre-release rehearsal:
- Bring forward the final Day 5 verdict (proceeding to release Day 7? amber? red?).
- Note any non-blocking issues that should be called out in the v0.4.0 CHANGELOG/release notes.
- List the open issues that will still be open at release time (with rationale).

## Verification

- [ ] Health check tables filled.
- [ ] Month-rollover transitions verified.
- [ ] Issue burndown numbers recorded.
- [ ] Any escalations from #115/116/117 documented.
- [ ] Open-issue count by severity has trended down from Day 4.
