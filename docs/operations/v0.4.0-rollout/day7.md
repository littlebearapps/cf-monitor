# Day 7 — 2026-06-03 (Wed) — Go/no-go for v0.4.0 release

## Goals

1. Make the final go/no-go call.
2. If **go**: execute the release, then deploy production cf-monitor.
3. If **no-go**: document why, file the blockers as P0, and schedule a re-decision date.

## Pre-decision checklist

Tick every box. **Any single ✗ means no-go for today** unless you write a one-line override-justification.

### Code & test state

- [ ] PR opened Day 6 is **merged to `main`**.
- [ ] `main` CI is green (unit + typecheck + integration tests). Integration suite has 56 pass + 4 expected pre-existing failures, no new ones.
- [ ] `git tag --list` does NOT already include `v0.4.0`.
- [ ] Local working tree on `main` is clean.

### Production v0.3.11 state

- [ ] `/self-health.healthy` = `true`.
- [ ] `/self-health.staleCrons.length` = 0.
- [ ] `/budgets.count` = 0 (no tripped CBs).
- [ ] `/errors.count` 24h Δ is small + unsurprising.
- [ ] Cloudflare billing dashboard has no anomalies in the 7-day window.

### Issue state

- [ ] All P0 issues filed Days 1-6 are **closed**.
- [ ] All P1 issues filed Days 1-6 are **closed** OR have an explicit "won't fix for v0.4.0" justification in the CHANGELOG known-issues block.
- [ ] #115, #116, #117 status known + documented in release notes.

### Release artefacts

- [ ] `CHANGELOG.md` `[0.4.0]` entry is complete + dated 2026-06-03.
- [ ] CLAUDE.md, llms.txt, docs/README.md, bug_report.yml, package.json — all reference 0.3.11 today; the script will rewrite to 0.4.0.

## Decision

**Verdict**: _GO / NO-GO_, recorded by: _Nathan_, at: _UTC timestamp_.

**Reason** (one paragraph): _record_

---

## If GO — execute release

```bash
cd cf-monitor
git checkout main
git pull
./scripts/release.sh 0.4.0
```

This will:
1. Bump version across the 6 files.
2. Commit + tag `v0.4.0`.
3. Push tag.
4. GitHub Actions: runs CI, publishes to npm, creates GitHub Release with CHANGELOG notes.

### After tag push — verify

```bash
# Watch the release action
gh run watch -R littlebearapps/cf-monitor

# Verify npm publish
npm view @littlebearapps/cf-monitor version
# Expect: 0.4.0
```

### Then production deploy of cf-monitor on Platform account

This is the step the 7-day window was leading up to. **Only do this after npm publish succeeded.**

```bash
cd cf-monitor
git checkout v0.4.0
npm install
direnv exec . npx cf-monitor deploy
# Confirms hourly cron change takes effect
```

### Post-deploy verification (within 90 min)

```bash
# Get production worker URL
direnv exec . bash -c '
  SUB=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)[\"result\"][\"subdomain\"])")
  curl -s "https://cf-monitor.${SUB}.workers.dev/self-health" | python3 -m json.tool
'
```

Expected: `crons` object now lists `collect-ai-gateway-usage` with `lastRun` populated (or null if the next top-of-hour hasn't passed).

```bash
# Manually trigger to seed first-hour data
direnv exec . bash -c '
  curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
    "https://cf-monitor.${SUB}.workers.dev/admin/cron/collect-ai-gateway-usage"
  sleep 10
  curl -s "https://cf-monitor.${SUB}.workers.dev/usage/ai-gateway" | python3 -m json.tool
'
```

Expected: HTTP 200, `body.ok=true`, `durationMs < 5000`. Then `GET /usage/ai-gateway` either returns `ok` with a snapshot, or `no_data` if the past hour had zero traffic on the `platform` gateway.

### Post-deploy: 24h soak window

For the **next 24h after production deploy**, watch:

- `wrangler tail cf-monitor` for any new errors specifically tagged `[cf-monitor:ai-gateway]`.
- `/self-health` daily for `collect-ai-gateway-usage` cron not going stale (maxStaleMinutes=150).
- `/usage/ai-gateway` shows accumulating data day-over-day.
- Cloudflare billing dashboard for any unexpected $/day delta vs the pre-release week.

If any of the above red-flags within 24h: roll back via `git checkout v0.3.11 && direnv exec . npx cf-monitor deploy`. The new cron is auto-skipped on rollback (it just doesn't exist in v0.3.11).

---

## If NO-GO — document + reschedule

```markdown
## v0.4.0 release deferred

**Date deferred**: 2026-06-03
**Reason**: <one paragraph>
**Blocking issues**: #X, #Y
**Next decision date**: <date>
**Owner**: Nathan
```

Add this block to a new `docs/operations/v0.4.0-deferral.md`. Schedule the next decision-date in your calendar.

Continue daily check pattern until blockers cleared:
- Reuse [`day1.md`](./day1.md) format for "continue baseline".
- Reuse [`day5.md`](./day5.md) format for "issue burndown".
- When ready: run a fresh 1-day version of [`day6.md`](./day6.md) (pre-release rehearsal) + this doc (go/no-go).

---

## Final cross-references

- All 7 daily docs: `docs/operations/v0.4.0-rollout/day{1..7}.md`.
- README + standard checks: [`README.md`](./README.md).
- Feature commits on this branch: `ad73f66, d94634f, 134ab6c, bbc741d` (HEAD before release).
- Perf report: `.untether-outbox/cf-monitor-v0.4.0-perf-report.md` (delivered via Telegram).
- Pre-existing test issues: #115, #116, #117.
