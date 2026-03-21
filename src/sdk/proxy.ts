import { MONITOR_BINDINGS } from '../constants.js';
import { type MetricsAccumulator, type RequestLimits, RequestBudgetExceededError, TRACKED_ENV_SYMBOL, type TrackedEnv } from '../types.js';
import { createMetrics } from './metrics.js';

// =============================================================================
// ENV PROXY — wraps bindings with metric tracking
// =============================================================================

/**
 * Create a tracked environment by wrapping all resource bindings with proxies.
 * Each binding method call increments the corresponding metric counter.
 */
export function createTrackedEnv<Env extends object>(
	env: Env,
	featureId: string,
	workerName: string,
	limits?: RequestLimits
): TrackedEnv<Env> {
	const metrics = createMetrics();
	const startTime = Date.now();

	const handler: ProxyHandler<Env> = {
		get(target, prop, receiver) {
			// Internal metadata
			if (prop === TRACKED_ENV_SYMBOL) {
				return { metrics, featureId, workerName, startTime };
			}

			const value = Reflect.get(target, prop, receiver);
			if (value == null || typeof value !== 'object') return value;

			// Skip monitor's own bindings
			if (prop === MONITOR_BINDINGS.KV || prop === MONITOR_BINDINGS.AE) return value;

			// Wrap known binding types
			if (isD1Database(value)) return wrapD1(value, metrics, limits);
			if (isKVNamespace(value)) return wrapKV(value, metrics, limits);
			if (isR2Bucket(value)) return wrapR2(value, metrics, limits);
			if (isAiBinding(value)) return wrapAI(value, metrics, limits);
			if (isVectorize(value)) return wrapVectorize(value, metrics, limits);
			if (isQueue(value)) return wrapQueue(value, metrics, limits);
			if (isDurableObjectNamespace(value)) return wrapDurableObject(value, metrics, limits);
			if (isWorkflow(value)) return wrapWorkflow(value, metrics);

			return value;
		},
	};

	return new Proxy(env, handler) as TrackedEnv<Env>;
}

/**
 * Extract metrics from a tracked environment.
 */
export function getMetrics<Env extends object>(env: TrackedEnv<Env>): MetricsAccumulator {
	return env[TRACKED_ENV_SYMBOL].metrics;
}

/**
 * Extract tracking metadata from a tracked environment.
 */
export function getTrackingInfo<Env extends object>(env: TrackedEnv<Env>): {
	metrics: MetricsAccumulator;
	featureId: string;
	workerName: string;
	startTime: number;
} {
	return env[TRACKED_ENV_SYMBOL];
}

// =============================================================================
// LIMIT CHECKING
// =============================================================================

function checkLimit(metric: string, current: number, limits: RequestLimits | undefined): void {
	if (!limits) return;
	const limit = (limits as Record<string, number | undefined>)[metric];
	if (limit != null && current > limit) {
		throw new RequestBudgetExceededError(metric, current, limit);
	}
}

// =============================================================================
// D1 PROXY
// =============================================================================

function isD1Database(v: unknown): boolean {
	const obj = v as Record<string, unknown>;
	return typeof obj.prepare === 'function' && typeof obj.batch === 'function';
}

function wrapD1(db: unknown, metrics: MetricsAccumulator, limits?: RequestLimits): unknown {
	return new Proxy(db as object, {
		get(target, prop) {
			const original = Reflect.get(target, prop);
			if (typeof original !== 'function') return original;

			if (prop === 'prepare') {
				return (...args: unknown[]) => {
					const stmt = (original as Function).apply(target, args);
					return wrapD1Statement(stmt, metrics, limits);
				};
			}
			if (prop === 'batch') {
				return async (...args: unknown[]) => {
					const results = await (original as Function).apply(target, args);
					// Batch: count each statement
					const stmts = args[0] as unknown[];
					if (Array.isArray(stmts)) {
						metrics.d1Writes += stmts.length;
						checkLimit('d1Writes', metrics.d1Writes, limits);
					}
					return results;
				};
			}
			if (prop === 'exec') {
				return async (...args: unknown[]) => {
					metrics.d1Writes++;
					checkLimit('d1Writes', metrics.d1Writes, limits);
					return (original as Function).apply(target, args);
				};
			}
			return original.bind(target);
		},
	});
}

