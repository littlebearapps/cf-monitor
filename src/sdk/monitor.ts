/// <reference types="@cloudflare/workers-types" />

/**
 * cf-monitor Worker Wrapper
 *
 * Wraps a Cloudflare Worker with automatic:
 * - Resource metrics tracking (D1, KV, R2, AI, Queue, DO, Vectorize, Workflow)
 * - Circuit breaker enforcement (feature + account)
 * - Direct Analytics Engine telemetry (no queue needed)
 * - Gatus heartbeat pinging (scheduled handlers)
 * - Health endpoint at /_monitor/health
 *
 * @example
 * ```typescript
 * import { monitor } from '@littlebearapps/cf-monitor';
 *
 * export default monitor({
 *   fetch: async (request, env, ctx) => {
 *     const data = await env.DB.prepare('SELECT 1').first();
 *     return Response.json(data);
 *   },
 *   scheduled: async (event, env, ctx) => {
 *     await doWork(env);
 *   },
 * });
 * ```
 */

import { KV, METRICS_TO_BUDGET, MONITOR_BINDINGS } from '../constants.js';
import { CircuitBreakerError, type MetricsAccumulator, type MonitorConfig, TRACKED_ENV_SYMBOL, type TrackedEnv } from '../types.js';
import { checkAccountCb, checkFeatureCb } from './circuit-breaker.js';
import { detectWorkerName, generateCronFeatureId, generateFetchFeatureId, generateQueueFeatureId, hasMonitorBindings } from './detection.js';
import { pingHeartbeat } from './heartbeat.js';
import { isZero, toDataPoint } from './metrics.js';
import { createTrackedEnv, getTrackingInfo } from './proxy.js';

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Create a Cloudflare Worker export with automatic cf-monitor instrumentation.
 *
 * @param config - Worker configuration (only handlers required)
 * @returns Cloudflare Worker export object
 */
