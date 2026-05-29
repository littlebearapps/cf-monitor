# cf-monitor v0.4.0 — 7-day observation window

**Window**: 2026-05-28 → 2026-06-03 (7 days).
**Production version under observation**: v0.3.11 (untouched; v0.4.0 is on `feature/ai-gateway-usage-collection` only).
**Feature under verification**: AI Gateway hourly log aggregation (`collect-ai-gateway-usage` cron + `/usage/ai-gateway` endpoint + `/usage` merge + CLI render).
**Production deploy gate**: held until Day 7 go/no-go (this doc set).

## Why 7 days

1. **Production cf-monitor stability** — v0.3.11 must not regress while we observe. Catch any latent bug before adding the v0.4.0 surface.
2. **AI Gateway feature soak** — the new code is gated by an hourly cron in production but lives only on `test-cf-monitor` during this window. Daily re-deploys + perf samples produce a real-world distribution rather than a single point.
3. **Billing surface validation** — Cloudflare's $ figures lag by ~24-48h. Multi-day observation catches anything spikey or anomalous.
4. **Issue burndown discipline** — anything filed in Days 1-4 should be fixed by Day 5-6, with the fix verified before the release gate.

## Daily docs

| Day | Date | Theme | Doc |
|---|---|---|---|
| 1 | 2026-05-28 (Thu) | Baseline | [`day1.md`](./day1.md) |
| 2 | 2026-05-29 (Fri) | Verify Day-1 issues + 24h delta | [`day2.md`](./day2.md) |
| 3 | 2026-05-30 (Sat) | First-quartile + cron staleness deep dive | [`day3.md`](./day3.md) |
| 4 | 2026-05-31 (Sun) | Midpoint review + release readiness | [`day4.md`](./day4.md) |
| 5 | 2026-06-01 (Mon) | Issue burndown | [`day5.md`](./day5.md) |
| 6 | 2026-06-02 (Tue) | Pre-release rehearsal | [`day6.md`](./day6.md) |
| 7 | 2026-06-03 (Wed) | Go/no-go for v0.4.0 release | [`day7.md`](./day7.md) |

## Standard daily checks (shared across all docs — review here once, the daily docs cite them)

### Health endpoints (run from any shell with `direnv exec .`)

Set this in your shell once per session:

```bash
# Use BWS to load creds; do NOT echo $ADMIN_TOKEN
export PROD_CFMON_URL='https://cf-monitor.<your-workers-subdomain>.workers.dev'
# Find your subdomain via:
#   direnv exec . bash -c 'curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" | jq -r .result.subdomain'
```

| Endpoint | Why we check | Expected |
|---|---|---|
| `GET /_health` | Worker reachable | `{"healthy":true,"account":"...","timestamp":...}` |
| `GET /self-health` | Cron staleness, internal errors | `status:200`, `staleCrons:[]`, `todayErrors < 50` |
| `GET /status` | Plan + CB state + worker count | `healthy:true`, `circuitBreaker.global:'inactive'`, `circuitBreaker.account:'active'` |
| `GET /budgets` | Active circuit breakers | `count == 0` ideally; tripped CBs need triage |
| `GET /workers` | Discovered worker registry | `count >= 20` (Platform has 23 currently) |
| `GET /errors` | Recent error fingerprints | New entries = new GitHub issues (cross-check) |
| `GET /usage` | Hourly account usage | `usage.services.{workers,d1,kv,r2,durableObjects}` populated; `disclaimer` text present |
| `GET /usage/ai-gateway` (v0.4.0) | **Test-cf-monitor only** in this window | `status:no_data` likely (production untouched); use the `test-cf-monitor` deploy from Day N's daily check |

### AI Gateway feature observation (`test-cf-monitor`)

Don't deploy production. Instead re-deploy `test-cf-monitor` via the integration suite globalSetup and measure:

```bash
cd cf-monitor
direnv exec . npm run test:integration 2>&1 | tee /tmp/cfmon-day-N-$(date +%s).log
grep "ai-gateway:perf" /tmp/cfmon-day-N-*.log
```

Compare `cron_durationMs` samples to baseline:

| Metric | v0.4.0 baseline (2026-05-27) | Daily target |
|---|---|---|
| p50 | 615 ms | < 1000 ms |
| max | 775 ms | < 5000 ms |
| AE rows after run | 0 (empty traffic) | bounded by gateway traffic |
| KV writes | 0 (empty traffic) | ≤ 1 per run |
| HTTP status | 200 | 200 |

If any daily sample exceeds the targets, file a GitHub issue using the rubric below.

### Billing observation (MCP — read only)

```text
mcp__cloudflare-bindings__d1_databases_list             # confirm 3 databases
mcp__cloudflare-bindings__kv_namespaces_list            # confirm 11 namespaces
mcp__cloudflare-bindings__r2_buckets_list               # confirm 3 buckets
mcp__cloudflare-ai-gateway__list_gateways               # confirm 1 gateway
mcp__cloudflare-ai-gateway__list_logs gateway_id=platform per_page=5  # spot-check today
mcp__cloudflare-bindings__workers_list                  # confirm 23 workers (NSD pair present)
```

Capture daily delta to last-week numbers in `cloudflare-infrastructure.md` source-of-truth.

### Issue filing rubric

| Severity | Trigger | Action |
|---|---|---|
| **P0** — bill risk | CB trip with no apparent cause, billing anomaly > 2× baseline, sustained > 1h | File issue immediately + Slack notify if integration enabled |
| **P1** — function broken | Cron stale > 2× threshold, endpoint returning 5xx, AI Gateway cron returning ok=false | File issue same day, label `priority: high` |
| **P2** — observability gap | New unmapped script in `/errors`, missing AE write category, slow but not stalled cron | File issue same day, label `priority: medium` |
| **P3** — cosmetic | Log spelling, dashboard rendering, docs typos | Batch into a weekly "polish" issue |

Template:
```markdown
**Title**: <area>: <one-line>
**Found**: Day N (YYYY-MM-DD) of v0.4.0 rollout observation window
**Affected**: production cf-monitor (v0.3.11) OR test-cf-monitor (v0.4.0)
**Severity**: P0/P1/P2/P3
**Evidence**: <curl output / AE query / wrangler tail snippet>
**Hypothesis**: <if any>
**Reproduction**: <commands>
**Tracking via**: docs/operations/v0.4.0-rollout/dayN.md
```

## Where to file issues

`gh issue create -R littlebearapps/cf-monitor` or via `mcp__github__issue_write`.

Existing tracking issues from the verification round:
- [#115](https://github.com/littlebearapps/cf-monitor/issues/115) — 01-status accountId
- [#116](https://github.com/littlebearapps/cf-monitor/issues/116) — 04-budget-key prefix
- [#117](https://github.com/littlebearapps/cf-monitor/issues/117) — 07-cron name `metrics` vs `collect-metrics`

## Cross-references

- Verification + perf report (the basis for these checks): see `.untether-outbox/cf-monitor-v0.4.0-perf-report.md` (delivered via Telegram in the run that produced this folder) or re-request via `/file get`.
- Feature commit: `ad73f66` on `feature/ai-gateway-usage-collection`.
- Test infra fix: `d94634f` (ADMIN_TOKEN injection).
- AI Gateway integration test: `134ab6c`.
- CLI render: `bbc741d`.
