# Plan Detection

cf-monitor automatically detects whether your Cloudflare account is on the Workers Free or Workers Paid plan, and uses this to select appropriate budget defaults.

## How it works

On the first budget check (or when the KV cache expires), cf-monitor calls the Cloudflare Subscriptions API:

```
GET /accounts/{account_id}/subscriptions
```

It looks for a subscription with `rate_plan.id === 'workers_paid'` and `scope === 'account'`. If found, the plan is `paid`. Otherwise, `free`.

## Impact on budgets

When cf-monitor auto-seeds budget defaults (no custom budgets configured), it selects limits based on the detected plan:

| Metric | Free plan daily | Paid plan daily |
|--------|----------------|-----------------|
| `d1_writes` | 10,000 | 1,333,333 |
| `d1_reads` | 166,667 | 16,666,667 |
| `kv_writes` | 1,000 | 26,667 |
| `kv_reads` | 33,333 | 333,333 |
| `ai_neurons` | 33,333 | 333,333 |
| `r2_class_a` | 3,333 | 33,333 |
| `r2_class_b` | 33,333 | 333,333 |

Free plan limits are approximately 10x lower than Paid to match the smaller included allowances.

## Billing period

When plan detection succeeds, cf-monitor also caches the billing period — the start and end dates of your current billing cycle. This is used to align monthly budget tracking to your actual invoice period, not calendar months.

For example, if your billing period runs from the 2nd to the 2nd:

- Monthly budget KV keys use `YYYY-MM-DD` format (e.g. `2026-03-02`) instead of `YYYY-MM`
- Budget enforcement checks usage from billing period start, not month start
- Both old (`YYYY-MM`) and new (`YYYY-MM-DD`) key formats are checked during the v0.2.x to v0.3.x transition — no data loss

## Caching

| Data | KV key | TTL |
|------|--------|-----|
| Plan type | `config:plan` | 24 hours |
| Billing period | `config:billing_period` | 32 days |

## Token permissions

Plan detection requires the `Account Settings: Read` permission (`#billing:read`) on your Cloudflare API token.

**If your token lacks this permission**: cf-monitor defaults to `paid` plan budgets. This is the conservative choice — Paid plan limits are higher, so you won't under-protect a Free account. However, Free account users will miss the tighter default limits.

To add the permission:
1. Go to the Cloudflare dashboard, then My Profile, then API Tokens
2. Edit your token
3. Add: Account, Account Settings, Read
4. Save

After updating, delete the cached plan to force re-detection:
```bash
# The cache will refresh on the next hourly cron
# Or trigger manually:
curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/cron/budget-check
```

## API

| Endpoint | What it returns |
|----------|----------------|
| `GET /plan` | Plan type, billing period, days remaining, full plan allowances table |
| `GET /status` | Includes `plan` field and `billingPeriod` |
| `GET /budgets` | Includes `billingPeriod` object |

## CLI

```bash
npx cf-monitor status    # Shows plan type, billing period, days remaining
npx cf-monitor usage     # Shows per-service usage vs plan allowances
```

## Troubleshooting

**Plan shows "paid" on a Free account**: Your API token likely lacks the `Account Settings: Read` permission. See "Token permissions" above.

**Billing period incorrect after plan change**: The billing period is cached for 32 days. Delete the `config:billing_period` KV key to force a refresh.

**Plan detection skipped entirely**: Both `CLOUDFLARE_API_TOKEN` and `CF_ACCOUNT_ID` must be set. Check with `npx cf-monitor status`.
