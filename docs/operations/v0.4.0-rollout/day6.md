# Day 6 — 2026-06-02 (Tue) — Pre-release rehearsal

## Goals

1. Final integration suite run on `feature/ai-gateway-usage-collection` — must be clean (or only the same pre-existing failures from #115/116/117).
2. **Dry-run the release** — walk through `./scripts/release.sh 0.4.0` without firing it. Confirm version bump targets, CHANGELOG completeness, npm publish flow.
3. Confirm production v0.3.11 is still healthy (5-day soak complete).
4. Final issue triage — anything still open that should block tomorrow's release?

## Production cf-monitor health checks (v0.3.11)

Quick pass — by now this should be muscle memory. Output → `/tmp/cfmon-day6-prod.json`.

| Field | Day 5 | Day 6 | OK? |
|---|---|---|---|
| `/self-health.healthy` | _r_ | _r_ | _Y/N_ |
| `/self-health.staleCrons.length` | _r_ | _r_ | _Y/N_ |
| `/budgets.count` | _r_ | _r_ | _Y/N_ |
| `/errors.count` 24h Δ | _r_ | _r_ | _Y/N_ |

**Action**: any 🔴 cell → escalate before Day 7 release decision.

## Final integration suite run

```bash
cd cf-monitor
git checkout feature/ai-gateway-usage-collection
git pull origin feature/ai-gateway-usage-collection   # ensure remote matches local
direnv exec . npm test                                # unit tests first
direnv exec . npm run typecheck
direnv exec . npm run test:integration 2>&1 | tee /tmp/cfmon-day6-final-int.log
```

### Expected results

| Suite | Expected |
|---|---|
| Unit tests | 380 pass, 0 fail (or higher if PRs landed during the week) |
| Typecheck | clean |
| Integration suite | 56 pass, 4 fail (#115/116/117 + any not closed by Day 5) |

**If integration suite has more failures than yesterday**: investigate before releasing. If less: even better — note in the CHANGELOG which issues were resolved.

## Release dry-run

**Do NOT execute the release script today**. Just verify it will work tomorrow.

```bash
cat scripts/release.sh   # read it
```

Walk through the script's actions mentally:
1. Version-bump targets: `package.json`, `CHANGELOG.md`, `CLAUDE.md`, `bug_report.yml`, `llms.txt`, `docs/README.md` (6 files per CLAUDE.md "Release Process" section). Verify each contains a `0.3.11` reference today that the script will rewrite to `0.4.0`:

   ```bash
   grep -nE '0\.3\.11|version' package.json CHANGELOG.md CLAUDE.md llms.txt docs/README.md .github/ISSUE_TEMPLATE/bug_report.yml 2>/dev/null | head -20
   ```

2. CHANGELOG entry. Open `CHANGELOG.md` and verify the `[Unreleased]` section contains the AI Gateway feature notes added in commit `ad73f66`. If it does NOT yet have a `[0.4.0]` header, the script will rename `[Unreleased]` to `[0.4.0] - 2026-06-03`.

3. **Git state required**: `release.sh` typically requires a clean working tree on `main`. Today, `feature/ai-gateway-usage-collection` is the source branch. **The release flow is**:
   - Merge `feature/ai-gateway-usage-collection` → `main` (via PR — open it today).
   - Wait for CI green on `main`.
   - Then run `./scripts/release.sh 0.4.0` on `main`.

4. Open the PR (Day 6 task):

   ```bash
   gh pr create -R littlebearapps/cf-monitor \
     --base main --head feature/ai-gateway-usage-collection \
     --title "feat: v0.4.0 — AI Gateway usage collection" \
     --body "$(cat docs/operations/v0.4.0-rollout/day6-pr-body.md)"   # write this file as part of Day 6
   ```

   The PR triggers CI but not the integration suite (CI only runs integration on push-to-main per `.github/workflows/ci.yml`). Plan: merge, then CI runs integration on `main`. If integration fails on `main`, **revert the merge** before tagging.

5. Pre-release CHANGELOG additions. Beyond the existing v0.4.0 entry, add today (Day 6):

   ```markdown
   ## [0.4.0] - 2026-06-03

   ### Added
   - AI Gateway usage collection ... (existing notes from ad73f66)

   ### Fixed
   - test(integration): admin/cron tests were silently 401-ing since v0.3.3; ADMIN_TOKEN now injected (commit d94634f).

   ### Notes for operators
   - This release does NOT change the runtime behaviour of existing cf-monitor workers EXCEPT to add a new hourly cron `collect-ai-gateway-usage`. If your CLOUDFLARE_API_TOKEN lacks `AI Gateway: Read` scope, the cron fail-opens (logs once/day, skips). To enable the feature, add the scope and redeploy.
   - The CLI gains `npx cf-monitor usage --detail` for per-gateway/provider/model breakdown.
   ```

## AI Gateway feature — final perf check

```bash
direnv exec . npm run test:integration 2>&1 | tee /tmp/cfmon-day6-int.log
grep "ai-gateway:perf" /tmp/cfmon-day6-int.log
```

| Metric | Baseline | Day 1 | Day 3 | Day 6 | Verdict |
|---|---|---|---|---|---|
| `cron_durationMs` p50 | 615 | _r_ | _r_ | _r_ | _stable/drift_ |
| `cron_durationMs` max | 775 | _r_ | _r_ | _r_ | _stable/drift_ |

If today's max > 2× baseline: investigate before tagging.

## Issue triage — final pre-release filter

```bash
gh issue list -R littlebearapps/cf-monitor --state open --json number,title,labels,createdAt > /tmp/cfmon-day6-open.json
```

Categorise each open issue:

| Category | Action |
|---|---|
| P0/P1 — blocks v0.4.0 | **Postpone release**. Fix today, retest, then decide whether to delay 24h. |
| P2 — known issue, will fix in v0.4.1 | Add to CHANGELOG "Known issues" subsection in release notes. |
| P3 — cosmetic | Ignore for v0.4.0. |
| #115/116/117 — pre-existing test bugs | If closed: ✓. If open: list under "Known issues" in release notes. They don't block v0.4.0 (they're in test infra, not the SDK). |

## Tomorrow setup

[`day7.md`](./day7.md) is the go/no-go decision. Carry into it:
- This day's pre-release verdict.
- The PR URL.
- The "known issues" subsection for release notes.
- Any final blockers.

## Verification

- [ ] Unit + typecheck + integration suites all green (or expected failures only).
- [ ] Release dry-run walked through without surprises.
- [ ] PR opened against `main`.
- [ ] CHANGELOG additions drafted.
- [ ] Open-issue triage final-pass complete.
- [ ] No surprise P0/P1 filed in the past 24h.
