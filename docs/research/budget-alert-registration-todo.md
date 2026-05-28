# Budget Alert Registration — IMPLEMENTED (Tier 2 Part F)

**Status**: **IMPLEMENTED 2026-05-28** (Phase 5). Was deferred in Phase 4; resolved here.

## What ships

Opt-in CLI flag on `cf-monitor init`:

```bash
# Email default (auto-discovered from /billing/profile via Billing Read):
npx cf-monitor init --register-budget-alert 100

# Explicit email recipient:
npx cf-monitor init --register-budget-alert 100 --alert-email nathan@example.com

# Existing webhook destination (Slack, your own ingester — reuse-or-create):
npx cf-monitor init --register-budget-alert 100 --alert-webhook https://hooks.example.com/cf-budget
```

Behaviour:
- Mutation **only** when `--register-budget-alert <n>` is present. Default install untouched.
- Recipient resolution: `--alert-webhook` (highest precedence) → `--alert-email` → billing email auto-discovered from `/billing/profile`.
- Idempotent: re-running the flag updates the existing policy in place (deterministic policy name `cf-monitor:budget-alert`).
- On 403: clear `Notifications Write required` error, exit 1. **No partial state** written.
- On success: subscription status persisted to KV (`config:budget_alert`) so the worker can surface it in `GET /usage`.

## CRITICAL caveat — Cloudflare API limitation

The `--register-budget-alert <threshold>` flag's **$threshold value is NOT settable via the Notifications API**. Cloudflare's Budget Alert threshold is configured **in the dashboard** at:

```
Manage Account > Billing > Billable Usage > Add a Budget Alert
```

What this flag actually does:
1. Creates a notification policy with `alert_type: "billing_budget_alert"` (confirmed alert type from the 2026-05-27 probe of `/alerting/v3/available_alerts`).
2. Routes the resulting alert to the supplied email or webhook destination.
3. Records the user-stated `$threshold` in the policy description + KV blob for our own tracking.

The CLI output and the docs both make this explicit. cf-monitor's `/usage` response surfaces the registration with `confidence.budget_alert: 'alert_only'` to keep the "alert-only, not enforcement" semantics visible.

This API limitation is the reason CF docs at `developers.cloudflare.com/api/resources/alerting/...` document `billing_usage_alert` (per-product daily-cap usage) but not yet `billing_budget_alert` (monthly $-budget). The Phase 1 probe is the source of truth on the alert-type vocabulary.

## How it works (implementation map)

- **Core module**: `src/cli/budget-alert.ts` — `buildPolicyBody`, `findExistingCfMonitorPolicy`, `findOrCreateWebhookDestination`, `registerBudgetAlert`. Pure-ish; all CF API access takes an injectable `fetchImpl` for testing.
- **Wired into**: `src/cli/commands/init.ts` → `maybeRegisterBudgetAlert()` runs only when the flag is present.
- **KV blob**: `KV.CONFIG_BUDGET_ALERT` (`config:budget_alert`). The CLI writes it via the existing `writeKVValue()` helper after a successful CF API call.
- **Worker surface**: `src/worker/fetch-handler.ts` → `handleUsage()` reads the KV blob in its `Promise.all` and emits a top-level `budget_alert` block plus `confidence.budget_alert: 'alert_only'`.
- **Auto-discovery**: When no `--alert-email`/`--alert-webhook` is supplied, init.ts hits `/billing/profile` directly (Billing Read required) and reads `result.billing_email`.
- **Tests**: `tests/cli/budget-alert.test.ts` (12 cases — body shape, dedup, list-or-create webhook, register happy / update / 403 / no-recipient / webhook path) + new `fetch-handler.test.ts` cases for the `/usage` surface.

## Token scope

cf-monitor's read-only default tokens are unchanged. The opt-in flag requires the deploy token to include:
- `Billing Read` — to auto-discover the billing email when no `--alert-email` is supplied.
- `Notifications Write` — to create/update the notification policy and (optionally) the webhook destination.

A 403 on either endpoint produces a clear single-line error message and exits 1. Nothing is broadened silently.

## Companion diagnostic — `cf-monitor probe alerting`

New read-only subcommand added 2026-05-28 (mirrors `cf-monitor probe billing`):

```bash
npx cf-monitor probe alerting
```

GETs `/alerting/v3/{available_alerts,policies,destinations/webhooks}` and writes a redacted snapshot to `docs/research/probes/alerting-probe-<date>.redacted.json`. Useful for inspecting existing policies before/after running the registration flag, or for discovering the alert-type vocabulary on accounts you don't own.

## Pre-conditions from the original TODO — resolved

| Original pre-condition | Resolution |
|---|---|
| 1. POST body schema | Verified against CF API docs (`developers.cloudflare.com/api/resources/alerting`) + the alert-type vocabulary from the 2026-05-27 probe. Body shape: `{ name, alert_type, enabled, mechanisms, description, filters }`. |
| 2. Webhook destination reuse | `findOrCreateWebhookDestination()` lists `/destinations/webhooks` first and matches by URL; creates only when no match. |
| 3. Receiver URL | Email default (no receiver needed). Webhook path uses the user-supplied URL. |
| 4. Token scope policy | Required scopes called out above. cf-monitor only requests them when the flag is used. |

## What's still NOT done (deliberately)

- **No live test against the Platform CF account** in this implementation pass. Running the flag would create a real policy on the user's account. The unit tests with mocked fetch cover body shape + dedup + 403; the user can manually verify with `npx cf-monitor init --register-budget-alert 100 --alert-email test@example.com` against a sandbox account.
- **No automation of the dashboard threshold step**. The Notifications API doesn't expose this; CF would need to ship a Billing-side API endpoint first.
- **No multiple-threshold support**. Only one cf-monitor-managed policy at a time, deduped by name.
- **No deletion subcommand**. To remove the subscription, delete the policy directly via the CF dashboard or `DELETE /alerting/v3/policies/{id}`.
