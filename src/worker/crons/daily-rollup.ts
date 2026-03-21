import type { MonitorWorkerEnv } from '../../types.js';

/**
 * Daily midnight: Housekeeping tasks.
 * - Reset daily budget counters (KV TTL handles this naturally)
 * - Log daily summary to AE
 */
export async function runDailyRollup(env: MonitorWorkerEnv): Promise<void> {
	// Daily budget counters auto-expire via KV TTL (25hr).
	// No explicit reset needed — this is the beauty of KV-only storage.

	// Write a daily marker to AE for historical tracking
	try {
		env.CF_MONITOR_AE.writeDataPoint({
			blobs: [env.ACCOUNT_NAME, 'system', 'daily-rollup'],
			doubles: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			indexes: [`${env.ACCOUNT_NAME}:system:daily-rollup`],
		});
	} catch {
		// Best-effort
	}

	console.log(`[cf-monitor:rollup] Daily rollup complete for ${env.ACCOUNT_NAME}`);
}
