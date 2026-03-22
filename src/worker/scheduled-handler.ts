import type { MonitorWorkerEnv } from '../types.js';
import { recordCronExecution, recordHandlerError, recordSelfTelemetry, checkCronStaleness } from './self-monitor.js';
import { collectAccountMetrics } from './crons/collect-metrics.js';
import { collectAccountUsage } from './crons/collect-account-usage.js';
import { checkBudgets } from './crons/budget-check.js';
import { detectGaps } from './crons/gap-detection.js';
import { detectCostSpikes } from './crons/cost-spike.js';
import { discoverWorkers } from './crons/worker-discovery.js';
import { runDailyRollup } from './crons/daily-rollup.js';
import { runSyntheticHealthCheck } from './crons/synthetic-health.js';

/** Execute a cron handler with self-monitoring recording. */
async function runAndRecord(
	env: MonitorWorkerEnv,
	name: string,
	handler: () => Promise<void>
): Promise<void> {
	const start = Date.now();
	let ok = true;
	try {
		await handler();
	} catch (err) {
		ok = false;
		try { await recordHandlerError(env, name, err); } catch {}
		throw err;
	} finally {
		const durationMs = Date.now() - start;
		recordSelfTelemetry(env, name, durationMs, ok);
		try { await recordCronExecution(env, name, durationMs, ok); } catch {}
	}
}

/**
 * Cron multiplexer — dispatches to the appropriate handler based on the cron expression.
 *
 * Schedule:
 * - *\/15 * * * *  → gap detection, cost spike check
 * - 0 * * * *     → hourly metrics + budgets + synthetic health
 * - 0 0 * * *     → daily rollup + worker discovery
 */
export async function handleScheduled(
	controller: ScheduledController,
	env: MonitorWorkerEnv,
	ctx: ExecutionContext
): Promise<void> {
	const cron = controller.cron;
	let success = true;

	try {
		// 15-minute checks
		if (cron === '*/15 * * * *') {
			const results = await Promise.allSettled([
				runAndRecord(env, 'gap-detection', () => detectGaps(env)),
				runAndRecord(env, 'cost-spike', () => detectCostSpikes(env)),
			]);
			success = results.every((r) => r.status === 'fulfilled');
			// Staleness check piggybacked on 15-min cron
			ctx.waitUntil(checkCronStaleness(env));
		}
		// Hourly checks
		else if (cron === '0 * * * *') {
			const results = await Promise.allSettled([
				runAndRecord(env, 'collect-metrics', () => collectAccountMetrics(env)),
				runAndRecord(env, 'collect-account-usage', () => collectAccountUsage(env)),
				runAndRecord(env, 'budget-check', () => checkBudgets(env)),
				runAndRecord(env, 'synthetic-health', () => runSyntheticHealthCheck(env)),
			]);
			success = results.every((r) => r.status === 'fulfilled');
		}
		// Daily midnight
		else if (cron === '0 0 * * *') {
			const results = await Promise.allSettled([
				runAndRecord(env, 'daily-rollup', () => runDailyRollup(env)),
				runAndRecord(env, 'worker-discovery', () => discoverWorkers(env)),
			]);
			success = results.every((r) => r.status === 'fulfilled');
		}
		else {
			console.warn(`[cf-monitor:scheduled] Unhandled cron: ${cron}`);
			success = false;
		}
	} catch (err) {
		console.error(`[cf-monitor:scheduled] Cron ${cron} failed: ${err}`);
		success = false;
	}

	// Heartbeat ping (if configured) — always runs after cron dispatch
	if (env.GATUS_HEARTBEAT_URL && env.GATUS_TOKEN) {
		ctx.waitUntil(
			fetch(`${env.GATUS_HEARTBEAT_URL}?success=${success}`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${env.GATUS_TOKEN}` },
			}).catch(() => {})
		);
	}
}
