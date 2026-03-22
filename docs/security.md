# Security

This guide covers cf-monitor's security model, how secrets are managed, and what protections are in place.

## Security model

cf-monitor is a **cost protection and observability tool**, not a security product. It protects your Cloudflare bill by tracking binding operations and tripping circuit breakers when budgets are exceeded. It does not provide WAF, DDoS protection, authentication, or access control for your application workers.

**Threat model**: cf-monitor defends against accidental cost overruns (infinite loops, misconfigured crons, deployment bugs). The January 2026 incident that inspired cf-monitor was caused by a worker bug writing 4.8 billion D1 rows — not by a malicious actor.

## Admin endpoint authentication

The cf-monitor worker exposes `/admin/*` POST endpoints for operational tasks: manually triggering crons, tripping/resetting circuit breakers, and running dry-run tests. These endpoints are protected by a shared secret (`ADMIN_TOKEN`).

### What ADMIN_TOKEN protects

| Endpoint | What it does |
|----------|-------------|
| `POST /admin/cron/{name}` | Manually trigger any cron handler |
| `POST /admin/cb/trip` | Trip a circuit breaker on any feature |
| `POST /admin/cb/reset` | Reset a tripped circuit breaker |
| `POST /admin/cb/account` | Pause/unpause the entire account |
| `POST /admin/test/github-dry-run` | Test GitHub issue formatting |
| `POST /admin/test/slack-dry-run` | Test Slack alert formatting |

Without `ADMIN_TOKEN`, these endpoints return `401 Unauthorized`. An attacker who discovers your `cf-monitor.*.workers.dev` URL cannot trip circuit breakers (DoS) or reset them (bypass cost protection).

### Setting up ADMIN_TOKEN

Generate a random token and set it as a Worker secret:

```bash
# Generate a 32-byte random token
openssl rand -hex 32

# Set it on the cf-monitor worker
npx cf-monitor secret set ADMIN_TOKEN
# Paste the token when prompted
```

Then include it in requests to admin endpoints:

