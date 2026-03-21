# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | Yes       |
| < 0.2   | No        |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **security@littlebearapps.com** with:

- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Impact assessment (if known)

### Response timeline

- **Acknowledge**: within 48 hours
- **Assessment**: within 7 days
- **Resolution target**: 14 days for critical, 30 days for moderate

We'll coordinate disclosure timing with you. Credit is given to reporters in the release notes (unless you prefer anonymity).

## Scope

**In scope:** SDK code (`src/sdk/`), monitor worker (`src/worker/`), CLI commands (`src/cli/`), configuration schema and validation.

**Out of scope:** Cloudflare platform vulnerabilities (report to [Cloudflare](https://hackerone.com/cloudflare) directly). Third-party dependency vulnerabilities (report upstream, but let us know so we can pin/patch).

## Security Design

cf-monitor is designed with security constraints appropriate for a monitoring tool:

- **Fail-open architecture** — SDK errors never expose consumer data or block responses. All internal operations are wrapped in try-catch at boundaries.
- **No secrets in code** — `GITHUB_TOKEN`, `SLACK_WEBHOOK_URL`, and `GITHUB_WEBHOOK_SECRET` are always passed via environment variables or KV secrets.
- **HMAC-SHA256 webhook verification** — GitHub webhooks are verified with timing-safe comparison before processing.
- **No SQL injection surface** — cf-monitor uses KV and Analytics Engine only. No D1, no SQL queries on user input.
- **Rate limiting** — error issue creation capped at 10 per script per hour with 60-second lock dedup.
- **Minimal data storage** — no request/response bodies, no PII, no credentials. Error fingerprints are one-way FNV hashes.

## Supply Chain

- **lockfile-lint** in CI detects registry manipulation
- **npm audit** runs on every PR
- GitHub Action SHAs are pinned in CI workflows
- Only 2 runtime dependencies: `commander` and `picocolors`
