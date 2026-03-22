// =============================================================================
// ANALYTICS ENGINE FIELD MAPPING
// =============================================================================

/**
 * AE doubles field positions (1-indexed). Append-only — never reorder.
 * Preserves backward compatibility with platform-consumer-sdk layout.
 */
export const AE_FIELDS = {
	d1Writes: 0,
	d1Reads: 1,
	kvReads: 2,
	kvWrites: 3,
	doRequests: 4,
	doGbSeconds: 5,
	r2ClassA: 6,
	r2ClassB: 7,
	aiNeurons: 8,
	queueMessages: 9,
	requests: 10,
	cpuMs: 11,
	d1RowsRead: 12,
	d1RowsWritten: 13,
	kvDeletes: 14,
	kvLists: 15,
	aiRequests: 16,
	vectorizeQueries: 17,
	vectorizeInserts: 18,
	workflowInvocations: 19,
} as const;

/** Total number of AE double fields used. */
export const AE_FIELD_COUNT = 20;

// =============================================================================
// KV KEY PREFIXES
// =============================================================================

export const KV = {
	// Circuit breaker
	CB_FEATURE: 'cb:v1:feature:',
	CB_ACCOUNT: 'cb:v1:account',
	CB_GLOBAL: 'cb:v1:global',

	// Budget config + usage
	BUDGET_CONFIG: 'budget:config:',
	BUDGET_DAILY: 'budget:usage:daily:',
	BUDGET_MONTHLY: 'budget:usage:monthly:',
	BUDGET_WARN: 'budget:warn:',
	BUDGET_WARN_MONTHLY: 'budget:warn:monthly:',

	// Error tracking
	ERR_FINGERPRINT: 'err:fp:',
	ERR_RATE: 'err:rate:',
	ERR_LOCK: 'err:lock:',
	ERR_TRANSIENT: 'err:transient:',

	// Warning digest (daily batching for P4 warnings)
	WARN_DIGEST: 'warn:digest:',

	// Gap detection
	GAP_ALERT: 'gap:alert:',

	// Worker discovery
	WORKER_REGISTRY: 'workers:',
	WORKER_LIST: 'workers:__list__',

	// Config cache
	CONFIG_CACHE: 'config:cache',

	// Account plan + billing (#53, #54)
	CONFIG_PLAN: 'config:plan',
	CONFIG_BILLING_PERIOD: 'config:billing_period',

	// Account-wide usage snapshots (#55)
	USAGE_ACCOUNT: 'usage:account:',

	// AI patterns (optional)
	PATTERNS_APPROVED: 'patterns:approved',
} as const;

// =============================================================================
// METRICS → BUDGET KEY MAPPING
// =============================================================================

/** Maps MetricsAccumulator field names to BudgetMetric keys for KV storage. */
export const METRICS_TO_BUDGET: Record<string, string> = {
	d1Writes: 'd1_writes',
	d1Reads: 'd1_reads',
	kvWrites: 'kv_writes',
	kvReads: 'kv_reads',
	aiRequests: 'ai_requests',
	aiNeurons: 'ai_neurons',
	r2ClassA: 'r2_class_a',
	r2ClassB: 'r2_class_b',
	queueMessages: 'queue_messages',
	vectorizeQueries: 'vectorize_queries',
};

// =============================================================================
// BINDING NAMES
// =============================================================================

export const MONITOR_BINDINGS = {
	KV: 'CF_MONITOR_KV',
	AE: 'CF_MONITOR_AE',
} as const;

// =============================================================================
// DEFAULTS
// =============================================================================

/** Default per-invocation limits (safety valve against runaway loops). */
export const DEFAULT_REQUEST_LIMITS = {
	d1Writes: 1000,
	d1Reads: 5000,
	kvWrites: 200,
	kvReads: 1000,
	aiRequests: 50,
	r2ClassA: 100,
	queueMessages: 500,
} as const;

// Plan budget defaults — canonical source in src/worker/account/plan-allowances.ts
// Re-exported here for backward compatibility.
export { PAID_PLAN_DAILY_BUDGETS, FREE_PLAN_DAILY_BUDGETS } from './worker/account/plan-allowances.js';

// =============================================================================
// CF PRICING (USD per unit)
// =============================================================================

export const CF_PRICING = {
	d1_read: 0.25 / 1_000_000,
	d1_write: 0.75 / 1_000_000,
	kv_read: 0.50 / 1_000_000,
	kv_write: 5.00 / 1_000_000,
	r2_class_a: 0.0015 / 1_000,
	r2_class_b: 0.01 / 1_000_000,
	ai_neuron: 0.011 / 1_000,
	queue_message: 0.40 / 1_000_000,
	do_request: 0.15 / 1_000_000,
	vectorize_query: 0.01 / 1_000,
} as const;

// =============================================================================
// ERROR COLLECTION
// =============================================================================

/** Tail event outcomes that should be captured. */
export const CAPTURABLE_OUTCOMES: ReadonlySet<string> = new Set([
	'exception',
	'exceededCpu',
	'exceededMemory',
	'canceled',
	'responseStreamDisconnected',
	'scriptNotFound',
]);

/** Max GitHub issues created per script per hour. */
export const MAX_ISSUES_PER_SCRIPT_PER_HOUR = 10;

/** Error priority thresholds. */
export const PRIORITY_MAP: Record<string, string> = {
	exception: 'P1',
	exceededCpu: 'P0',
	exceededMemory: 'P0',
	canceled: 'P2',
	responseStreamDisconnected: 'P3',
	scriptNotFound: 'P0',
	soft_error: 'P2',
	warning: 'P4',
};
