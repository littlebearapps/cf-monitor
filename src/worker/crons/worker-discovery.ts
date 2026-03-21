import { KV } from '../../constants.js';
import type { MonitorWorkerEnv } from '../../types.js';

/**
 * Daily: Discover all workers on the CF account via API.
 * Stores the worker list in KV for gap detection and status API.
 */
export async function discoverWorkers(env: MonitorWorkerEnv): Promise<void> {
	if (!env.CLOUDFLARE_API_TOKEN || !env.CF_ACCOUNT_ID) {
		console.warn('[cf-monitor:discovery] No CLOUDFLARE_API_TOKEN or CF_ACCOUNT_ID');
		return;
	}

	try {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts`,
			{
				headers: {
					Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
					'Content-Type': 'application/json',
				},
			}
		);

		if (!response.ok) {
			console.error(`[cf-monitor:discovery] API error (${response.status})`);
			return;
		}

		const data = await response.json() as {
			success: boolean;
			result: Array<{ id: string; modified_on: string }>;
		};

		if (!data.success || !data.result) return;

		const workerNames = data.result.map((w) => w.id);

		// Store worker list
		await env.CF_MONITOR_KV.put(KV.WORKER_LIST, JSON.stringify(workerNames), {
			expirationTtl: 90000, // 25hr
		});

		// Store individual worker metadata
		for (const worker of data.result) {
			await env.CF_MONITOR_KV.put(
				`${KV.WORKER_REGISTRY}${worker.id}`,
				JSON.stringify({ name: worker.id, modified: worker.modified_on, discovered: new Date().toISOString() }),
				{ expirationTtl: 90000 }
			);
		}

		console.log(`[cf-monitor:discovery] Found ${workerNames.length} workers`);
	} catch (err) {
		console.error(`[cf-monitor:discovery] Failed: ${err}`);
	}
}
