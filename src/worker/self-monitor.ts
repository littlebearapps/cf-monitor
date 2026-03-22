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
 * Read-merge-write a single JSON blob. Fail-open.
 */
export async function recordCronExecution(
	env: MonitorWorkerEnv,
	handler: string,
	durationMs: number,
	success: boolean
): Promise<void> {
	try {
		const existing = await env.CF_MONITOR_KV.get(KV.SELF_CRON_LAST_RUN, 'json') as CronTimestamps | null;
		const blob: CronTimestamps = existing ?? {};

		blob[handler] = {
			lastRun: new Date().toISOString(),
			durationMs,
			success,
		};

		await env.CF_MONITOR_KV.put(
			KV.SELF_CRON_LAST_RUN,
			JSON.stringify(blob),
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
 * First boot (no KV state) is reported as healthy with null lastRun.
 */
export async function getSelfHealth(env: MonitorWorkerEnv): Promise<SelfHealthStatus> {
	const cronBlob = await env.CF_MONITOR_KV.get(KV.SELF_CRON_LAST_RUN, 'json') as CronTimestamps | null;
	const today = new Date().toISOString().slice(0, 10);

	// Read total daily errors
	const totalRaw = await env.CF_MONITOR_KV.get(`${KV.SELF_ERRORS_TOTAL}${today}`);
	const todayErrors = parseInt(totalRaw ?? '0', 10);

	// Read per-handler error counts
	const handlerErrors: Record<string, number> = {};
	for (const handler of Object.keys(CRON_HANDLER_REGISTRY)) {
		const raw = await env.CF_MONITOR_KV.get(`${KV.SELF_ERROR_COUNT}${handler}:${today}`);
		if (raw) {
			handlerErrors[handler] = parseInt(raw, 10);
		}
	}

	// Check staleness per handler
	const staleCrons: string[] = [];
	const crons: Record<string, { lastRun: string | null; stale: boolean }> = {};
	const now = Date.now();

	for (const [handler, config] of Object.entries(CRON_HANDLER_REGISTRY)) {
		const entry = cronBlob?.[handler];

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
