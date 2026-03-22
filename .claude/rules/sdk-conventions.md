# SDK Conventions

## Public API Surface

cf-monitor has exactly ONE public export: `monitor()` from `src/index.ts`. All internals are encapsulated.

If you need to expose a new type, add it to `src/types.ts` and re-export from `src/index.ts`. Never create new sub-path exports — the whole point of cf-monitor is simplicity vs platform-consumer-sdk's 18 exports.

## Fail Open

All SDK code must fail open by default. If KV is unreachable, AE write fails, or any internal error occurs — the consumer worker's response must NOT be affected. Wrap everything in try-catch at the boundary.

## Analytics Engine Schema

AE doubles positions (0-19) are **append-only**. Never reorder. New metrics go at the end. See `src/constants.ts` → `AE_FIELDS`.

This layout is backward-compatible with `@littlebearapps/platform-consumer-sdk` so existing AE data is readable by cf-monitor.

## Self-Telemetry AE Convention (#44)

Self-monitoring data points use `blob2` format `self:{durationMs}:{1|0}` (e.g. `self:250:1`). Only `doubles[0]=1` is set (invocation count). Duration and success are encoded in `blob2` to avoid conflicting with positions 0-19 in AE_FIELDS. Filter with: `WHERE blob2 LIKE 'self:%'`.

## KV Key Versioning

All KV key prefixes include a version segment (e.g. `cb:v1:feature:`). When schema changes are needed, increment the version. Old keys expire naturally via TTL.

## Binding Proxy Pattern

`src/sdk/proxy.ts` uses ES Proxy to intercept binding method calls. Key rules:
- Never proxy cf-monitor's own bindings (`CF_MONITOR_KV`, `CF_MONITOR_AE`)
- Every proxied method must increment the metric BEFORE calling the original
- `RequestLimits` checks happen AFTER incrementing (so the limit is inclusive)
- New binding types: add detection in `detection.ts`, proxy in `proxy.ts`

## Feature ID Resolution

`MonitorConfig` offers three levels of control:

1. **`featureId`** — Single ID for ALL routes. Use for simple workers with one budget bucket.
2. **`featurePrefix`** — Replaces worker name in auto-generated IDs. e.g. `featurePrefix: 'platform'` → `platform:fetch:GET:notifications`.
3. **`features`** — Route-specific overrides. Exact match on `METHOD /path`, cron expression, or queue name.
4. **Auto-generated** — `{workerName}:{handlerType}:{discriminator}` (default).

Precedence: `featureId` → `features` map → auto-generate with `featurePrefix ?? workerName`.

Path normalisation strips numeric IDs, UUIDs, and limits to 2 path segments. See `detection.ts` → `normalisePath()`.

## Worker Name Detection

`MonitorConfig.workerName` has highest priority. Detection chain:
`config.workerName` → `env.WORKER_NAME` → `env.name` → `'worker'`

The `wire --apply` CLI command auto-injects `WORKER_NAME` from wrangler config `name` field.

## Circuit Breaker Reset

`resetFeatureCb()` writes `'GO'` with 60s TTL instead of `kv.delete()`. This forces cache invalidation across KV edge replicas, avoiding the ~10s eventual consistency delay that delete exhibits.

## No Project Concept

Unlike platform-consumer-sdk which required a `project` parameter, cf-monitor operates at account scope. The "project" is the entire CF account. Feature IDs start with the worker name, not a project name.

## Debugging cf-monitor Issues

When cf-monitor itself has problems, use the self-monitoring endpoints:

- `GET /self-health` — Returns 200 (healthy) or 503 (stale crons). Shows per-handler last run times, error counts, and stale cron list.
- `POST /admin/cron/staleness-check` — Manually trigger staleness detection.
- KV inspection: Read `self:v1:cron:last_run` for handler execution history as JSON blob.
- AE query: `SELECT blob3 AS handler, count() FROM "cf-monitor" WHERE blob2 LIKE 'self:%' GROUP BY handler` — handler invocation counts.