function wrapD1Statement(stmt: unknown, metrics: MetricsAccumulator, limits?: RequestLimits): unknown {
	return new Proxy(stmt as object, {
		get(target, prop) {
			const original = Reflect.get(target, prop);
			if (typeof original !== 'function') return original;

			if (prop === 'bind') {
				return (...args: unknown[]) => {
					const bound = (original as Function).apply(target, args);
					return wrapD1Statement(bound, metrics, limits);
				};
			}

			const isRead = prop === 'first' || prop === 'all' || prop === 'raw';
			const isWrite = prop === 'run';

			if (isRead) {
				return async (...args: unknown[]) => {
					metrics.d1Reads++;
					checkLimit('d1Reads', metrics.d1Reads, limits);
					const result = await (original as Function).apply(target, args);
					// Track rows read from result metadata
					if (result && typeof result === 'object' && 'meta' in result) {
						const meta = (result as Record<string, unknown>).meta as Record<string, unknown> | undefined;
						if (meta && typeof meta.rows_read === 'number') {
							metrics.d1RowsRead += meta.rows_read;
						}
						if (meta && typeof meta.rows_written === 'number') {
							metrics.d1RowsWritten += meta.rows_written;
						}
					}
					return result;
				};
			}

			if (isWrite) {
				return async (...args: unknown[]) => {
					metrics.d1Writes++;
					checkLimit('d1Writes', metrics.d1Writes, limits);
					const result = await (original as Function).apply(target, args);
					if (result && typeof result === 'object' && 'meta' in result) {
						const meta = (result as Record<string, unknown>).meta as Record<string, unknown> | undefined;
						if (meta && typeof meta.rows_written === 'number') {
							metrics.d1RowsWritten += meta.rows_written;
						}
						if (meta && typeof meta.rows_read === 'number') {
							metrics.d1RowsRead += meta.rows_read;
						}
					}
					return result;
				};
			}

			return original.bind(target);
		},
	});
}

// =============================================================================
// KV PROXY
// =============================================================================

function isKVNamespace(v: unknown): boolean {
	const obj = v as Record<string, unknown>;
	return (
		typeof obj.get === 'function' &&
		typeof obj.put === 'function' &&
		typeof obj.delete === 'function' &&
		typeof obj.list === 'function' &&
		!('head' in obj) // Distinguish from R2
	);
}

function wrapKV(kv: unknown, metrics: MetricsAccumulator, limits?: RequestLimits): unknown {
	return new Proxy(kv as object, {
		get(target, prop) {
			const original = Reflect.get(target, prop);
			if (typeof original !== 'function') return original;

			if (prop === 'get' || prop === 'getWithMetadata') {
				return (...args: unknown[]) => {
					metrics.kvReads++;
					checkLimit('kvReads', metrics.kvReads, limits);
					return (original as Function).apply(target, args);
				};
			}
			if (prop === 'put') {
				return (...args: unknown[]) => {
					metrics.kvWrites++;
					checkLimit('kvWrites', metrics.kvWrites, limits);
					return (original as Function).apply(target, args);
				};
			}
			if (prop === 'delete') {
				return (...args: unknown[]) => {
					metrics.kvDeletes++;
					return (original as Function).apply(target, args);
				};
			}
			if (prop === 'list') {
				return (...args: unknown[]) => {
					metrics.kvLists++;
					return (original as Function).apply(target, args);
				};
			}
			return original.bind(target);
		},
	});
}

// =============================================================================
// R2 PROXY
// =============================================================================

function isR2Bucket(v: unknown): boolean {
	const obj = v as Record<string, unknown>;
	return (
		typeof obj.get === 'function' &&
		typeof obj.put === 'function' &&
		typeof obj.head === 'function' &&
		typeof obj.list === 'function'
	);
}

function wrapR2(r2: unknown, metrics: MetricsAccumulator, limits?: RequestLimits): unknown {
	// R2 Class A: put, delete, createMultipartUpload, etc. (mutations)
	// R2 Class B: get, head, list (reads)
	const classAMethods = new Set(['put', 'delete', 'createMultipartUpload', 'resumeMultipartUpload']);
	const classBMethods = new Set(['get', 'head', 'list']);

	return new Proxy(r2 as object, {
		get(target, prop) {
			const original = Reflect.get(target, prop);
			if (typeof original !== 'function') return original;

			if (classAMethods.has(prop as string)) {
				return (...args: unknown[]) => {
					metrics.r2ClassA++;
					checkLimit('r2ClassA', metrics.r2ClassA, limits);
					return (original as Function).apply(target, args);
				};
			}
			if (classBMethods.has(prop as string)) {
				return (...args: unknown[]) => {
					metrics.r2ClassB++;
					return (original as Function).apply(target, args);
				};
			}
			return original.bind(target);
		},
	});
}

// =============================================================================
// WORKERS AI PROXY
// =============================================================================

function isAiBinding(v: unknown): boolean {
	const obj = v as Record<string, unknown>;
	return typeof obj.run === 'function' && !('get' in obj);
}

