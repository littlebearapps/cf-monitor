# Setting Up GitHub Webhooks

GitHub webhooks enable bidirectional sync between cf-monitor and your GitHub issues. When you close, reopen, or mute an error issue in GitHub, cf-monitor automatically updates its internal state.

## What it does

| GitHub action | cf-monitor effect |
|---------------|-------------------|
| Issue **closed** | Error fingerprint removed from KV — if the error recurs, a new issue is created |
| Issue **reopened** | Error fingerprint restored — suppresses duplicate issue creation |
| Label `cf:muted` **added** | Fingerprint stored as muted — error won't create new issues even if it recurs |

This means you can manage error tracking through GitHub's normal issue workflow. Close an issue to acknowledge the error. If it comes back, you'll get a fresh issue.

## Setup

### Step 1: Generate a webhook secret

```bash
npx cf-monitor secret set GITHUB_WEBHOOK_SECRET
# Enter a random string (e.g. generate with: openssl rand -hex 32)
```

### Step 2: Configure the webhook in GitHub

1. Go to your repo → **Settings** → **Webhooks** → **Add webhook**
2. **Payload URL**: `https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/webhooks/github`
3. **Content type**: `application/json`
4. **Secret**: the same value you set in Step 1
5. **Events**: select **"Issues"** only (no other events needed)
6. Click **Add webhook**

### Step 3: Verify

GitHub sends a ping event immediately after creation. Check the webhook's **Recent Deliveries** tab — you should see a `200` response.

To test with a real event:
1. Create a test error by hitting a worker that throws an exception
2. Wait for cf-monitor to create a GitHub issue
3. Close the issue in GitHub
4. Check cf-monitor logs (`wrangler tail cf-monitor`) — you should see a webhook processed message

## Security

- Webhook payloads are verified using **HMAC-SHA256** signature comparison (the `X-Hub-Signature-256` header)
- Signature verification uses timing-safe comparison to prevent timing attacks
- Invalid signatures are rejected with `401 Unauthorized`
- Only `issues` events are processed — all other event types are ignored with `200 OK`

## Issue labels

cf-monitor uses these labels on GitHub issues:

| Label | Meaning |
|-------|---------|
| `cf:error:{outcome}` | Error type: `exception`, `exceededCpu`, `exceededMemory`, `canceled`, `responseStreamDisconnected`, `scriptNotFound` |
| `cf:priority:{p0-p4}` | Priority level (P0 = critical, P4 = warning digest) |
| `cf:transient` | Known transient error (rate limit, timeout, etc.) |
| `cf:digest` | Part of the daily P4 warning digest |
| `cf:muted` | Manually muted — cf-monitor won't re-create issues for this fingerprint |

## Muting errors

To permanently silence a recurring error:

1. Open the GitHub issue
2. Add the label `cf:muted`
3. Close the issue

The webhook sync will store the fingerprint as muted. Even if the error recurs, no new issue will be created.

To unmute: remove the `cf:muted` label and reopen the issue.

## Troubleshooting

**Webhook deliveries showing errors**: Check that `GITHUB_WEBHOOK_SECRET` matches exactly between GitHub and cf-monitor. Re-set with `npx cf-monitor secret set GITHUB_WEBHOOK_SECRET`.

**Issues not syncing**: Verify the webhook is configured for "Issues" events (not "Issue comments" or other types).

**Duplicate issues despite webhook**: The webhook handles close/reopen/mute. If you're seeing duplicates, the issue may have been created before the webhook was set up. Close the duplicate — the webhook will clean up the fingerprint.
