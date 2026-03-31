import { KV, CRON_HANDLER_REGISTRY, AE_FIELD_COUNT } from '../constants.js';
import type { MonitorWorkerEnv } from '../types.js';

// =============================================================================
// TYPES
// =============================================================================

/** Timestamps for each cron handler's last execution. */
export interface CronTimestamps {
	[handler: string]: {
		lastRun: string;
		durationMs: number;
		success: boolean;
	};
}

/** Self-health status returned by getSelfHealth(). */
export interface SelfHealthStatus {
	healthy: boolean;
	staleCrons: string[];
	todayErrors: number;
	handlerErrors: Record<string, number>;
	crons: Record<string, { lastRun: string | null; stale: boolean }>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const TTL_48H = 172800; // 48 hours in seconds

// =============================================================================
// recordCronExecution
// =============================================================================

/**
 * Record a cron handler's execution timestamp in KV.
 * Uses per-handler keys (v2) to avoid read-merge-write race conditions
 * when concurrent handlers (e.g. daily-rollup + worker-discovery) both
 * finish at the same time. Fail-open.
 */
export async function recordCronExecution(
	env: MonitorWorkerEnv,
	handler: string,
	durationMs: number,
	success: boolean
): Promise<void> {
	try {
		const entry: CronTimestamps[string] = {
			lastRun: new Date().toISOString(),
			durationMs,
			success,
		};

		// v2: per-handler key — no read needed, no race condition
		await env.CF_MONITOR_KV.put(
			`${KV.SELF_CRON_HANDLER}${handler}`,
			JSON.stringify(entry),
			{ expirationTtl: TTL_48H },
		);
	} catch (err) {
		console.warn(`[cf-monitor:self] Failed to record cron execution for ${handler}: ${err}`);
	}
}

// =============================================================================
// recordHandlerError
// =============================================================================

/**
 * Increment per-handler and total daily error counters. Fail-open.
 */
export async function recordHandlerError(
	env: MonitorWorkerEnv,
	handler: string,
	_error: unknown
): Promise<void> {
	try {
		const today = new Date().toISOString().slice(0, 10);

		// Per-handler counter
		const handlerKey = `${KV.SELF_ERROR_COUNT}${handler}:${today}`;
		const handlerCount = parseInt(await env.CF_MONITOR_KV.get(handlerKey) ?? '0', 10);
		await env.CF_MONITOR_KV.put(handlerKey, String(handlerCount + 1), { expirationTtl: TTL_48H });

		// Total daily counter
		const totalKey = `${KV.SELF_ERRORS_TOTAL}${today}`;
		const totalCount = parseInt(await env.CF_MONITOR_KV.get(totalKey) ?? '0', 10);
		await env.CF_MONITOR_KV.put(totalKey, String(totalCount + 1), { expirationTtl: TTL_48H });
	} catch (err) {
		console.warn(`[cf-monitor:self] Failed to record handler error for ${handler}: ${err}`);
	}
}

// =============================================================================
// recordSelfTelemetry
// =============================================================================

/**
 * Write a self-telemetry data point to Analytics Engine. Synchronous, fire-and-forget.
 */
export function recordSelfTelemetry(
	env: MonitorWorkerEnv,
	handlerName: string,
	durationMs: number,
	success: boolean
): void {
	try {
		const doubles = new Array(AE_FIELD_COUNT).fill(0);
		doubles[0] = 1; // invocation count

		env.CF_MONITOR_AE.writeDataPoint({
			blobs: ['cf-monitor', `self:${durationMs}:${success ? 1 : 0}`, handlerName],
			doubles,
			indexes: [`cf-monitor:self:${handlerName}`],
		});
	} catch (err) {
		console.warn(`[cf-monitor:self] Failed to write self-telemetry for ${handlerName}: ${err}`);
	}
}

// =============================================================================
// getSelfHealth
// =============================================================================

/**
 * Build a structured self-health status from KV state.
 * Reads per-handler v2 keys first, falls back to v1 blob for handlers not yet in v2.
 * First boot (no KV state) is reported as healthy with null lastRun.
 */
export async function getSelfHealth(env: MonitorWorkerEnv): Promise<SelfHealthStatus> {
	const handlers = Object.keys(CRON_HANDLER_REGISTRY);
	const today = new Date().toISOString().slice(0, 10);

	// Parallel reads: per-handler v2 keys + v1 blob fallback + error counts
	const [v2Results, v1Blob, totalRaw, ...errorResults] = await Promise.all([
		Promise.all(handlers.map((h) =>
			env.CF_MONITOR_KV.get(`${KV.SELF_CRON_HANDLER}${h}`, 'json') as Promise<CronTimestamps[string] | null>
		)),
		env.CF_MONITOR_KV.get(KV.SELF_CRON_LAST_RUN, 'json') as Promise<CronTimestamps | null>,
		env.CF_MONITOR_KV.get(`${KV.SELF_ERRORS_TOTAL}${today}`),
		...handlers.map((h) => env.CF_MONITOR_KV.get(`${KV.SELF_ERROR_COUNT}${h}:${today}`)),
	]);

	const todayErrors = parseInt(totalRaw ?? '0', 10);

	// Read per-handler error counts
	const handlerErrors: Record<string, number> = {};
	for (let i = 0; i < handlers.length; i++) {
		const raw = errorResults[i] as string | null;
		if (raw) {
			handlerErrors[handlers[i]] = parseInt(raw, 10);
		}
	}

	// Check staleness per handler — prefer v2 per-handler key, fall back to v1 blob
	const staleCrons: string[] = [];
	const crons: Record<string, { lastRun: string | null; stale: boolean }> = {};
	const now = Date.now();

	for (let i = 0; i < handlers.length; i++) {
		const handler = handlers[i];
		const config = CRON_HANDLER_REGISTRY[handler];
		const entry = v2Results[i] ?? v1Blob?.[handler] ?? null;

		if (!entry) {
			// First boot — no record yet, not considered stale
			crons[handler] = { lastRun: null, stale: false };
			continue;
		}

		const lastRunMs = new Date(entry.lastRun).getTime();
		const ageMinutes = (now - lastRunMs) / 60_000;
		const stale = ageMinutes > config.maxStaleMinutes;

		crons[handler] = { lastRun: entry.lastRun, stale };
		if (stale) {
			staleCrons.push(handler);
		}
	}

	const healthy = staleCrons.length === 0 && todayErrors < 50;

	return {
		healthy,
		staleCrons,
		todayErrors,
		handlerErrors,
		crons,
	};
}

// =============================================================================
// checkCronStaleness
// =============================================================================

/**
 * Check cron timestamps against CRON_HANDLER_REGISTRY and send Slack alert if stale.
 * Uses dynamic import for alerts/slack to avoid circular deps. Fail-open.
 */
export async function checkCronStaleness(env: MonitorWorkerEnv): Promise<void> {
	try {
		const health = await getSelfHealth(env);

		if (health.staleCrons.length === 0) return;

		const today = new Date().toISOString().slice(0, 10);
		const handlerList = health.staleCrons.join(', ');

		const { sendSlackAlert } = await import('./alerts/slack.js');

		await sendSlackAlert(
			env,
			`self:stale:${today}`,
			86400,
			{
				text: `:warning: cf-monitor self-check: stale crons detected — ${handlerList}`,
			},
		);
	} catch (err) {
		console.warn(`[cf-monitor:self] Failed to check cron staleness: ${err}`);
	}
}
