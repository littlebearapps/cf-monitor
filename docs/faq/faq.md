---
title: "cf-monitor — Frequently Asked Questions"
description: "Common questions about cf-monitor: installation, permissions, costs, fail-open behaviour, circuit breakers, GitHub and Slack alerts, AI features, and updates."
---

# Frequently Asked Questions

> Quick answers to the questions developers ask most often about cf-monitor. Also surfaced at <https://littlebearapps.com/help/cf-monitor/faq/>.

cf-monitor is a self-contained Cloudflare account monitor: one npm package, one Worker per CF account, three CLI commands to production. It exists because in January 2026 a buggy Worker wrote 4.8 billion D1 rows overnight and produced a $4,868 bill. The questions below cover the things people actually ask while installing, operating, and (occasionally) uninstalling it.

## How do I install cf-monitor?

Three commands deploy the monitor Worker, then a one-line wrapper protects each of your existing Workers.

```bash
# 1. Add the package to your project
npm install @littlebearapps/cf-monitor

# 2. Provision KV + Analytics Engine, generate config files
npx cf-monitor init --account-id YOUR_ACCOUNT_ID

# 3. Deploy the cf-monitor Worker on your CF account
npx cf-monitor deploy

# 4. Auto-wire tail_consumers + bindings on every wrangler config in the repo
npx cf-monitor wire --apply
```

Then wrap each Worker's default export:

```typescript
import { monitor } from '@littlebearapps/cf-monitor';

export default monitor({
  fetch: async (request, env, ctx) => {
    // your existing handler
  },
});
```

That's it — worker name, feature IDs, bindings, and budgets are auto-detected. The monitor Worker handles tail events, hourly metrics, daily rollups, gap detection, and exposes a small read-only API at `https://cf-monitor.<your-subdomain>.workers.dev/`.

> **Next step for alerts:** the steps above enable error *capture* (visible via `GET /errors`), but GitHub issues and Slack alerts need optional secrets — see the [getting-started guide](../getting-started.md) for `GITHUB_TOKEN`, `SLACK_WEBHOOK_URL`, and `ADMIN_TOKEN` setup.

## What Cloudflare API token permissions does cf-monitor need?

The minimum scopes for a Cloudflare API token are:

- **Workers KV Storage: Edit** — read/write the cf-monitor KV namespace
- **Account Analytics: Read** — query GraphQL for hourly metrics and account-wide usage
- **Workers Scripts: Edit** — auto-discover Workers and read their configs

Strongly recommended (especially on Workers Free):

- **Account Settings: Read** — auto-detect Free vs Paid plan and align monthly budgets to your billing cycle

If your token lacks `Account Settings: Read`, cf-monitor silently assumes you're on **Workers Paid** and applies Paid-plan budget defaults — which are roughly 10× higher than Free-plan limits. On a Free account that effectively disables most budget protection. See [Plan detection](../guides/plan-detection.md) for the full impact and how to add the permission.

For optional integrations:

- **GitHub PAT** — fine-grained token with `Issues: Read and write` on the target repo (or `public_repo` / `repo` for classic PATs). Don't use the broader `repo` scope if `issues: write` covers it.
- **Slack incoming webhook URL** — no scopes; just the URL.

