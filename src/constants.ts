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

	// Gap detection
	GAP_ALERT: 'gap:alert:',

	// Worker discovery
	WORKER_REGISTRY: 'workers:',
	WORKER_LIST: 'workers:__list__',

	// Config cache
	CONFIG_CACHE: 'config:cache',

	// AI patterns (optional)
	PATTERNS_APPROVED: 'patterns:approved',
} as const;

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

/** Default daily budgets for CF Workers Paid plan. */
export const PAID_PLAN_DAILY_BUDGETS = {
	d1_writes: 1_333_333, // 50M/month / 30 * 0.8
	d1_reads: 16_666_667, // 5B/month / 30 * 0.1 (conservative)
	kv_writes: 26_667, // 1M/month / 30 * 0.8
	kv_reads: 333_333, // 10M/month / 30 * 0.1
	ai_neurons: 333_333, // 10M/month / 30
	r2_class_a: 33_333, // 1M/month / 30
	r2_class_b: 333_333, // 10M/month / 30
} as const;

/** Default daily budgets for CF Workers Free plan. */
export const FREE_PLAN_DAILY_BUDGETS = {
	d1_writes: 10_000,
	d1_reads: 166_667,
	kv_writes: 1_000,
	kv_reads: 33_333,
	ai_neurons: 33_333,
	r2_class_a: 3_333,
	r2_class_b: 33_333,
} as const;

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