```bash
curl -X POST https://cf-monitor.YOUR_SUBDOMAIN.workers.dev/admin/cron/budget-check \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### What ADMIN_TOKEN is NOT

- It is **not** a Cloudflare API token — it's a simple shared secret you generate yourself
- It is **not** required for the SDK wrapper (`monitor()`) or consumer workers — only for admin endpoints on the cf-monitor worker
- It is **not** used for GET endpoints (`/status`, `/errors`, `/budgets`, etc.) — those are read-only and publicly accessible

## Secrets management

cf-monitor uses up to 6 secrets, all set via `npx cf-monitor secret set <NAME>`:

| Secret | Required | Purpose | Minimum scope |
|--------|----------|---------|---------------|
| `CLOUDFLARE_API_TOKEN` | Yes | GraphQL metrics, worker discovery, plan detection | Workers KV Storage: Edit, Account Analytics: Read, Workers Scripts: Edit. Optional: Account Settings: Read (for plan detection) |
| `ADMIN_TOKEN` | Recommended | Admin endpoint authentication | N/A — self-generated random string |
| `GITHUB_TOKEN` | Optional | Create issues for captured errors | Fine-grained PAT with `issues: write` on the target repo. Classic PATs need `public_repo` (public) or `repo` (private). **Do not use full `repo` scope if `issues: write` suffices.** |
| `SLACK_WEBHOOK_URL` | Optional | Budget warnings, error alerts, gap alerts | N/A — Slack incoming webhook URL |
| `GITHUB_WEBHOOK_SECRET` | Optional | Verify GitHub webhook signatures | N/A — self-generated random string, must match the webhook config in GitHub |
| `GATUS_TOKEN` | Optional | Bearer token for Gatus heartbeat pings | N/A — provided by your Gatus instance |

### GitHub PAT minimum scopes

For **fine-grained personal access tokens** (recommended):
- Repository access: select only the repo(s) where you want error issues
- Permissions: `Issues: Read and write` — nothing else needed

For **classic personal access tokens**:
- Public repos: `public_repo` scope
- Private repos: `repo` scope (broader than needed, but the only option with classic PATs)

cf-monitor creates issues, adds labels, and reads issue bodies. It does not need code access, PR permissions, or admin access.

## Webhook security

### HMAC-SHA256 verification

The `POST /webhooks/github` endpoint verifies GitHub webhook signatures using HMAC-SHA256 with timing-safe comparison. Requests without a valid `X-Hub-Signature-256` header are rejected with `401`.

### Replay protection

Each webhook delivery includes a unique `X-GitHub-Delivery` header (a UUID). cf-monitor stores this as a KV nonce with a 24-hour TTL. Replayed webhooks within 24 hours are silently dropped. This prevents an attacker who captures a valid webhook payload from replaying it to manipulate error fingerprint state.

## Data exposure

### Unauthenticated GET endpoints

These endpoints are publicly accessible (no auth required):

| Endpoint | Data exposed | Data NOT exposed |
|----------|-------------|-----------------|
| `GET /_health` | Account name, healthy status | Account ID, worker names |
| `GET /status` | Account name, plan type, healthy status, CB states, worker count | Account ID, worker names, billing period, GitHub repo |
| `GET /errors` | Error fingerprints, GitHub issue URLs | Error messages, stack traces |
| `GET /budgets` | Active circuit breakers by feature ID | Budget limits, usage numbers |
| `GET /workers` | Worker names and count | Worker code, bindings |
| `GET /plan` | Plan type, billing period, allowances | Account ID |
| `GET /usage` | Per-service usage numbers | Account ID |
| `GET /self-health` | Handler status, error counts, stale crons | Internal state |

The `/status` endpoint intentionally omits the Cloudflare account ID, individual worker names, and GitHub repo path to reduce reconnaissance value.

### Consumer worker health endpoint

Each worker wrapped with `monitor()` exposes `/_monitor/health` (configurable). This returns the worker name, binding status, and circuit breaker state. It does not return the account ID or binding details.

## SDK security

### Fail-open design

All SDK code fails open by default. If KV is unreachable, AE writes fail, or any internal error occurs, the consumer worker's response is not affected. Monitoring should never be the thing that breaks production.

### Binding proxy isolation

cf-monitor's own KV and AE bindings (`CF_MONITOR_KV`, `CF_MONITOR_AE`) are excluded from proxy wrapping. The SDK never tracks its own operations, preventing feedback loops.

### Path normalisation

Auto-generated feature IDs strip sensitive content from URL paths:
- Numeric segments (`/users/123` becomes `users`)
- UUIDs
- MongoDB-style hex IDs (24+ characters)
- Query strings (stripped entirely)
- Paths limited to 2 segments

This prevents sensitive data (user IDs, tokens in paths) from appearing in feature IDs, KV keys, or AE data.

### Module-private symbol

The internal tracking metadata (metrics, feature ID, worker name) is stored on the env proxy using a module-private `Symbol()`. This is not discoverable by other code in the isolate, preventing malicious npm dependencies from reading internal metrics or worker names.

## Binding detection

cf-monitor uses duck-typing to identify Cloudflare binding types at runtime (checking for method signatures like `prepare()` + `batch()` for D1, `get()` + `put()` + `delete()` + `list()` for KV, etc.). This is fragile — a custom object on `env` matching these signatures would be incorrectly wrapped as a CF binding and tracked in metrics.

**Mitigation**: Use the `excludeBindings` option to skip specific env keys from proxy wrapping:

```typescript
export default monitor({
  excludeBindings: ['MY_CUSTOM_STORE', 'LEGACY_API_CLIENT'],
  fetch: handler,
});
```

Keys listed in `excludeBindings` are returned unwrapped (no metric tracking). cf-monitor's own bindings (`CF_MONITOR_KV`, `CF_MONITOR_AE`) are always excluded automatically.

In practice, the risk is low — env bindings are set at deploy time by Cloudflare, and custom objects rarely match CF binding method signatures. But if you have a custom env object with `get()`, `put()`, `delete()`, and `list()` methods, `excludeBindings` is the escape hatch.

## Error message handling

### Truncation

Error messages from tail events are truncated to **500 characters** before storage or transmission. This limits the blast radius if error messages contain sensitive data.

### Markdown escaping

Error data interpolated into GitHub issue table cells is escaped to prevent markdown injection. Characters like `|`, backticks, brackets, and exclamation marks are backslash-escaped, preventing an attacker from injecting tracking images, phishing links, or @mentions via crafted `console.error()` messages.

### Fingerprint normalisation

The error fingerprint algorithm normalises messages by replacing:
- UUIDs with `<UUID>`
- Hex IDs (24+ chars) with `<ID>`
- Numbers (4+ digits) with `<N>`
- Timestamps with `<TS>`
- IP addresses with `<IP>`

This ensures the same logical error produces the same fingerprint regardless of variable content, and that fingerprints don't contain PII.

## npm package security

| Check | Status |
|-------|--------|
| **`files` allowlist** | Only `src/`, `dist/cli/`, `worker/`, and `cf-monitor.schema.json` are published |
| **`.npmignore`** | Excludes `tests/`, `.cf-monitor/`, `.wrangler/`, `.dev.vars`, `.github/` |
| **No postinstall scripts** | Only `prepublishOnly: build:cli` (runs before publish, not on install) |
| **Runtime dependencies** | 2: `commander` (CLI framework), `picocolors` (terminal colours). Both well-maintained, no known CVEs |
| **No dynamic code execution** | Zero use of `Function()` constructors or dynamic code generation anywhere in the codebase |
| **No `any` types** | SDK code uses `unknown` with explicit narrowing throughout |

## CLI security

### Input validation

The `secret set` command validates secret names against `/^[A-Z_][A-Z0-9_]*$/` to prevent shell metacharacter injection. All CLI commands that invoke wrangler use `execFileSync` (array arguments, no shell interpolation).

### Token handling

The `--api-token` CLI flag passes the token to wrangler as a command-line argument. On multi-user systems, this may be visible in process listings. Prefer environment variables (`CLOUDFLARE_API_TOKEN`) or `wrangler login` for authentication.

## Known limitations

### KV budget accumulation race condition

Budget counters in KV use a read-modify-write pattern without atomicity (KV does not support atomic increment). Under high concurrency, usage may be slightly under-counted. This is mitigated by the hourly budget enforcement cron, which recalculates from Analytics Engine as the authoritative source.

### 32-bit fingerprint hash

Error fingerprinting uses FNV-1a 32-bit, which has a ~50% collision probability at ~77K unique errors. In practice, most accounts see far fewer unique errors. If collisions become an issue, a future version may upgrade to SHA-256.

## Reporting vulnerabilities

If you discover a security vulnerability in cf-monitor, please report it responsibly:

- **Email**: security@littlebearapps.com
- **GitHub**: [Create a private security advisory](https://github.com/littlebearapps/cf-monitor/security/advisories/new)

Please do not open public issues for security vulnerabilities.