export function monitor<Env extends object = object>(
	config: MonitorConfig<Env>
): ExportedHandler<Env> {
	const failOpen = config.failOpen !== false;
	const autoHeartbeat = config.autoHeartbeat !== false;
	const healthPath = config.healthEndpoint === false ? null : (config.healthEndpoint ?? '/_monitor/health');
	const limits = config.limits;

	const worker: ExportedHandler<Env> = {};

	// ── Fetch Handler ──────────────────────────────────────────────────────

	if (config.fetch || healthPath) {
		worker.fetch = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
			// Health endpoint (before instrumentation — always accessible)
			if (healthPath) {
				const url = new URL(request.url);
				if (url.pathname === healthPath) {
					return handleHealthEndpoint(env);
				}
			}

			if (!config.fetch) return new Response('Not Found', { status: 404 });

			if (!hasMonitorBindings(env)) {
				if (failOpen) {
					console.warn('[cf-monitor] Missing CF_MONITOR_KV or CF_MONITOR_AE bindings. Running unwrapped.');
					return config.fetch(request, env, ctx);
				}
				throw new Error('[cf-monitor] Missing CF_MONITOR_KV or CF_MONITOR_AE bindings.');
			}

			const workerName = detectWorkerName(env);
			const featureId = resolveFeatureId(config, 'fetch', workerName, { request });
			if (featureId === false) return config.fetch(request, env, ctx);

			const kv = getKV(env);

			// Account-level circuit breaker
			const cbResponse = await checkAccountCb(kv);
			if (cbResponse) {
				return handleCbResponse(config, cbResponse, featureId, 'fetch');
			}

			// Feature-level circuit breaker
			const featureCb = await checkFeatureCb(kv, featureId);
			if (featureCb === 'STOP') {
				const err = new CircuitBreakerError(featureId, 'feature', 'Budget exceeded');
				if (config.onCircuitBreaker) {
					const resp = config.onCircuitBreaker(err);
					if (resp instanceof Response) return resp;
				}
				return Response.json({ error: 'Feature temporarily unavailable', feature: featureId }, { status: 503 });
			}

			const trackedEnv = createTrackedEnv(env, featureId, workerName, limits);

			try {
				return await config.fetch(request, trackedEnv as unknown as Env, ctx);
			} catch (error) {
				if (error instanceof CircuitBreakerError) {
					return handleCbResponse(config, null, featureId, 'fetch') ??
						Response.json({ error: 'Service unavailable' }, { status: 503 });
				}

				getTrackingInfo(trackedEnv).metrics.errorCount++;
				if (config.onError) {
					const resp = config.onError(error, 'fetch');
					if (resp instanceof Response) return resp;
				}
				return Response.json({ error: 'Internal Server Error' }, { status: 500 });
			} finally {
				ctx.waitUntil(flushTelemetry(trackedEnv));
			}
		};
	}

	// ── Scheduled Handler ──────────────────────────────────────────────────

	if (config.scheduled) {
		const userScheduled = config.scheduled;

		worker.scheduled = async (controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> => {
			if (!hasMonitorBindings(env)) {
				if (failOpen) {
					console.warn('[cf-monitor] Missing bindings. Running unwrapped.');
					await userScheduled(controller, env, ctx);
					return;
				}
				throw new Error('[cf-monitor] Missing CF_MONITOR_KV or CF_MONITOR_AE bindings.');
			}

			const workerName = detectWorkerName(env);
			const featureId = resolveFeatureId(config, 'cron', workerName, { cron: controller.cron });
			if (featureId === false) {
				await userScheduled(controller, env, ctx);
				return;
			}

			const kv = getKV(env);

			// Account-level circuit breaker
			const cbResponse = await checkAccountCb(kv);
			if (cbResponse) {
				console.log(`[cf-monitor] Cron ${controller.cron} skipped: account circuit breaker active`);
				return;
			}

			const trackedEnv = createTrackedEnv(env, featureId, workerName, limits);
			let success = false;

			try {
				await userScheduled(controller, trackedEnv as unknown as Env, ctx);
				success = true;
			} catch (error) {
				getTrackingInfo(trackedEnv).metrics.errorCount++;
				if (config.onError) {
					config.onError(error, 'scheduled');
					return;
				}
				throw error;
			} finally {
				ctx.waitUntil(flushTelemetry(trackedEnv));

				if (autoHeartbeat && success) {
					const e = env as Record<string, unknown>;
					pingHeartbeat(
						ctx,
						e.GATUS_HEARTBEAT_URL as string | undefined,
						e.GATUS_TOKEN as string | undefined,
						true
					);
				}
			}
		};
	}

	// ── Queue Handler ──────────────────────────────────────────────────────

	if (config.queue) {
		const userQueue = config.queue;

		worker.queue = async (batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> => {
			if (!hasMonitorBindings(env)) {
				if (failOpen) {
					await userQueue(batch, env, ctx);
					return;
				}
				throw new Error('[cf-monitor] Missing bindings.');
			}

			const workerName = detectWorkerName(env);
			const featureId = resolveFeatureId(config, 'queue', workerName, { queueName: batch.queue });
			if (featureId === false) {
				await userQueue(batch, env, ctx);
				return;
			}

			const kv = getKV(env);
			const cbResponse = await checkAccountCb(kv);
			if (cbResponse) {
				console.log(`[cf-monitor] Queue ${batch.queue} skipped: account CB active. Retrying.`);
				batch.retryAll();
				return;
			}

			const trackedEnv = createTrackedEnv(env, featureId, workerName, limits);

			try {
				await userQueue(batch, trackedEnv as unknown as Env, ctx);
			} catch (error) {
				getTrackingInfo(trackedEnv).metrics.errorCount++;
				if (config.onError) {
					config.onError(error, 'queue');
					return;
				}
				throw error;
			} finally {
				ctx.waitUntil(flushTelemetry(trackedEnv));
			}
		};
	}

	// ── Tail Handler (passthrough) ─────────────────────────────────────────

	if (config.tail) {
		worker.tail = config.tail;
	}

	return worker;
}

// =============================================================================
// INTERNALS
// =============================================================================

/** Resolve feature ID from config or auto-generate. */
function resolveFeatureId<Env extends object>(
	config: MonitorConfig<Env>,
	handlerType: 'fetch' | 'cron' | 'queue',
	workerName: string,
	context: { request?: Request; cron?: string; queueName?: string }
): string | false {
	if (config.features) {
		let key: string | undefined;
		if (handlerType === 'fetch' && context.request) {
			const url = new URL(context.request.url);
			key = `${context.request.method} ${url.pathname}`;
			// Try exact match first, then check prefix patterns
			const match = config.features[key];
			if (match === false) return false;
			if (typeof match === 'string') return match;
		} else if (handlerType === 'cron' && context.cron) {
			key = context.cron;
			const match = config.features[key];
			if (match === false) return false;
			if (typeof match === 'string') return match;
		} else if (handlerType === 'queue' && context.queueName) {
			key = context.queueName;
			const match = config.features[key];
			if (match === false) return false;
			if (typeof match === 'string') return match;
		}
	}

	// Auto-generate
	if (handlerType === 'fetch' && context.request) {
		return generateFetchFeatureId(workerName, context.request);
	}
	if (handlerType === 'cron' && context.cron) {
		return generateCronFeatureId(workerName, context.cron);
	}
	if (handlerType === 'queue' && context.queueName) {
		return generateQueueFeatureId(workerName, context.queueName);
	}
	return `${workerName}:${handlerType}:unknown`;
}

/** Flush accumulated metrics to Analytics Engine and update budget counters. */
async function flushTelemetry<Env extends object>(trackedEnv: TrackedEnv<Env>): Promise<void> {
	try {
		const { metrics, featureId, workerName } = trackedEnv[TRACKED_ENV_SYMBOL];

		// Compute cpuMs as elapsed time (approximation — real CPU time not available)
		metrics.cpuMs = Date.now() - trackedEnv[TRACKED_ENV_SYMBOL].startTime;

		// Write last_seen timestamp for gap detection (#19)
		// Done before isZero check — a worker handling requests should always update its heartbeat
		const kv = (trackedEnv as unknown as Record<string, unknown>)[MONITOR_BINDINGS.KV] as
			| KVNamespace
			| undefined;
		if (kv) {
			await kv.put(
				`${KV.WORKER_REGISTRY}${workerName}:last_seen`,
				new Date().toISOString(),
				{ expirationTtl: 90000 } // 25hr TTL — auto-expire stale entries
			);
		}

		if (isZero(metrics)) return;

		const ae = (trackedEnv as unknown as Record<string, unknown>)[MONITOR_BINDINGS.AE] as
			| AnalyticsEngineDataset
			| undefined;
		if (!ae) return;

		const dp = toDataPoint(workerName, featureId, metrics);
		ae.writeDataPoint({
			blobs: dp.blobs,
			doubles: dp.doubles,
			indexes: dp.indexes,
		});

		// Accumulate daily budget usage in KV for budget-check cron
		await accumulateBudgetUsage(trackedEnv, featureId, metrics);
	} catch {
		// Fail silently — never block the user's response
	}
}

/** Increment daily KV budget counters for budget enforcement. */
async function accumulateBudgetUsage<Env extends object>(
	trackedEnv: TrackedEnv<Env>,
	featureId: string,
	metrics: MetricsAccumulator
): Promise<void> {
	try {
		const kv = (trackedEnv as unknown as Record<string, unknown>)[MONITOR_BINDINGS.KV] as
			| KVNamespace
			| undefined;
		if (!kv) return;

		const today = new Date().toISOString().slice(0, 10);
		const key = `${KV.BUDGET_DAILY}${featureId}:${today}`;

		const currentRaw = await kv.get(key);
		const current: Record<string, number> = currentRaw ? JSON.parse(currentRaw) : {};

		let changed = false;
		for (const [metricsKey, budgetKey] of Object.entries(METRICS_TO_BUDGET)) {
			const value = metrics[metricsKey as keyof MetricsAccumulator] as number;
			if (value > 0) {
				current[budgetKey] = (current[budgetKey] ?? 0) + value;
				changed = true;
			}
		}

		if (changed) {
			await kv.put(key, JSON.stringify(current), { expirationTtl: 90000 }); // 25hr TTL
		}
	} catch {
		// Fail open — budget accumulation is best-effort
	}
}

/** Get KV binding from env. */
function getKV(env: object): KVNamespace {
	return (env as Record<string, unknown>)[MONITOR_BINDINGS.KV] as KVNamespace;
}

/** Handle circuit breaker response with optional custom handler. */
function handleCbResponse<Env extends object>(
	config: MonitorConfig<Env>,
	response: Response | null,
	featureId: string,
	_handler: string
): Response {
	if (config.onCircuitBreaker) {
		const err = new CircuitBreakerError(featureId, 'account', 'Account circuit breaker active');
		const custom = config.onCircuitBreaker(err);
		if (custom instanceof Response) return custom;
	}
	return response ?? Response.json({ error: 'Service temporarily unavailable' }, { status: 503 });
}

/** Simple health endpoint. */
async function handleHealthEndpoint(env: object): Promise<Response> {
	const workerName = detectWorkerName(env);
	const hasBindings = hasMonitorBindings(env);
	const kv = hasBindings ? getKV(env) : null;

	let cbStatus = 'unknown';
	if (kv) {
		try {
			const resp = await checkAccountCb(kv);
			cbStatus = resp ? 'tripped' : 'ok';
		} catch {
			cbStatus = 'error';
		}
	}

	return Response.json({
		healthy: hasBindings,
		worker: workerName,
		bindings: hasBindings,
		circuitBreaker: cbStatus,
		timestamp: Date.now(),
	}, { status: hasBindings ? 200 : 503 });
}
