# Cloudflare GraphQL Data Sources

**Last verified**: 2026-05-25 via GraphQL `__schema` introspection
**Target audience**: developers implementing v0.4.0 expansion of `src/worker/crons/collect-account-usage.ts`
**Authority**: this file is the authoritative source for CF GraphQL field names cf-monitor consumes. When `encapsulated-parasol.md` Track 1 matrix and this file disagree, **this file wins**.

## TL;DR

- 28 of 31 target dataset root fields on the `account` type exist exactly as listed in the v0.4.0 plan.
- 3 dataset root-field names must be corrected (table below).
- ~70% of "claimed inner metric field names" in the plan are wrong. Real field names recorded below per dataset.
- Endpoint: `https://api.cloudflare.com/client/v4/graphql`. Standard CF API token (`#analytics:read` scope) is sufficient for both introspection and dataset queries.

## Plan Corrections (encapsulated-parasol.md Track 1)

| # | Plan name | Actual name on `account` type | Action |
|---|-----------|-------------------------------|--------|
| 1 | `workersInvocationsAdaptiveGroups` (baseline mention) | Does NOT exist | Use existing `workersInvocationsAdaptive`. |
| 2 | `imagesUniqueTransformationsAccumulated` (row #7) | `imagesUniqueTransformationsAccumulatedSinceStartOfMonth` | Rename in Track 1 row #7. |
| 3 | `storageTracesAdaptiveGroups` (row #11) | Does NOT exist — only `storageTraces` (raw event). | Drop Groups variant from the plan; aggregate client-side via `count` over `storageTraces`. |

## Introspection Method

1. `__type(name: "Query")` → root field is `viewer`.
2. `__type(name: "viewer")` → `accounts` returns type `account` (lowercase).
3. `__type(name: "account")` → 201 fields on the account type. Cross-match against target dataset names.
4. For each present dataset, introspect its type (e.g. `AccountAiInferenceAdaptiveGroups`) and drill into its `sum`/`avg`/`max`/`quantiles` sub-types to recover the actual numeric metric field names.

Reusable introspection script lives in `/tmp/` during dev — recreate by following the structure documented here.

## Existing baseline (cf-monitor already queries)

| Dataset | Type | Notes |
|---------|------|-------|
| `workersInvocationsAdaptive` | `AccountWorkersInvocationsAdaptive` | Raw event table. |
| `d1AnalyticsAdaptiveGroups` | `AccountD1AnalyticsAdaptiveGroups` | |
| `kvOperationsAdaptiveGroups` | `AccountKvOperationsAdaptiveGroups` | |
| `r2OperationsAdaptiveGroups` | `AccountR2OperationsAdaptiveGroups` | |
| `durableObjectsInvocationsAdaptiveGroups` | `AccountDurableObjectsInvocationsAdaptiveGroups` | |
| `durableObjectsPeriodicGroups` | (account-type field) | Available for future use. |
| `durableObjectsStorageGroups` | (account-type field) | Available for future use. |

## Track 1 — New v0.4.0 datasets (all 11 services, verified)

### #1 Workers AI — `aiInferenceAdaptiveGroups`

- **Aggregations available**: `count` (uint64), `sum`, `dimensions`, `confidence`
- **`sum` fields**: `totalNeurons`, `totalInferenceSteps`, `totalInferenceTimeMs`, `totalInputTokens`, `totalOutputTokens`, `totalRequestBytesIn`, `totalRequestBytesOut`, `totalProcessedPixels`, `totalProcessedTiles`, `totalTiles`, `totalAudioSeconds`, `totalCostMetricValue1`, `totalCostMetricValue2`, `totalInputLength`
- **Plan correction**: plan claims `requests` and `neurons`; actual = parent `count` for requests, `totalNeurons` for neurons.

### #2 AI Gateway — 4 datasets

- **`aiGatewayRequestsAdaptiveGroups`** — `sum`: `cachedRequests`, `erroredRequests`, `cachedTokensIn`, `cachedTokensOut`, `uncachedTokensIn`, `uncachedTokensOut`, `cost`. Total requests = parent `count`.
- **`aiGatewayErrorsAdaptiveGroups`** — no sum subtype; use parent `count`.
- **`aiGatewayCacheAdaptiveGroups`** — no sum subtype; use parent `count` + `dimensions.cacheStatus`.
- **`aiGatewaySizeAdaptiveGroups`** — `max`: `rows` (uint64). **Plan claim `storedBytes` is WRONG** — this is row count, not bytes.

### #3 Vectorize (V2) — 4 datasets

- **`vectorizeV2QueriesAdaptiveGroups`** — `sum`: `queriedVectorDimensions`, `requestDurationMs`, `servedVectorCount`. Queries count = parent `count`.
- **`vectorizeV2OperationsAdaptiveGroups`** — no sum; parent `count` + `dimensions`.
- **`vectorizeV2StorageAdaptiveGroups`** — `max`: `vectorCount`, `storedVectorDimensions`.
- **`vectorizeV2WritesAdaptiveGroups`** — `sum`: `addedVectorCount`, `deletedVectorCount`, `requestDurationMs`. Plan claim `inserts` → use `addedVectorCount`.

### #4 Queues — 4 datasets

- **`queueMessageOperationsAdaptiveGroups`** — `sum`: `billableOperations`, `bytes`. `avg`: `lagTime`, `retryCount`. `max`: `messageSize`. **Plan claims `messagesPublished/Consumed/Retried/DLQd` as separate sum fields — these are dimensions, not sum fields.** Use `dimensions.actionType` and aggregate `billableOperations` per action.
- **`queueBacklogAdaptiveGroups`** — `avg`: `bytes`, `messages`.
- **`queueConsumerMetricsAdaptiveGroups`** — `avg`: `concurrency`. Plan claim `consumerLag` is NOT here — `lagTime` is in MessageOps avg subtype.
- **`queueDelayedBacklogAdaptiveGroups`** — `avg`: `messages`.

### #5 Workflows — 2 datasets

- **`workflowsAdaptive`** (raw events): `allStepCount`, `cpuTime`, `executionDuration`, `eventType`, `instanceId`, `retryCount`, `wallTime`, `datetime`, `endTimestamp`.
- **`workflowsAdaptiveGroups`** — `sum`: `allStepCount`, `cpuTime`, `executionDuration`, `retryCount`, `stepCount`, `storageRate`, `wallTime`. `avg`: `cpuTime`, `wallTime`. Plan claims `invocations, stepExecutions, stepFailures` → use parent `count` for invocations, `stepCount` for executions, dimension filter for failures.

### #6 Hyperdrive — 2 datasets

- **`hyperdriveQueriesAdaptiveGroups`** — `sum`: `clientWriteLatency`, `connectionLatency`, `originReadLatency`, `originWriteLatency`, `queryBytes`, `queryLatency`, `resultBytes`. `avg`: `connectionLatency`, `queryBytes`, `queryLatency`, `resultBytes`, `sampleInterval`. **p50/p95 are in `quantiles` (separate sub-type, NOT in sum/avg).**
- **`hyperdrivePoolSizesAdaptiveGroups`** — `avg`: `availablePoolSlots`, `currentPoolSize`, `waitingClients`. `max`: `currentPoolSize`, `maxPoolSize`, `waitingClients`.

### #7 Images — 3 datasets

- **`imagesRequestsAdaptiveGroups`** — `sum`: `requests`. ✅ Matches plan exactly.
- **`imagesUniqueTransformations`** — direct fields: `date` (Date), `transformations` (uint64). Daily snapshot, not a Groups type.
- **`imagesUniqueTransformationsAccumulatedSinceStartOfMonth`** — correction #2 above.

### #8 Browser Rendering — 6 datasets

- **`browserRenderingApiAdaptive`** (raw events): `endpoint`, `requestId`, `crawlJobId`, session-level timestamps.
- **`browserRenderingApiAdaptiveGroups`** — no sum; use parent `count` + `dimensions.endpoint`.
- **`browserRenderingEventsAdaptive`** (raw events): `browserCloseReason`, `clientLibrary`, `concurrentSessions`, session/connection timestamps.
- **`browserRenderingEventsAdaptiveGroups`** — `avg`: `avgConcurrentSessions`. `max`: `finalBrowserCloseReason`, `latestBrowserEndTime`.
- **`browserRenderingBindingSessionsAdaptiveGroups`** — `avg`: `avgConcurrentSessions`. `max`: `maxConcurrentSessions`.
- **`browserRenderingBrowserTimeUsageAdaptiveGroups`** — `sum`: `totalSessionDurationMs`. `avg`: `avgSessionDurationMs`. `max`: `maxSessionDurationMs`. **Plan claims `browserTimeSeconds` → actual is `totalSessionDurationMs` (milliseconds — divide by 1000).**

### #9 Calls — 3 datasets

- **`callsStatusAdaptive`** (raw events): `appId`, `event`, `sessionId`, `trackId`, `datetime`. Derive connections by counting events with `event='connect'` (or similar).
- **`callsTurnUsageAdaptiveGroups`** — `sum`: `egressBytes`, `ingressBytes`. `avg`: 4 concurrency window fields (1min/5min/15min/1hr).
- **`callsUsageAdaptiveGroups`** — `sum`: `egressBytes`, `ingressBytes`. SFU vs TURN split via `dimensions`.

### #10 Stream — 2 datasets

- **`streamMinutesViewedAdaptiveGroups`** — `sum`: `minutesViewed`. ✅ Matches plan exactly.
- **`streamCMCDAdaptiveGroups`** — `sum`: `millisecondsViewed`. `avg`: `bufferLength`, `bufferStarvationDuration`, `encodedBitrate`, `initialBufferStarvationDuration`, `measuredThroughput`. Opt-in only — debug-level CMCD client metrics.

### #11 Storage Traces

- **`storageTraces`** (raw event table): `containerId`, `datetime`, `resourceId`, `serviceId`, `traceId`, `userAccountId`.
- **`storageTracesAdaptiveGroups`** — correction #3 above (does not exist).

## Implementation Notes for Track 1

1. **Field-name authority**: this file overrides speculative field names in `encapsulated-parasol.md` Track 1 matrix. All Track 1 GraphQL helpers must be written against names recorded here.
2. **`requests` vs `count`**: Many "request count" metrics are not sum-fields; they're the parent `count` aggregate (uint64). The plan's claim that Workers AI / AI Gateway / Vectorize / Workflows expose a `requests` sum field is wrong — use `count`.
3. **Dimensions are mandatory for split metrics**: Queue actions (publish/consume/retry/DLQ), AI Gateway cache status, Calls SFU vs TURN — all split via `dimensions`, not separate sum fields.
4. **Bytes vs row counts**: AI Gateway Size returns `rows` (response row count), NOT byte counts. Re-evaluate Track 1 row #2 cost model.
5. **Quantiles**: Hyperdrive p50/p95 latencies live in `quantiles` sub-type. Queries that need percentiles must include a `quantiles { ... }` block.
6. **No service downgrades to default-off based on schema absence** — all 11 services have viable query paths.

## Pre-Implementation Action Items (do before writing Track 1 helpers)

1. Apply 3 root-field-name corrections (see top table).
2. Rewrite the Track 1 matrix's "fields cf-monitor needs" column per the spec above (mostly `count` instead of `requests`, plus rename `inserts`→`addedVectorCount`, `browserTimeSeconds`→`totalSessionDurationMs/1000`, drop bogus `storedBytes` claim on AI Gateway Size).
3. Plan a follow-up mini-spike to verify `quantiles` field names for Hyperdrive (~5 min).
4. Confirm `cost` field on `aiGatewayRequestsAdaptiveGroupsSum` is what CF actually meters (could replace the entire pricing table for AI Gateway).

## Provenance

| | |
|---|---|
| Spike date | 2026-05-25 |
| Spike branch | `feature/enriched-error-issues` (v0.3.9 prep), graduated to `feature/v0.4.0-cf-api-expansion` |
| Source plan | `~/.claude/plans/untether-you-are-running-encapsulated-parasol.md` Track 1 matrix (v0.4.0 collapsed plan) |
| Action plan | `~/.claude/plans/untether-you-are-running-rustling-umbrella.md` Fork 1 continuation |
| CF docs root | https://developers.cloudflare.com/analytics/graphql-api/ |
| Endpoint | https://api.cloudflare.com/client/v4/graphql |
| Auth | `Authorization: Bearer $CLOUDFLARE_API_TOKEN` (standard `#analytics:read`) |
