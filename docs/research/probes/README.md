# API Probe Snapshots

This directory holds **redacted** output from `cf-monitor probe …` diagnostic commands.

- **Read-only**: probe commands issue GET requests only and never mutate anything.
- **Redacted**: sensitive values (emails, addresses, payment/tax details, the account ID, tokens) are replaced with `<REDACTED>` / `<ACCOUNT_ID>` before the file is written. **Keys are preserved** so the payload shape stays inspectable. Files are named `*.redacted.json` and are safe to commit.
- **Still review before committing**: redaction is conservative but pattern-based. Skim a new snapshot for anything sensitive the redactor missed before adding it to git.

## Producing a snapshot

```bash
export CLOUDFLARE_ACCOUNT_ID=<32-char-hex>
export CLOUDFLARE_API_TOKEN=<token>
npx cf-monitor probe billing      # → billing-probe-<date>.redacted.json
```

See [`../billing-endpoints-follow-up.md`](../billing-endpoints-follow-up.md) for the billing probe context and the `Billing Read` token requirement.
