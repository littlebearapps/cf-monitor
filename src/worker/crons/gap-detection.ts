import { KV } from '../../constants.js';
import type { MonitorWorkerEnv } from '../../types.js';
import { sendSlackAlert } from '../alerts/slack.js';
import { getActiveWorkers } from '../ae-client.js';

/**
 * Every 15 minutes: Detect gaps in monitoring coverage.
 * Primary: Query AE for recent telemetry per worker.
 * Fallback: KV last_seen timestamps (if AE query fails or no API token).
 */
export async function detectGaps(env: MonitorWorkerEnv): Promise<void> {
	const workerListRaw = await env.CF_MONITOR_KV.get(KV.WORKER_LIST);
	if (!workerListRaw) return; // No workers discovered yet

	const workers = JSON.parse(workerListRaw) as string[];
	if (workers.length === 0) return;

	// Try AE-based detection first, fall back to KV
	let gapWorkers: string[];
	if (env.CLOUDFLARE_API_TOKEN && env.CF_ACCOUNT_ID) {
		gapWorkers = await detectGapsFromAE(env, workers);
	} else {
		gapWorkers = await detectGapsFromKV(env, workers);
	}

	if (gapWorkers.length === 0) return;

	const today = new Date().toISOString().slice(0, 10);
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

/** Primary: detect gaps using AE SQL query with KV fallback. */
async function detectGapsFromAE(
	env: MonitorWorkerEnv,
	workers: string[]
): Promise<string[]> {
	try {
		const activeWorkers = await getActiveWorkers(env.CF_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN!, 60);
		const gapWorkers: string[] = [];

		for (const worker of workers) {
			if (worker === 'cf-monitor') continue;
			if (!activeWorkers.has(worker)) {
				gapWorkers.push(worker);
			}
		}

		return gapWorkers;
	} catch (err) {
		console.warn(`[cf-monitor:gaps] AE query failed, falling back to KV: ${err}`);
		return detectGapsFromKV(env, workers);
	}
}

/** Fallback: detect gaps using KV last_seen timestamps. */
async function detectGapsFromKV(
	env: MonitorWorkerEnv,
	workers: string[]
): Promise<string[]> {
	const gapWorkers: string[] = [];
	const oneHourAgo = Date.now() - 3_600_000;

	for (const worker of workers) {
		if (worker === 'cf-monitor') continue;

		const lastSeen = await env.CF_MONITOR_KV.get(`${KV.WORKER_REGISTRY}${worker}:last_seen`);
		if (!lastSeen) {
			gapWorkers.push(worker);
			continue;
		}

		const lastSeenTime = new Date(lastSeen).getTime();
		if (lastSeenTime < oneHourAgo) {
			gapWorkers.push(worker);
		}
	}

	return gapWorkers;
}
