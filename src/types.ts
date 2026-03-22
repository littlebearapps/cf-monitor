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
	AI?: Ai;
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
		aiGateway: { requests: number };
		durableObjects: { requests: number; storedBytes: number };
		vectorize: { queries: number };
		queues: { produced: number; consumed: number };
	}>;
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
