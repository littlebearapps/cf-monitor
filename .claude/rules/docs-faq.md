# `docs/faq/index.md` — Marketing-Site FAQPage Source

`docs/faq/index.md` is **not an ordinary doc**. It is the upstream source for the FAQPage JSON-LD schema rendered at <https://littlebearapps.com/help/cf-monitor/faq/>. The file was added in PR #104 (closes #103) and is consumed by the `littlebearapps/littlebearapps.com` repo's docs-sync pipeline.

## Why it exists

- **AI-citation surface**: ChatGPT, Perplexity, and Google AI Overviews preferentially cite content with `FAQPage` JSON-LD. Without this file, cf-monitor has no dedicated FAQ on the marketing site and relies on incidental section-level detection.
- **Google FAQ-rich SERP snippets**: Google occasionally renders FAQ-rich results from FAQPage schema.
- **Schema is already wired**: the marketing site auto-extracts question-shaped H2s and emits FAQPage. The schema fires automatically as long as this file (a) exists at this path, and (b) has ≥7 question-shaped H2s.

## Do NOT

- **Do not delete or rename** `docs/faq/index.md` or the `docs/faq/` directory. The marketing-site sync (`littlebearapps/littlebearapps.com`, `scripts/docs-sync.config.ts`, `cf-monitor` entry, `source: 'docs/faq'`) **hard-fails the build** if the upstream source is missing. Removing the file breaks the marketing site, not just cf-monitor.
- **Do not move it** to `docs/faq.md` (single-file form) or another path without a coordinated PR in `littlebearapps.com` updating `docs-sync.config.ts`. The site-side PR must land **before** the upstream move, or the sync fails.
- **Do not strip the frontmatter**. The sync pipeline injects `category: faq`, `tool: cf-monitor`, `pubDate`, and other site fields automatically — but it relies on `title` + `description` being present in the upstream file. Keep both.
- **Do not add a `category:` or `tool:` field** to the frontmatter yourself — the sync injects them. A duplicate field will conflict.

## When to update

Update `docs/faq/index.md` whenever cf-monitor changes any of the user-facing surfaces the FAQ describes. Concrete triggers:

| Change | FAQ section to revisit |
|--------|------------------------|
| New CLI command, renamed command, or changed install flow | "How do I install cf-monitor?" |
| Changed required CF API token scopes, GitHub PAT scopes, or added/removed secrets | "What Cloudflare API token permissions does cf-monitor need?" |
| New tracked binding type, new KV prefix, changed AE retention | "What data does cf-monitor collect, and where does it go?" |
| Change to fail-open behaviour or per-invocation limits | "What happens if cf-monitor itself fails?" |
| AE/KV/Worker pricing-model changes that affect cf-monitor's own footprint | "Does cf-monitor cost anything to run?" |
| Plan-detection behaviour change (subscriptions API, fallback semantics, allowance tables) | "How does cf-monitor know whether I'm on Workers Free or Paid?" |
| New CB reset semantics, new admin endpoints for CB control | "Why isn't my circuit breaker resetting?" |
| New alert channel, removed alert type, or change to GitHub/Slack secrets | "Can cf-monitor create GitHub issues and Slack alerts for me?" |
| AI feature graduating from stub to real, or new AI feature added | "Are the AI features ... ready to use?" |
| Changed update procedure (e.g. new migration step), changed uninstall procedure | "How do I update cf-monitor, and how do I uninstall it?" |

If a change doesn't fit any existing question, consider adding a new Q. Don't pad with marginal questions just to add coverage — every Q should answer something a real user has asked or would ask.

## How to update

1. **Edit in place** — the file is canonical. Don't fork it into a separate "draft FAQ" elsewhere.
2. **Keep answers sourced from existing docs** (`README.md`, `docs/getting-started.md`, `docs/troubleshooting.md`, `docs/security.md`, `docs/guides/*`). Cross-link with relative paths (`../guides/plan-detection.md`) rather than restating long sections inline. The FAQ is a fast-look-up; the linked docs are the authoritative source.
3. **Match the existing voice**: informal, developer-first, code examples, opinionated. Use `> **Note:**` blockquotes for caveats. Australian English where natural (*realise, colour, behaviour, defence*) — leave existing US-spelt API/CLI names alone.
4. **Preserve frontmatter shape**:
   ```yaml
   ---
   title: "cf-monitor — Frequently Asked Questions"
   description: "Common questions about cf-monitor: ..."
   ---
   ```
   Only `title` + `description`. Update `description` if the question coverage shifts noticeably.
5. **Maintain ≥7 question-shaped H2s** (end with `?` or start with How / What / Why / When / Where / Can / Do / Does / Is / Are / Should / Will). The FAQPage extractor needs this shape to emit valid JSON-LD. Below 7, the schema fires anyway (≥2 minimum) but the `category: faq` frontmatter alone guarantees emission. Below 2, no schema.
6. **No placeholders** (`TODO`, `[placeholder]`, `XXX`, `FIXME`). The marketing-site reviewer treats the file as production content.
7. **Verify before committing**:
   ```bash
   grep -c '^## ' docs/faq/index.md             # should be ≥7
   grep -nE 'TODO|XXX|FIXME' docs/faq/index.md  # should return nothing
   # Spot-check that every relative link resolves (../getting-started.md, etc.)
   ```

## Where it shows up downstream

- **Source of truth** (this repo): `docs/faq/index.md` on `main`.
- **Sync config** (other repo): `littlebearapps/littlebearapps.com`, `scripts/docs-sync.config.ts`, `cf-monitor` entry includes `{ source: 'docs/faq', category: 'faq' }`. **Do not modify the upstream filename without a coordinated PR there.**
- **Public URL**: `https://littlebearapps.com/help/cf-monitor/faq/` (or whatever slug the sync produces — single-file directories typically map to the parent slug).
- **Schema marker** (post-deploy verification): the rendered page contains `<script type="application/ld+json">` with `"@type":"FAQPage"`.

## Quick reference

- **Read the file**: `docs/faq/index.md` (~170 lines, ~1900 words).
- **In-repo discoverability**: linked from `docs/README.md` under "Reference".
- **Change history**: PR #104 (initial scaffold, closes #103). Future changes should reference the relevant cf-monitor change PR/issue.
