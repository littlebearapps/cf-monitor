/// <reference types="@cloudflare/workers-types" />

// =============================================================================
// MONITOR CONFIG — passed to monitor() wrapper
// =============================================================================

/** Configuration for the monitor() worker wrapper. */
export interface MonitorConfig<Env extends object = object> {
	/** Fetch handler. */
	fetch?: (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;
	/** Scheduled (cron) handler. */
	scheduled?: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => void | Promise<void>;
	/** Queue handler. */
	queue?: (batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext) => void | Promise<void>;
	/** Tail handler (passthrough — not wrapped). */
	tail?: (events: TraceItem[], env: Env, ctx: ExecutionContext) => void | Promise<void>;

	/**
	 * Explicit worker name. Highest priority — overrides env detection.
	 * If not set, falls back to env.WORKER_NAME → env.name → 'worker'.
	 */
	workerName?: string;

	/**
	 * Single feature ID for ALL handler invocations.
	 * Use when you want one budget bucket for the entire worker.
	 * Takes precedence over `features` map and auto-generation.
	 */
	featureId?: string;

	/**
	 * Prefix for auto-generated feature IDs, replacing the worker name.
	 * e.g. featurePrefix: 'platform' → 'platform:fetch:GET:notifications'
	 * Takes precedence over workerName in feature ID generation only.
	 */
	featurePrefix?: string;

	/**
	 * Custom feature ID mapping.
	 * Keys: route pattern ('POST /api/scan'), cron expression ('0 2 * * *'), or queue name.
	 * Values: feature ID string, or `false` to exclude from tracking.
	 */
	features?: Record<string, string | false>;

	/** Per-invocation resource limits. Throws RequestBudgetExceededError if exceeded. */
	limits?: RequestLimits;

	/** Daily/monthly budget overrides (pushed to KV on first cold start). */
	budgets?: BudgetOverrides;

	/** Custom circuit breaker response handler. */
	onCircuitBreaker?: (error: CircuitBreakerError) => Response | void;

	/** Custom error handler. */
	onError?: (error: unknown, handler: string) => Response | void;

	/** Health endpoint path. Default: '/_monitor/health'. Set false to disable. */
	healthEndpoint?: string | false;

	/** Auto heartbeat ping on successful scheduled runs. Default: true. */
	autoHeartbeat?: boolean;

	/** Fail open if SDK encounters internal errors. Default: true. */
	failOpen?: boolean;

	/** Max recursion depth for anti-loop guard. Default: 5. */
	maxRecursionDepth?: number;

	/**
	 * Env binding names to exclude from proxy wrapping.
	 * Use when custom env objects accidentally match CF binding method signatures.
	 * These keys will be returned unwrapped (no metric tracking).
	 */
	excludeBindings?: string[];
}

// =============================================================================
// METRICS
// =============================================================================

/** Accumulated resource metrics for a single invocation. */
export interface MetricsAccumulator {
	d1Writes: number;
	d1Reads: number;
	d1RowsRead: number;
	d1RowsWritten: number;
	kvReads: number;
	kvWrites: number;
	kvDeletes: number;
	kvLists: number;
	aiRequests: number;
	aiNeurons: number;
	vectorizeQueries: number;
	vectorizeInserts: number;
	r2ClassA: number;
	r2ClassB: number;
	queueMessages: number;
	doRequests: number;
	workflowInvocations: number;
	requests: number;
	cpuMs: number;
	errorCount: number;
}

/** Per-invocation resource limits. */
export interface RequestLimits {
	d1Reads?: number;
	d1Writes?: number;
	d1RowsRead?: number;
	d1RowsWritten?: number;
	kvReads?: number;
	kvWrites?: number;
	aiRequests?: number;
	aiNeurons?: number;
	vectorizeQueries?: number;
	vectorizeInserts?: number;
	r2ClassA?: number;
	r2ClassB?: number;
	queueMessages?: number;
	doRequests?: number;
	cpuMs?: number;
}

/** Budget override configuration. */
export interface BudgetOverrides {
	daily?: Partial<Record<BudgetMetric, number>>;
	monthly?: Partial<Record<BudgetMetric, number>>;
}

export type BudgetMetric =
	| 'd1_writes'
	| 'd1_reads'
	| 'kv_writes'
	| 'kv_reads'
	| 'ai_requests'
	| 'ai_neurons'
	| 'r2_class_a'
	| 'r2_class_b'
	| 'queue_messages'
	| 'vectorize_queries';

// =============================================================================
// CIRCUIT BREAKER
// =============================================================================

export class CircuitBreakerError extends Error {
	constructor(
		public readonly featureId: string,
		public readonly level: 'feature' | 'account' | 'global',
		public readonly reason: string
	) {
		super(`Circuit breaker open for ${featureId} at ${level} level: ${reason}`);
		this.name = 'CircuitBreakerError';
	}
}

export class RequestBudgetExceededError extends Error {
	constructor(
		public readonly metric: string,
		public readonly current: number,
		public readonly limit: number
	) {
		super(`Request budget exceeded: ${metric} = ${current} (limit: ${limit})`);
		this.name = 'RequestBudgetExceededError';
	}
}

// =============================================================================
// MONITOR WORKER ENV
// =============================================================================

/** Environment bindings for the cf-monitor worker itself. */
export interface MonitorWorkerEnv {
	CF_MONITOR_KV: KVNamespace;
	CF_MONITOR_AE: AnalyticsEngineDataset;
	CF_ACCOUNT_ID: string;
	ACCOUNT_NAME: string;
	GITHUB_REPO?: string;
	GITHUB_TOKEN?: string;
	SLACK_WEBHOOK_URL?: string;
	CLOUDFLARE_API_TOKEN?: string;
	GATUS_HEARTBEAT_URL?: string;
	GATUS_TOKEN?: string;
	ADMIN_TOKEN?: string;
	/** If set to the string "true", all `owner_only` read endpoints require Authorization: Bearer
	 *  $ADMIN_TOKEN. /_health stays reachable (but drops the `account` field). /protection is
	 *  always auth-required regardless of this flag. Phase 9 (Security Hardening). */
	CF_MONITOR_REQUIRE_AUTH_FOR_READS?: string;
	/** If set to "redacted", `/protection` returns a redacted body (no worker / queue / page /
	 *  index / account names) to anonymous callers instead of 401. Severity / status / score /
	 *  counts remain visible. Off by default; default-safe = 401 without auth. */
	CF_MONITOR_PROTECTION_PUBLIC?: string;
	GITHUB_WEBHOOK_SECRET?: string;
	AI?: Ai;
	/** Custom transient patterns resolved from cf-monitor.yaml (#92). */
	_customTransientPatterns?: CustomTransientPattern[];
}

// =============================================================================
// ERROR TYPES
// =============================================================================

export type ErrorCategory =
	| 'VALIDATION'
	| 'NETWORK'
	| 'CIRCUIT_BREAKER'
	| 'INTERNAL'
	| 'AUTH'
	| 'RATE_LIMIT'
	| 'D1_ERROR'
	| 'KV_ERROR'
	| 'QUEUE_ERROR'
	| 'EXTERNAL_API'
	| 'TIMEOUT';

export type ErrorPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export type TailOutcome =
	| 'exception'
	| 'exceededCpu'
	| 'exceededMemory'
	| 'canceled'
	| 'responseStreamDisconnected'
	| 'scriptNotFound';

// =============================================================================
// ACCOUNT PLAN & BILLING (#53, #54)
// =============================================================================

/** Cloudflare Workers plan type. */
export type AccountPlan = 'free' | 'paid';

/** Billing period from CF Subscriptions API. */
export interface BillingPeriod {
	/** ISO 8601 start date, e.g. "2026-03-02T00:00:00Z" */
	start: string;
	/** ISO 8601 end date, e.g. "2026-04-02T00:00:00Z" */
	end: string;
	/** Day of month the billing period starts (1-31). */
	dayOfMonth: number;
}

/** Monthly included allowances per service for a plan tier. */
export interface PlanAllowances {
	workers: { requests: number; cpuMs: number };
	d1: { rowsRead: number; rowsWritten: number; storageMb: number };
	kv: { reads: number; writes: number; deletes: number; lists: number };
	r2: { classA: number; classB: number; storageMb: number };
	ai: { neurons: number; requests: number };
	aiGateway: { requests: number };
	durableObjects: { requests: number; storedBytes: number };
	vectorize: { queries: number };
	queues: { produced: number; consumed: number };
}

/** Per-service usage snapshot from CF GraphQL API (#55). */
export interface ServiceUsageSnapshot {
	collected_at: string;
	disclaimer: string;
	services: Partial<{
		d1: { rowsRead: number; rowsWritten: number; storageMb?: number };
		kv: { reads: number; writes: number; deletes: number; lists: number };
		r2: { classA: number; classB: number; storageMb?: number };
		workers: { requests: number; cpuMs: number };
		ai: { neurons: number; requests: number };
		/**
		 * AI Gateway hourly aggregate (v0.4.0).
		 * Extended from `{ requests }` — additional fields are optional so callers
		 * predating v0.4.0 continue to type-check.
		 */
		aiGateway: {
			requests: number;
			tokens_in?: number;
			tokens_out?: number;
			cost?: number;
			cached?: number;
			errors?: number;
		};
		durableObjects: { requests: number; storedBytes: number };
		vectorize: { queries: number };
		queues: { produced: number; consumed: number };
	}>;
}

// =============================================================================
// CONFIDENCE LABELS (Tier 2)
// =============================================================================

/**
 * Source/confidence label for each metric block in the `/usage` response. The vocabulary
 * tracks the research docs (docs/research/billing-endpoints-follow-up.md) so a consumer
 * can render a single legend across docs + UI.
 */
export type ConfidenceLabel =
	| 'billing_authoritative'              // /subscriptions plan, /billing/history past invoices, AI Gateway logs
	| 'analytics_estimate'                 // GraphQL Analytics datasets (CF explicitly states not billing-grade)
	| 'runtime_metered'                    // SDK binding proxy, queue realtime REST, REST list endpoints
	| 'user_configured'                    // user-supplied budgets
	| 'static_catalogue'                   // plan-allowance constants from src/worker/account/plan-allowances.ts
	| 'alert_only'                         // Budget Alerts (CF Notifications)
	| 'dashboard_documented_no_public_api' // Billable Usage dashboard
	| 'verified_undocumented'              // /billing/profile etc. — verified shape, no Cloudflare docs page
	| 'unknown';

/**
 * Per-field confidence map embedded in the `/usage` response. Every key MUST correspond
 * to a visible field/section of the response so a CLI consumer can do `confidence[fieldName]`
 * lookup without translation.
 */
export interface UsageConfidence {
	workers?: ConfidenceLabel;
	d1?: ConfidenceLabel;
	kv?: ConfidenceLabel;
	r2?: ConfidenceLabel;
	durableObjects?: ConfidenceLabel;
	aiGateway?: ConfidenceLabel;
	vectorize?: ConfidenceLabel;
	plan?: ConfidenceLabel;
	queues_realtime?: ConfidenceLabel;
	pages?: ConfidenceLabel;
	vectorize_indexes?: ConfidenceLabel;
	billable_usage_dashboard?: ConfidenceLabel;
	budget_alert?: ConfidenceLabel;
}

// =============================================================================
// PROTECTION COVERAGE REPORT (Tier 2 audit layer, Phase 7)
// =============================================================================

export type ProtectionStatus =
	| 'protected'
	| 'partially_protected'
	| 'unprotected'
	| 'unknown'
	| 'not_applicable';

export type ProtectionSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/**
 * A single audit finding produced by the protection-coverage engine. Audit-only — destructive
 * actions belong to a future Tier 3 controller-token layer. Every finding from this phase has
 * `destructive_action_required: false`.
 */
export interface ProtectionFinding {
	/** Stable kebab-case id (`billing-reality-check`, `queue-backlog:<queue_id>`, …). */
	id: string;
	title: string;
	severity: ProtectionSeverity;
	status: ProtectionStatus;
	resource_type: string;
	resource_id?: string;
	resource_name?: string;
	evidence: string;
	missing_controls: string[];
	recommended_actions: string[];
	confidence: ConfidenceLabel;
	source: string;
	destructive_action_required: boolean;
	docs_url?: string;
	docs_ref?: string;
}

export interface ProtectionCoverageReport {
	generated_at: string;
	account: string;
	summary: {
		score: number;
		protected: number;
		partially_protected: number;
		unprotected: number;
		unknown: number;
		not_applicable: number;
		critical: number;
		high: number;
		medium: number;
		low: number;
		info: number;
	};
	findings: ProtectionFinding[];
	confidence: { overall: ConfidenceLabel; usage: ConfidenceLabel; runtime: ConfidenceLabel; billing: ConfidenceLabel };
	caveats: string[];
}

// =============================================================================
// TIER-2 DISCOVERY SNAPSHOTS (queues realtime, pages, vectorize)
// =============================================================================

/** Per-queue realtime backlog row from GET /accounts/{id}/queues/{queue_id}/metrics. */
export interface QueueRealtimeRow {
	id: string;
	name: string;
	backlog_count?: number;
	backlog_bytes?: number;
	oldest_message_timestamp_ms?: number;
	/** Per-queue error message if the metrics call failed; absent on success. */
	error?: string;
}

/** Snapshot written by collect-queue-realtime cron (hourly). */
export interface QueueRealtimeSnapshot {
	collected_at: string;
	source: 'cloudflare_rest';
	confidence: ConfidenceLabel;
	queues: QueueRealtimeRow[];
	/** True if any per-queue metrics call failed; surface this in UI. */
	partial: boolean;
}

/** Per-project row from GET /accounts/{id}/pages/projects. */
export interface PagesProjectRow {
	name: string;
	id?: string;
	production_branch?: string;
	created_on?: string;
	modified_on?: string;
	latest_deployment?: {
		id?: string;
		stage?: string;
		created_on?: string;
	};
	/**
	 * Whether the project uses Pages Functions (billed as Workers). We don't probe per-project
	 * to determine this — left as 'unknown' to avoid implying every Pages project is billable.
	 * Static assets are free; only Functions usage incurs Worker billing.
	 */
	functions_usage: 'unknown';
}

/** Snapshot written by discover-pages-projects cron (daily). */
export interface PagesDiscoverySnapshot {
	collected_at: string;
	source: 'cloudflare_rest';
	confidence: ConfidenceLabel;
	projects: PagesProjectRow[];
	/** True if the listing exceeded per_page and was truncated. */
	partial: boolean;
}

/** Per-index row from GET /accounts/{id}/vectorize/indexes. */
export interface VectorizeIndexRow {
	name: string;
	dimensions?: number;
	metric?: string;
	description?: string;
	created_on?: string;
	modified_on?: string;
}

/** Snapshot written by discover-vectorize-indexes cron (daily). Metadata only — no vector counts. */
export interface VectorizeDiscoverySnapshot {
	collected_at: string;
	source: 'cloudflare_rest';
	confidence: ConfidenceLabel;
	indexes: VectorizeIndexRow[];
	/** Always false this pass — we do not paginate to compute totals. */
	partial: boolean;
	/** Documented limitation: per-index vector counts not collected. */
	caveat: string;
}

// =============================================================================
// AI GATEWAY USAGE SNAPSHOT (v0.4.0)
// =============================================================================

/** Per-model aggregate for an AI Gateway provider. */
export interface AiGatewayModelAggregate {
	requests: number;
	tokens_in: number;
	tokens_out: number;
	cost: number;
	cached: number;
	errors: number;
	p50_duration_ms: number;
}

/** Daily AI Gateway usage breakdown, written to KV by collect-ai-gateway-usage. */
export interface AiGatewayUsageSnapshot {
	/** YYYY-MM-DD (UTC). */
	date: string;
	/** Keyed by gateway id. */
	gateways: Record<string, {
		/** Keyed by provider name (e.g. 'openai', 'google-ai-studio'). */
		providers: Record<string, {
			/** Keyed by model name. */
			models: Record<string, AiGatewayModelAggregate>;
		}>;
	}>;
	/** Account-wide totals (sum across gateways/providers/models). */
	totals: {
		requests: number;
		tokens_in: number;
		tokens_out: number;
		cost: number;
		cached: number;
		errors: number;
	};
	/** Last update epoch ms. */
	lastUpdated: number;
	/** Pricing pass-through note from CF. */
	disclaimer: string;
}

// =============================================================================
// ANALYTICS ENGINE
// =============================================================================

/** AE data point written by the SDK. */
export interface TelemetryDataPoint {
	blobs: [workerName: string, category: string, feature: string];
	doubles: number[];
	indexes: [featureKey: string];
}

// =============================================================================
// CONFIG (cf-monitor.yaml)
// =============================================================================

/** Custom transient pattern from cf-monitor.yaml (#92). */
export interface CustomTransientPattern {
	name: string;
	match: string;
}

export interface CfMonitorConfig {
	account: {
		name: string;
		cloudflare_account_id: string;
	};
	github?: {
		repo: string;
		token?: string;
	};
	alerts?: {
		slack_webhook?: string;
	};
	monitoring?: {
		gatus_heartbeat_url?: string;
		gatus_token?: string;
	};
	budgets?: {
		daily?: Record<string, number>;
		monthly?: Record<string, number>;
		per_invocation?: Record<string, number>;
	};
	ai?: {
		enabled?: boolean;
		pattern_discovery?: boolean;
		health_reports?: boolean;
		model?: string;
	};
	/** Custom transient patterns — errors matching these get daily dedup instead of per-event (#92). */
	transient_patterns?: CustomTransientPattern[];
	exclude?: string[];
}

// =============================================================================
// INTERNAL
// =============================================================================

/** Marker symbol for tracked environments. */
export const TRACKED_ENV_SYMBOL = Symbol('cf-monitor:tracked');

/** A worker env that has been wrapped with metric-tracking proxies. */
export type TrackedEnv<Env extends object = object> = Env & {
	[TRACKED_ENV_SYMBOL]: {
		metrics: MetricsAccumulator;
		featureId: string;
		workerName: string;
		startTime: number;
	};
};
