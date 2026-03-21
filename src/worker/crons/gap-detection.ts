import { KV } from '../../constants.js';
import type { MonitorWorkerEnv } from '../../types.js';
import { sendSlackAlert } from '../alerts/slack.js';

/**
 * Every 15 minutes: Detect gaps in monitoring coverage.
 * Checks which discovered workers have sent telemetry recently.
 */
export async function detectGaps(env: MonitorWorkerEnv): Promise<void> {
	const workerListRaw = await env.CF_MONITOR_KV.get(KV.WORKER_LIST);
	if (!workerListRaw) return; // No workers discovered yet

	const workers = JSON.parse(workerListRaw) as string[];
	if (workers.length === 0) return;

	// TODO: Query AE for recent telemetry per worker
	// For now, use KV presence check — workers writing to AE also update
	// their last-seen timestamp in KV (written by the SDK flush)
	const today = new Date().toISOString().slice(0, 10);
	const gapWorkers: string[] = [];

	for (const worker of workers) {
		// Skip cf-monitor itself
		if (worker === 'cf-monitor') continue;

		// Check if we've seen telemetry from this worker in the last hour
		const lastSeen = await env.CF_MONITOR_KV.get(`${KV.WORKER_REGISTRY}${worker}:last_seen`);
		if (!lastSeen) {
			gapWorkers.push(worker);
			continue;
		}

		const lastSeenTime = new Date(lastSeen).getTime();
		const oneHourAgo = Date.now() - 3_600_000;
		if (lastSeenTime < oneHourAgo) {
			gapWorkers.push(worker);
		}
	}

	if (gapWorkers.length === 0) return;

	// Dedup: one alert per day
	const dedupKey = `gap:${today}`;
	await sendSlackAlert(env, dedupKey, 86400, {
		blocks: [
			{
				type: 'header',
				text: { type: 'plain_text', text: `:warning: Monitoring Gap: ${env.ACCOUNT_NAME}` },
			},
			{
				type: 'section',
				text: {
					type: 'mrkdwn',
					text: `${gapWorkers.length} worker(s) have not sent telemetry in the last hour:\n${gapWorkers.map((w) => `• \`${w}\``).join('\n')}`,
				},
			},
		],
	});
}
