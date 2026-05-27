# Day 1 — 2026-05-28 (Thu) — Baseline

## Goals

1. Capture production cf-monitor v0.3.11 baseline numbers across every health endpoint.
2. Re-run the integration suite once to confirm v0.4.0 perf hasn't drifted from yesterday's verification baseline (p50 615ms / max 775ms).
3. Establish the inventory of "currently-tripped CBs", "active GitHub issues", and "current $/day" so Days 2-7 can compare.
4. **No prior-day issues to verify** — this is Day 1.

## Production cf-monitor health checks (v0.3.11)

```bash
cd ~/claude-code-tools/lba/infrastructure/platform/main/cf-monitor
direnv exec . bash -c '
  SUB=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)[\"result\"][\"subdomain\"])")
  echo "Subdomain: $SUB"
  export PROD_URL="https://cf-monitor.${SUB}.workers.dev"
  echo "--- /_health ---"     ; curl -s "$PROD_URL/_health"     | python3 -m json.tool
  echo "--- /self-health ---" ; curl -s "$PROD_URL/self-health" | python3 -m json.tool
  echo "--- /status ---"      ; curl -s "$PROD_URL/status"      | python3 -m json.tool
  echo "--- /budgets ---"     ; curl -s "$PROD_URL/budgets"     | python3 -m json.tool
  echo "--- /workers ---"     ; curl -s "$PROD_URL/workers"     | python3 -m json.tool
  echo "--- /errors ---"      ; curl -s "$PROD_URL/errors"      | python3 -m json.tool
  echo "--- /usage ---"       ; curl -s "$PROD_URL/usage"       | python3 -m json.tool
'
```

Capture the JSON for each endpoint to `/tmp/cfmon-day1-prod-baseline.json` (cat each into a single file with section headers).

### Baseline targets (record actuals)

| Endpoint | Field | Expected | Day 1 actual |
|---|---|---|---|
| `/_health` | `healthy` | `true` | _record_ |
| `/self-health` | `staleCrons.length` | `0` | _record_ |
| `/self-health` | `todayErrors` | `< 50` | _record_ |
| `/status` | `circuitBreaker.global` | `"inactive"` | _record_ |
| `/status` | `circuitBreaker.account` | `"active"` | _record_ |
| `/status` | `workers.count` | `>= 20` | _record_ |
| `/budgets` | `count` | `0` (ideally) | _record_ |
| `/errors` | `count` | `>= 0` (will have history) | _record_ |
| `/usage` | `usage.services.workers.requests` | non-zero | _record_ |
| `/usage` | `usage.services.aiGateway` | likely undefined (v0.3.11 doesn't collect AI Gateway) | _record_ |

**Action**: file P0/P1 issue if `staleCrons.length > 0` after >2× the staleness threshold (per `CRON_HANDLER_REGISTRY` in `src/constants.ts`).

## AI Gateway feature observation (test-cf-monitor v0.4.0)

```bash
cd ~/claude-code-tools/lba/infrastructure/platform/main/cf-monitor
git checkout feature/ai-gateway-usage-collection
direnv exec . npm run test:integration 2>&1 | tee /tmp/cfmon-day1-int.log
grep -E "ai-gateway:perf|Test Files|Tests " /tmp/cfmon-day1-int.log | tail -10
```

### Capture (record actuals)

| Metric | Baseline (2026-05-27) | Day 1 actual |
|---|---|---|
| `cron_durationMs` p50 | 615 ms | _record_ |
| `cron_durationMs` max | 775 ms | _record_ |
| `cron_durationMs` samples | `[596, 615, 775]` | _record_ |
| Integration suite pass/fail | 56/4 (4 pre-existing) | _record_ |
| AI Gateway `body.ok` (all 3 runs) | `true` | _record_ |

**Action**: file P1 issue if `cron_durationMs.max > 5000ms` or any of the 3 runs returns `body.ok = false`.

## Billing observation

```text
mcp__cloudflare-bindings__d1_databases_list
mcp__cloudflare-bindings__kv_namespaces_list
mcp__cloudflare-bindings__r2_buckets_list
mcp__cloudflare-ai-gateway__list_gateways
mcp__cloudflare-ai-gateway__list_logs gateway_id=platform per_page=5
mcp__cloudflare-bindings__workers_list
```

Cloudflare dashboard (Billing → Usage):
- Note today's $/day for: Workers, D1, KV, R2, AI (Workers AI + AI Gateway storage), Durable Objects.
- Note total $ MTD.

### Day 1 baseline numbers (record)

| Service | $/day | Notes |
|---|---|---|
| Workers | _record_ | requests, CPU ms |
| D1 | _record_ | rows read/written, storage |
| KV | _record_ | ops, storage |
| R2 | _record_ | ops, storage |
| AI Gateway | _record_ | log retention |
| Durable Objects | _record_ | requests, GB-seconds |
| **MTD total** | _record_ | for May 2026 |

## Issue triage

**No prior-day issues** — this is Day 1.

Verify existing tracking issues are open:
- [#115](https://github.com/littlebearapps/cf-monitor/issues/115)
- [#116](https://github.com/littlebearapps/cf-monitor/issues/116)
- [#117](https://github.com/littlebearapps/cf-monitor/issues/117)

```bash
gh issue view 115 117 116 -R littlebearapps/cf-monitor --json number,state,title
```

## Anomaly checklist

Walk through `wrangler tail` for 60s to spot real-time issues:

```bash
direnv exec . npx wrangler tail cf-monitor --format pretty
```

Look for:
- Repeated `[cf-monitor:budget]` warnings → budget close to limit
- Repeated `[cf-monitor:gaps]` → gap detection finding missing-tail workers
- Any `[cf-monitor:error-collector]` GitHub-creation failures → permission / repo config drift
- Slack alerts you receive while running this check (compare against `/budgets` + `/self-health`)

## Tomorrow setup

- Yesterday's daily doc (none — Day 1) → no carryover.
- Today's findings → record in this file under the "Day 1 actuals" columns + commit.
- Any P0/P1 issues filed today → list explicitly in tomorrow's [`day2.md`](./day2.md) under "Issue triage".

## Verification (do before closing this day)

- [ ] All 7 production endpoint responses captured to file.
- [ ] AI Gateway integration test produced perf numbers within budget.
- [ ] CF dashboard $ figures recorded.
- [ ] GitHub issues #115/116/117 confirmed open (or marked otherwise).
- [ ] Any new P0/P1/P2 issues filed.
- [ ] This file's "_record_" placeholders filled in (paste-and-commit a "day1.actuals.md" alongside, or commit edits in place).
