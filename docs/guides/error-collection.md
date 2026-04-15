# Error Collection

cf-monitor captures errors from all workers on your account via Cloudflare's tail worker mechanism, deduplicates them, and optionally creates GitHub issues with priority labels.

## Prerequisites — minimum viable setup

To get errors flowing into GitHub issues, you need **all four** of the following. If any is missing, errors are still captured (visible via `GET /errors`) but no issues are created.

| # | Requirement | How to satisfy |
|---|-------------|----------------|
| 1 | cf-monitor worker deployed on the same CF account as your workers | `npx cf-monitor init --account-id YOUR_ACCOUNT_ID` + `npx cf-monitor deploy` |
| 2 | Each monitored worker's wrangler config has `"tail_consumers": [{ "service": "cf-monitor" }]` | `npx cf-monitor wire --apply` (this is the subscription that makes the tail stream reach cf-monitor) |
| 3 | `GITHUB_REPO` set (as an `init --github-repo` flag or in `cf-monitor.yaml` under `github.repo`) | `npx cf-monitor init --github-repo owner/repo` or edit `cf-monitor.yaml` and redeploy |
| 4 | `GITHUB_TOKEN` secret on the cf-monitor worker — PAT with `issues: write` (fine-grained) or `repo` (classic) | `npx cf-monitor secret set GITHUB_TOKEN` |

Optional but recommended:

- `GITHUB_WEBHOOK_SECRET` + a webhook on the target repo → enables bidirectional sync (close an issue on GitHub and cf-monitor stops re-creating it). See [GitHub webhooks](../how-to/github-webhooks.md).
- `SLACK_WEBHOOK_URL` → also get Slack alerts for P0/P1 errors.

## How it works

1. Your worker throws an error (or a cron/queue handler fails)
2. Cloudflare delivers a **tail event** to cf-monitor's `tail()` handler
3. cf-monitor extracts the error details, computes a **fingerprint**, and checks for duplicates
4. If it's a new error, cf-monitor creates a **GitHub issue** (if configured) and writes the fingerprint to KV
5. If it's a duplicate, the event is silently dropped

## What gets captured

### Error outcomes (from failed invocations)

| Outcome | Priority | Description |
|---------|----------|-------------|
| `exception` | P1 | Unhandled exception thrown by your code |
| `exceededCpu` | P0 | Worker exceeded CPU time limit |
| `exceededMemory` | P0 | Worker exceeded memory limit |
| `canceled` | P2 | Request was cancelled (client disconnect) |
| `responseStreamDisconnected` | P3 | Response stream terminated unexpectedly |
| `scriptNotFound` | P0 | Worker script not found (deployment issue) |

### Soft errors (from successful invocations)

| Log level | Priority | Description |
|-----------|----------|-------------|
| `console.error()` | P2 | Your code logged an error but returned a response |
| `console.warn()` | P4 | Your code logged a warning — batched into daily digest |

P0-P3 errors create individual GitHub issues immediately. P4 warnings are batched into a single daily digest issue at midnight UTC.

> **Practical consequence:** any `console.error()` call in your worker code — even on an otherwise successful (`outcome: ok`) request — will produce an individual P2 GitHub issue. If you use `console.error()` for non-urgent logging, either downgrade those calls to `console.warn()` (which batches to the P4 daily digest) or route them elsewhere. A chatty `console.error` log can quickly hit the 10 issues/script/hour rate limit.

## Fingerprinting

Every error is assigned a **fingerprint** — a stable 8-character hex hash based on:

```
fingerprint = FNV-hash( scriptName + ":" + outcome + ":" + normalise(message) )
```

### Message normalisation

Before hashing, error messages are normalised to strip variable content:

- **UUIDs** → `<UUID>` (e.g. `abc123de-f456-7890-1234-56780cdef012`)
- **JSON message extraction** — if the message starts with `{`, the `"message"` field is extracted for fingerprinting (strips variable metadata like `correlationId`, `duration_ms`)
- **Hex IDs** (8+ chars) → `<ID>` (catches correlationIds, MongoDB ObjectIds, etc.)
- **Numeric IDs** (4+ digits) → `<N>`
- **Timestamps** → `<TS>` (ISO 8601 format — processed before numeric IDs to prevent year stripping)
- **JSON small numbers** (1-3 digits after `:`) → `<N>` (catches `"attempt": 4`, `"totalAttempts": 2`)
- **IP addresses** → `<IP>`
- Whitespace is collapsed and the message is truncated to 200 characters

