## Summary

<!-- What does this PR do? Why is it needed? -->

## Changes

-

## Test Plan

- [ ] Unit tests added/updated (`npm test`)
- [ ] Integration tests (if applicable — `npm run test:integration`)
- [ ] `npm run typecheck` passes
- [ ] Tested manually against a real Cloudflare account (if applicable)

## Checklist

- [ ] Follows fail-open principle (SDK errors never break consumer workers)
- [ ] AE doubles positions not reordered (append-only — new fields go at the end)
- [ ] KV key prefixes include version segment (e.g. `cb:v1:`)
- [ ] No secrets hardcoded (use env vars or KV secrets)
- [ ] Australian English used (realise, colour, licence)
