# SDK Conventions

## Public API Surface

cf-monitor has exactly ONE public export: `monitor()` from `src/index.ts`. All internals are encapsulated.

If you need to expose a new type, add it to `src/types.ts` and re-export from `src/index.ts`. Never create new sub-path exports — the whole point of cf-monitor is simplicity vs platform-consumer-sdk's 18 exports.

## Fail Open

All SDK code must fail open by default. If KV is unreachable, AE write fails, or any internal error occurs — the consumer worker's response must NOT be affected. Wrap everything in try-catch at the boundary.

## Analytics Engine Schema

AE doubles positions (0-19) are **append-only**. Never reorder. New metrics go at the end. See `src/constants.ts` → `AE_FIELDS`.

This layout is backward-compatible with `@littlebearapps/platform-consumer-sdk` so existing AE data is readable by cf-monitor.

## KV Key Versioning

All KV key prefixes include a version segment (e.g. `cb:v1:feature:`). When schema changes are needed, increment the version. Old keys expire naturally via TTL.

## Binding Proxy Pattern

`src/sdk/proxy.ts` uses ES Proxy to intercept binding method calls. Key rules:
- Never proxy cf-monitor's own bindings (`CF_MONITOR_KV`, `CF_MONITOR_AE`)
- Every proxied method must increment the metric BEFORE calling the original
- `RequestLimits` checks happen AFTER incrementing (so the limit is inclusive)
- New binding types: add detection in `detection.ts`, proxy in `proxy.ts`

## Feature ID Format

Auto-generated: `{workerName}:{handlerType}:{discriminator}`

Examples:
- `my-api:fetch:GET:api-users`
- `my-api:cron:0-2-x-x-x`
- `my-api:queue:task-pipeline`

Path normalisation strips numeric IDs, UUIDs, and limits to 2 path segments. See `detection.ts` → `normalisePath()`.

## No Project Concept

Unlike platform-consumer-sdk which required a `project` parameter, cf-monitor operates at account scope. The "project" is the entire CF account. Feature IDs start with the worker name, not a project name.