This means the same logical error with different IDs, timestamps, or request-specific data produces the **same fingerprint** — so you get one GitHub issue, not thousands.

## Deduplication layers

cf-monitor uses six layers to prevent duplicate issues:

1. **Batch dedup** — in-memory `Set<string>` tracks fingerprints within a single tail invocation. Eliminates same-batch duplicates with zero latency (no KV round-trip).
2. **Fingerprint lookup** — checks KV for `err:fp:{hash}`. If found, the error already has a GitHub issue. (90-day TTL)
3. **Rate limit** — max 10 issues per script per hour via `err:rate:{script}:{hour}`. Prevents issue floods from cascading failures.
4. **Daily cap** — max 50 issues per script per day via `err:rate:{script}:daily:{date}`. Hard ceiling on sustained floods.
5. **Transient dedup** — known transient errors (rate limits, timeouts, billing errors) get max 1 issue per category per day via `err:transient:{script}:{category}:{date}`. Works for both hard errors and soft errors (`console.error()`).
6. **Lock** — 60-second KV lock via `err:lock:{fingerprint}` prevents race conditions across concurrent tail invocations.

## Transient error patterns

cf-monitor recognises 9 built-in transient patterns and limits them to one issue per category per day:

| Pattern | Matches |
|---------|---------|
| `rate-limited` | "rate limit", "429", "too many requests" |
| `timeout` | "timeout", "timed out", "ETIMEDOUT" |
| `quota-exhausted` | "quota", "exceeded limit", "billing" |
| `connection-refused` | "ECONNREFUSED", "connection refused" |
| `dns-failure` | "ENOTFOUND", "DNS failed", "getaddrinfo" |
| `service-unavailable` | "503", "502", canceled outcome, stream disconnected |
| `cf-internal` | "internal error" + "cloudflare" |
| `billing-exhausted` | "insufficient balance", "402", "payment required" |

### Custom transient patterns

`cf-monitor.yaml` accepts a `transient_patterns:` array for your own categories:

```yaml
transient_patterns:
  - name: "custom-gateway-timeout"
    match: "504 gateway timeout"
  - name: "db-pool-exhausted"
    match: "connection pool"
```

Custom patterns are checked after the built-in patterns. Each requires a `name` (used in dedup keys) and `match` (regex, case-insensitive). Matching errors get the same 1-issue-per-day dedup as built-ins.

## GitHub issues

When a new error is captured and GitHub is configured, cf-monitor creates an issue with:

- **Title**: `[P1] worker-name: exception`
- **Body**: markdown table with worker, outcome, priority, account, fingerprint, error message, and timestamp
- **Labels**: `cf:error:exception`, `cf:priority:p1`, optionally `cf:transient`

### Issue labels

| Label | Meaning |
|-------|---------|
| `cf:error:{outcome}` | Error type (exception, exceededCpu, etc.) |
| `cf:priority:{p0-p4}` | Priority level |
| `cf:transient` | Known transient error (rate limit, timeout, etc.) |
| `cf:digest` | Part of daily warning digest |
| `cf:muted` | Manually muted — cf-monitor won't re-create if closed |

## GitHub webhook sync

If you configure a GitHub webhook pointing to cf-monitor's `/webhooks/github` endpoint, issue lifecycle events are synced bidirectionally:

| GitHub action | cf-monitor effect |
|---------------|-------------------|
| Issue **closed** | Fingerprint removed from KV — allows re-creation if the error recurs |
| Issue **reopened** | Fingerprint restored to KV — suppresses duplicate creation |
| Label `cf:muted` **added** | Fingerprint stored as muted — error won't create new issues |

This means you can manage error tracking through GitHub's normal issue workflow.

## Warning digest

P4 warnings (`console.warn()`) are not urgent enough for individual issues. Instead, cf-monitor batches them into KV throughout the day and creates a single **daily digest** GitHub issue at midnight UTC.

The digest groups warnings by worker and includes up to 20 entries per worker. The KV digest key (`warn:digest:{date}`) auto-expires after 48 hours.

## Testing error collection

Use the dry-run endpoint to test GitHub issue formatting without creating real issues:

```bash
curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/test/github-dry-run \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"scriptName":"my-worker","outcome":"exception","errorMessage":"Connection timeout"}'
```

This returns the exact title, body, labels, fingerprint, and priority that would be used for a real issue.