The full secrets matrix lives in [Security — Secrets management](../security.md#secrets-management).

## What data does cf-monitor collect, and where does it go?

cf-monitor is observability for *your own infrastructure*, not user analytics. It collects:

- **Per-binding operation counts** — D1 reads/writes, KV reads/writes, R2 ops, AI neurons, Queue messages, DO operations. Written to **Analytics Engine** (90-day retention, 100M writes/month free).
- **Error fingerprints** — captured from Worker tail events. Messages are normalised (UUIDs, timestamps, hex IDs, IPs, large numbers replaced with placeholders) before fingerprinting, and truncated to 500 characters. Stored in **KV** as `err:fp:<fingerprint>` mapping to a GitHub issue URL when one exists.
- **Circuit breaker state, budget counters, plan/billing cache, worker registry** — all in **KV**, all under versioned key prefixes (`cb:v1:`, `budget:`, `config:`, `workers:`).
- **Account-wide usage** — hourly GraphQL pull for Workers, D1, KV, R2, and Durable Objects. Daily snapshots stored in KV (`usage:account:<date>`, 32-day TTL).

Everything stays inside your Cloudflare account. There is no central LBA service receiving telemetry, no third-party tracker, no outbound traffic except the optional integrations *you* configure (GitHub issues, Slack webhooks, Gatus heartbeats). Read-only `GET` endpoints (`/status`, `/errors`, `/budgets`, `/workers`) deliberately omit the account ID, billing period, and full worker names to reduce reconnaissance value.

## What happens if cf-monitor itself fails?

It fails open. Every part of the SDK that touches KV, Analytics Engine, or external APIs is wrapped in defensive try/catch at the boundary, and a swallowed error returns control to your handler unchanged. If KV is unreachable, an AE write throws, or the cf-monitor Worker is offline entirely, your Worker keeps serving requests as if cf-monitor weren't there.

The two exceptions are deliberate:

1. **Per-invocation request limits** (`d1Writes: 1000`, `kvWrites: 200`, etc.) throw `RequestBudgetExceededError` *inside* your handler. That's the kill switch for runaway loops — the whole point of cf-monitor — so it must stop the request, not silently swallow it.
2. **Tripped circuit breakers** return a 503 from the wrapped feature. Once the daily/monthly budget resets (or you call `POST /admin/cb/reset`), traffic resumes.

Monitoring should never be the thing that breaks production. If you see cf-monitor errors in your tail logs that aren't budget trips, please [open an issue](https://github.com/littlebearapps/cf-monitor/issues).

## Does cf-monitor cost anything to run?

For most accounts, no — cf-monitor's own consumption sits comfortably inside Cloudflare's free tier:

- **Analytics Engine**: 100 million writes/month free. cf-monitor writes one AE row per Worker invocation that touches a tracked binding, plus a handful per cron run. Even a busy account stays well under the cap.
- **KV**: writes cost ~10× reads, so cf-monitor writes sparingly — circuit breaker state, budget counters (one increment per request), error dedup, worker registry. Reads dominate. Typical cost: cents per month.
- **Worker invocations**: the cf-monitor Worker itself runs on tail events (real-time, very lightweight), four crons per hour, and on-demand API hits. Free plan: 100K invocations/day is plenty. Paid plan: rounding error.
- **No D1, no Queues** — by design. cf-monitor was built explicitly to *not* require migrations or queue infrastructure.

The thing that costs money is what cf-monitor is *protecting you from*: the runaway D1 write loop, the 4 AM AI-generation cron that didn't realise a feature was deprecated, the misconfigured retry loop hammering R2. Those bills can be five figures. cf-monitor's overhead is rounding error compared to a single bad night.

## How does cf-monitor know whether I'm on Workers Free or Paid?

It calls the Cloudflare Subscriptions API (`GET /accounts/{account_id}/subscriptions`) and looks for a subscription with `rate_plan.id === 'workers_paid'`. The result is cached in KV (`config:plan`, 24-hour TTL) so the API is hit at most once per day per isolate.

The detected plan drives **budget auto-seeding**. When you haven't configured custom budgets, cf-monitor seeds defaults that are roughly 10× lower on Free than on Paid (e.g. `d1_writes` daily 10,000 vs 1,333,333). Plan detection also captures your **billing period** and aligns monthly budget keys to your invoice cycle rather than the calendar month.

If your token lacks `Account Settings: Read` (the `#billing:read` scope), cf-monitor silently falls back to assuming **Paid**. That's the conservative default *for Paid users* — they don't get under-protected. For Free users it's a footgun: a runaway loop can write 1.3M D1 rows before the daily CB trips, and Cloudflare will have rate-limited you long before cf-monitor reacts. Always add `Account Settings: Read` if you're on Free. Full table of allowances in [Plan detection](../guides/plan-detection.md).

## Why isn't my circuit breaker resetting?

The most common causes, in order of likelihood:

1. **KV edge propagation** — Cloudflare KV TTL expirations can take up to ~60 seconds to fan out across all edge locations. Wait a full minute past the expected reset time before declaring it stuck.
2. **You called `wrangler kv key delete`** — don't. cf-monitor resets a CB by writing `'GO'` with a 60-second TTL, *not* by deleting the key. Deleting bypasses the fast-propagation pattern, and edges that have cached `'STOP'` keep returning 503s until their cache lease expires. Always use `POST /admin/cb/reset`:

   ```bash
   curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/cb/reset \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"featureId": "your-feature-id"}'
   ```

3. **Monthly budget is also tripped** — daily budgets reset on TTL, but if the *monthly* budget for the same feature is over its limit, the next hourly enforcement run will re-trip the daily CB immediately. Check `GET /budgets`. Either raise the monthly limit or wait for the billing period to roll over.
4. **Account-level CB is active** — feature CBs can't pass traffic if the whole account is paused. Check `GET /status`, then clear via `POST /admin/cb/account` with `{"action": "unpause"}`.

More scenarios — including missing `tail_consumers`, AE write delays, and worker-name mismatches — are in [Troubleshooting](../troubleshooting.md).

## Can cf-monitor create GitHub issues and Slack alerts for me?

Yes — both are optional, both are wired with one secret each.

**GitHub issues for captured errors.** Set a `GITHUB_TOKEN` (fine-grained PAT with `Issues: Read and write` on the target repo) and a `GITHUB_REPO` config value, then captured errors are deduplicated by fingerprint and turned into rich GitHub issues with stack traces, CPU/wall time, recent log history, request context, priority labels (P0–P4), and deep links to the Cloudflare dashboard. Without a token, errors are still captured — you can see them via `GET /errors` — they just don't reach your issue tracker.

**Slack alerts.** Set a `SLACK_WEBHOOK_URL` and cf-monitor will post to that channel for budget warnings (70% / 90%), tripped circuit breakers, error spikes, gap-detection findings, and cost-spike alerts. Every alert type has KV-based dedup so you don't get spammed at 3 AM about the same incident twice.

**Bidirectional GitHub sync** is also available — set `GITHUB_WEBHOOK_SECRET` and configure a webhook on your repo, and closing/reopening/labelling an issue updates the matching error state in cf-monitor. Setup steps live in [Getting started — Step 7](../getting-started.md#step-7-configure-alerts-optional) and [How-to: GitHub webhooks](../how-to/github-webhooks.md).

## Are the AI features (pattern discovery, health reports, coverage auditor) ready to use?

Not yet. As of v0.3.9, the YAML keys (`ai.pattern_discovery`, `ai.health_reports`, `ai.coverage_auditor`) parse and validate, but the cron handlers in `src/worker/optional/*.ts` are stubs that emit a `console.log()` and exit. Enabling them in `cf-monitor.yaml` is currently a no-op.

The same applies to `monitoring.spike_threshold`: the schema accepts values ≥ 1.5, but the actual spike detection logic hardcodes a 2.0× threshold (the schema is wired ahead of the implementation).

Tracking issues:

- AI pattern discovery — [#8](https://github.com/littlebearapps/cf-monitor/issues/8)
- AI health reports — [#9](https://github.com/littlebearapps/cf-monitor/issues/9)
- AI coverage auditor — [#10](https://github.com/littlebearapps/cf-monitor/issues/10)

Treat these features as a roadmap, not a current capability. Everything else listed in the README's feature list is fully implemented and tested in production.

## How do I update cf-monitor, and how do I uninstall it?

**Updating** is two commands:

```bash
npm install @littlebearapps/cf-monitor@latest
npx cf-monitor deploy
```

The deploy step re-reads `cf-monitor.yaml`, re-embeds the runtime config into `wrangler.cf-monitor.jsonc`, and redeploys the Worker. KV schema changes are handled via versioned key prefixes (e.g. `cb:v1:`) — old keys expire naturally on TTL, new keys take over without a migration. Check the [CHANGELOG](../../CHANGELOG.md) before each upgrade for breaking changes; the project follows semver and flags breaking changes prominently.

**Uninstalling** is intentionally manual to avoid accidental loss of state:

1. Remove the `monitor()` wrapper from each Worker's default export.
2. Edit each `wrangler.*.jsonc` to remove the `tail_consumers` entry pointing at `cf-monitor` and the `CF_MONITOR_KV` / `CF_MONITOR_AE` bindings. The `wire` CLI has no automated unwire today — strip these by hand or with a quick search-and-replace, then redeploy each Worker.
3. Delete the cf-monitor Worker: `wrangler delete cf-monitor`.
4. Delete the KV namespace and Analytics Engine dataset (they don't auto-delete with the Worker).
5. Remove the package: `npm uninstall @littlebearapps/cf-monitor`.

Your tracked Workers continue running normally without monitoring — fail-open means the absence of cf-monitor is just absence, not an error. If you change your mind a week later, the install steps from the first question pick up cleanly on the same account.