function wrapAI(ai: unknown, metrics: MetricsAccumulator, limits?: RequestLimits): unknown {
	return new Proxy(ai as object, {
		get(target, prop) {
			const original = Reflect.get(target, prop);
			if (typeof original !== 'function') return original;

			if (prop === 'run') {
				return async (...args: unknown[]) => {
					metrics.aiRequests++;
					checkLimit('aiRequests', metrics.aiRequests, limits);
					return (original as Function).apply(target, args);
				};
			}
			return original.bind(target);
		},
	});
}

// =============================================================================
// VECTORIZE PROXY
// =============================================================================

function isVectorize(v: unknown): boolean {
	const obj = v as Record<string, unknown>;
	return typeof obj.query === 'function' && typeof obj.insert === 'function';
}

function wrapVectorize(vec: unknown, metrics: MetricsAccumulator, limits?: RequestLimits): unknown {
	return new Proxy(vec as object, {
		get(target, prop) {
			const original = Reflect.get(target, prop);
			if (typeof original !== 'function') return original;

			if (prop === 'query') {
				return (...args: unknown[]) => {
					metrics.vectorizeQueries++;
					checkLimit('vectorizeQueries', metrics.vectorizeQueries, limits);
					return (original as Function).apply(target, args);
				};
			}
			if (prop === 'insert' || prop === 'upsert') {
				return (...args: unknown[]) => {
					metrics.vectorizeInserts++;
					return (original as Function).apply(target, args);
				};
			}
			return original.bind(target);
		},
	});
}

// =============================================================================
// QUEUE PROXY
// =============================================================================

function isQueue(v: unknown): boolean {
	const obj = v as Record<string, unknown>;
	return typeof obj.send === 'function' && typeof obj.sendBatch === 'function';
}

function wrapQueue(queue: unknown, metrics: MetricsAccumulator, limits?: RequestLimits): unknown {
	return new Proxy(queue as object, {
		get(target, prop) {
			const original = Reflect.get(target, prop);
			if (typeof original !== 'function') return original;

			if (prop === 'send') {
				return (...args: unknown[]) => {
					metrics.queueMessages++;
					checkLimit('queueMessages', metrics.queueMessages, limits);
					return (original as Function).apply(target, args);
				};
			}
			if (prop === 'sendBatch') {
				return (...args: unknown[]) => {
					const messages = args[0] as unknown[];
					metrics.queueMessages += Array.isArray(messages) ? messages.length : 1;
					checkLimit('queueMessages', metrics.queueMessages, limits);
					return (original as Function).apply(target, args);
				};
			}
			return original.bind(target);
		},
	});
}

// =============================================================================
// DURABLE OBJECT PROXY (#12)
// =============================================================================

function isDurableObjectNamespace(v: unknown): boolean {
	const obj = v as Record<string, unknown>;
	return typeof obj.get === 'function' && typeof obj.idFromName === 'function';
}

function wrapDurableObject(ns: unknown, metrics: MetricsAccumulator, limits?: RequestLimits): unknown {
	return new Proxy(ns as object, {
		get(target, prop) {
			const original = Reflect.get(target, prop);
			if (typeof original !== 'function') return original;

			if (prop === 'get') {
				return (...args: unknown[]) => {
					const stub = (original as Function).apply(target, args);
					// Wrap the stub's fetch() to track doRequests
					return wrapDurableObjectStub(stub, metrics, limits);
				};
			}
			return original.bind(target);
		},
	});
}

function wrapDurableObjectStub(stub: unknown, metrics: MetricsAccumulator, limits?: RequestLimits): unknown {
	return new Proxy(stub as object, {
		get(target, prop) {
			const original = Reflect.get(target, prop);
			if (typeof original !== 'function') return original;

			// Wrap fetch() calls on the stub
			if (prop === 'fetch') {
				return async (...args: unknown[]) => {
					metrics.doRequests++;
					checkLimit('doRequests', metrics.doRequests, limits);
					return (original as Function).apply(target, args);
				};
			}
			return original.bind(target);
		},
	});
}

// =============================================================================
// WORKFLOW PROXY (#12)
// =============================================================================

function isWorkflow(v: unknown): boolean {
	const obj = v as Record<string, unknown>;
	return typeof obj.create === 'function' && typeof obj.get === 'function' && !('put' in obj);
}

function wrapWorkflow(wf: unknown, metrics: MetricsAccumulator): unknown {
	return new Proxy(wf as object, {
		get(target, prop) {
			const original = Reflect.get(target, prop);
			if (typeof original !== 'function') return original;

			if (prop === 'create') {
				return async (...args: unknown[]) => {
					metrics.workflowInvocations++;
					return (original as Function).apply(target, args);
				};
			}
			return original.bind(target);
		},
	});
}
