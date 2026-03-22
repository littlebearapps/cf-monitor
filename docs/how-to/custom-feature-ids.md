# Custom Feature IDs

Feature IDs are the keys cf-monitor uses to track per-feature budgets and circuit breakers. By default, they're auto-generated — but you can customise them when the defaults don't fit.

## When you need custom IDs

Auto-generated feature IDs work for most workers. Consider custom IDs when:

- You want a **single budget bucket** for the entire worker (not per-route)
- You have **path parameters** that cause ID explosion (e.g. `/users/:id/posts/:postId`)
- You need **stable IDs** across URL refactors
- You want a **different namespace** than the worker name

## Auto-generated format

cf-monitor generates feature IDs automatically:

| Handler | Format | Example |
|---------|--------|---------|
| Fetch | `{worker}:fetch:{METHOD}:{path-slug}` | `my-api:fetch:GET:api-users` |
| Cron | `{worker}:cron:{slugified-expression}` | `my-api:cron:0-x-x-x-x` |
| Queue | `{worker}:queue:{queue-name}` | `my-api:queue:task-queue` |

### Path normalisation

Before generating IDs, paths are normalised:

- **Numeric segments** stripped: `/users/123/posts` → `users-posts`
- **UUIDs** stripped: `/items/abc123de-f456-...` → `items`
- **MongoDB-style IDs** (24+ hex chars) stripped
- **Limited to 2 segments**: `/api/v2/users/list` → `api-v2`
- **Root path** → `root`

This prevents feature ID explosion from dynamic paths. `/users/1`, `/users/2`, `/users/999` all map to the same feature ID.

## Option 1: `featureId` — single bucket

Use when you want one budget for the entire worker, regardless of route.

```typescript
export default monitor({
  featureId: 'my-worker:all',
  fetch: handler,
  scheduled: cronHandler,
});
```

All routes, crons, and queue handlers share the same budget counter. Simple and predictable.

## Option 2: `featurePrefix` — custom namespace

Use when you want auto-generated IDs but with a different prefix than the worker name.

```typescript
export default monitor({
  featurePrefix: 'platform',
  fetch: handler,
});
// Generates: platform:fetch:GET:api-notifications (instead of my-worker-name:fetch:...)
```

Useful when your wrangler `name` field is verbose (e.g. `lba-scout-harvester-v2`) but you want cleaner feature IDs.

## Option 3: `features` map — per-route control

Use when different routes need different budget buckets, or when you want to exclude specific routes from tracking.

```typescript
export default monitor({
  features: {
    'POST /api/scan': 'scanner:social',        // Custom ID for this route
    'GET /api/users/:id': 'api:users',         // Custom ID for parameterised route
    'GET /health': false,                       // Exclude from tracking entirely
    '0 2 * * *': 'cron:arxiv-harvest',         // Custom cron ID
    'task-queue': 'queue:tasks',               // Custom queue ID
  },
  fetch: handler,
  scheduled: cronHandler,
  queue: queueHandler,
});
```

**Keys** are matched against:
- Fetch routes: `{METHOD} {path}` (e.g. `POST /api/scan`)
- Cron expressions: the exact cron string (e.g. `0 2 * * *`)
- Queue names: the queue binding name

**Values** can be:
- A string feature ID
- `false` to exclude from tracking (no metrics, no budget, no CB check)

Routes without a match in the map fall back to auto-generation.

## Precedence

When multiple options are set, the precedence is:

1. **`featureId`** — overrides everything, single bucket for all handlers
2. **`features` map** — checked for exact match on route/cron/queue
3. **Auto-generated** — uses `featurePrefix` (if set) or `workerName`

## Impact on budgets

Feature IDs are the KV keys for budget tracking:

```
budget:usage:daily:{featureId}:{date}
budget:usage:monthly:{featureId}:{key}
budget:config:{featureId}
```

**Changing feature IDs resets budget counters.** The old KV keys expire via TTL, and new keys start from zero. If you're mid-month, the monthly budget counter effectively resets.

## Examples

### API with mixed routes

```typescript
export default monitor({
  featurePrefix: 'api',
  features: {
    'POST /api/ai/generate': 'api:ai',         // Separate budget for AI calls
    'GET /health': false,                       // Don't track health checks
  },
  limits: {
    aiRequests: 10,                             // Tight per-invocation limit on AI route
  },
  fetch: handler,
});
```

- `POST /api/ai/generate` → `api:ai` (from features map)
- `GET /api/users` → `api:fetch:GET:api-users` (auto-generated with prefix)
- `GET /health` → not tracked

### Simple worker

```typescript
export default monitor({
  featureId: 'email-sender',
  fetch: handler,
});
```

Every request shares one budget bucket. Simple, easy to reason about.
