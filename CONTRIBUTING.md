# Contributing to cf-monitor

Thanks for your interest in contributing! cf-monitor is open source and we welcome bug reports, feature requests, and pull requests.

## Development Setup

### Prerequisites

- Node.js 22+ (also tested on Node 20)
- npm 10+
- A Cloudflare account (free or paid) for integration tests

### Getting started

```bash
git clone https://github.com/littlebearapps/cf-monitor.git
cd cf-monitor
npm install
npm test              # 222 unit tests (vitest)
npm run typecheck     # TypeScript strict mode
```

### Running integration tests

Integration tests deploy real workers to Cloudflare with a `test-` prefix. They require credentials:

```bash
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export CLOUDFLARE_API_TOKEN="your-api-token"
npm run test:integration    # 53 tests across 10 files
```

Integration tests create and tear down all resources automatically.

## Code Standards

### TypeScript

- **Strict mode** — no `any` (use `unknown`), explicit return types on public functions
- **ESM only** — `"type": "module"` in package.json
- **Fail-open** — SDK code must never break the consumer worker. Wrap all internal operations in try-catch at boundaries.

### Language

- **Australian English** — realise (not realize), colour (not color), licence (noun), organise (not organize)

### Imports

Order: external packages, then types, then internal (`../`), then relative (`./`)

### Naming

- `camelCase` for variables and functions
- `PascalCase` for types and interfaces
- `SCREAMING_SNAKE` for constants

## Architecture

```
src/
  sdk/           # Runtime SDK — installed in consumer workers
    monitor.ts   # monitor() wrapper (main entry point)
    proxy.ts     # Binding proxies (D1, KV, R2, AI, etc.)
    detection.ts # Auto-detect worker name, bindings, feature IDs
    metrics.ts   # MetricsAccumulator + AE data point conversion
    ...

  worker/        # The single cf-monitor worker
    index.ts     # Export: { fetch, scheduled, tail }
    tail-handler.ts    # Error capture from tailed workers
    fetch-handler.ts   # API endpoints + admin routes
    scheduled-handler.ts # Cron multiplexer
    crons/       # Individual cron handlers
    errors/      # Fingerprinting, patterns, GitHub issues
    alerts/      # Slack alerting

  cli/           # CLI: npx cf-monitor <command>
    index.ts     # Commander setup
    commands/    # Individual command handlers
```

### Key design rules

1. **Single export** — `monitor()` from `src/index.ts`. Don't add sub-path exports.
2. **AE doubles are append-only** — never reorder positions in `AE_FIELDS` (src/constants.ts). New metrics go at the end.
3. **KV keys include version** — prefixes like `cb:v1:feature:` enable safe schema changes. Increment the version for breaking changes.
4. **No D1** — cf-monitor uses Analytics Engine + KV only. This is a core design decision, not a limitation.
5. **Fail-open everywhere** — if KV is unreachable, AE write fails, or any internal error occurs, the consumer worker's response must not be affected.

## Adding a New Binding Type

1. Add duck-typing detection in `src/sdk/detection.ts`
2. Add metric proxy in `src/sdk/proxy.ts`
3. Add metric fields to `MetricsAccumulator` in `src/types.ts`
4. Add AE field position at the END of `AE_FIELDS` in `src/constants.ts`
5. Add unit tests in `tests/sdk/proxy.test.ts`

## Adding a New Cron Handler

1. Create handler in `src/worker/crons/`
2. Import and add to the cron multiplexer in `src/worker/scheduled-handler.ts`
3. Add to `CRON_HANDLERS` in `src/worker/fetch-handler.ts` (enables manual trigger via `/admin/cron/{name}`)
4. Add unit tests in `tests/worker/crons/`

## Commit Conventions

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation only
- `test:` — adding or updating tests
- `refactor:` — code changes that neither fix bugs nor add features
- `chore:` — build process, CI, dependencies

## Pull Request Process

1. Fork the repo and create a branch (`feature/my-feature` or `fix/my-fix`)
2. Make your changes with tests
3. Ensure `npm test` and `npm run typecheck` pass
4. Open a PR against `main` with a clear description
5. Fill in the PR template

## Reporting Issues

- Use the [bug report template](https://github.com/littlebearapps/cf-monitor/issues/new?template=bug_report.md) for bugs
- Use the [feature request template](https://github.com/littlebearapps/cf-monitor/issues/new?template=feature_request.md) for ideas
- Include your cf-monitor version, Node version, and relevant config

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By participating, you agree to uphold a welcoming, inclusive environment.
