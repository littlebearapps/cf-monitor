import { KV } from '../../constants.js';
import type { MonitorWorkerEnv } from '../../types.js';
import { tripFeatureCb, resetFeatureCb, checkFeatureCb } from '../../sdk/circuit-breaker.js';

const SYNTHETIC_FEATURE = 'cf-monitor:test:synthetic-cb';

/**
 * Hourly: Synthetic circuit breaker health check.
 * Verifies the CB pipeline works end-to-end:
 * 1. Trip a test CB
 * 2. Verify it reads as STOP
 * 3. Reset it
 * 4. Verify it reads as GO
 */
export async function runSyntheticHealthCheck(env: MonitorWorkerEnv): Promise<void> {
	const kv = env.CF_MONITOR_KV;

	try {
		// Step 1: Trip
		await tripFeatureCb(kv, SYNTHETIC_FEATURE, 'synthetic-test', 60);

		// Step 2: Verify STOP
		const afterTrip = await checkFeatureCb(kv, SYNTHETIC_FEATURE);
		if (afterTrip !== 'STOP') {
			console.error('[cf-monitor:health] Synthetic CB trip failed — KV.get returned GO after put(STOP)');
			return;
		}

		// Step 3: Reset
		await resetFeatureCb(kv, SYNTHETIC_FEATURE);

		// Step 4: Verify GO
		const afterReset = await checkFeatureCb(kv, SYNTHETIC_FEATURE);
		if (afterReset !== 'GO') {
			console.error('[cf-monitor:health] Synthetic CB reset failed — KV.get returned STOP after delete');
			return;
		}

		console.log('[cf-monitor:health] Synthetic CB health check passed');
	} catch (err) {
		console.error(`[cf-monitor:health] Synthetic CB check error: ${err}`);
		// Cleanup
		try {
			await resetFeatureCb(kv, SYNTHETIC_FEATURE);
		} catch {
			// Best effort
		}
	}
}
