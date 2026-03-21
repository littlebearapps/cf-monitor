import type { MonitorWorkerEnv } from '../types.js';
import { collectAccountMetrics } from './crons/collect-metrics.js';
import { checkBudgets } from './crons/budget-check.js';
import { detectGaps } from './crons/gap-detection.js';
import { discoverWorkers } from './crons/worker-discovery.js';
import { runDailyRollup } from './crons/daily-rollup.js';
import { runSyntheticHealthCheck } from './crons/synthetic-health.js';

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

	try {
		// 15-minute checks
		if (cron === '*/15 * * * *') {
			await detectGaps(env);
			return;
		}

		// Hourly checks
		if (cron === '0 * * * *') {
			await Promise.allSettled([
				collectAccountMetrics(env),
				checkBudgets(env),
				runSyntheticHealthCheck(env),
			]);
			return;
		}

		// Daily midnight
		if (cron === '0 0 * * *') {
			await Promise.allSettled([
				runDailyRollup(env),
				discoverWorkers(env),
			]);
			return;
		}

		console.warn(`[cf-monitor:scheduled] Unhandled cron: ${cron}`);
	} catch (err) {
		console.error(`[cf-monitor:scheduled] Cron ${cron} failed: ${err}`);
	}

	// Heartbeat ping (if configured)
	if (env.GATUS_HEARTBEAT_URL && env.GATUS_TOKEN) {
		ctx.waitUntil(
			fetch(`${env.GATUS_HEARTBEAT_URL}?success=true`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${env.GATUS_TOKEN}` },
			}).catch(() => {})
		);
	}
}
