/**
 * Analytics Engine SQL API client.
 * Reusable utility for querying the cf-monitor AE dataset.
 *
 * AE SQL API: GET https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql
 */

export interface AEQueryResult {
	data: Record<string, unknown>[];
	meta: { name: string; type: string }[];
	rows: number;
}

/**
 * Query the Analytics Engine SQL API.
 *
 * @param accountId - Cloudflare account ID
 * @param apiToken - Cloudflare API token with AE read permissions
 * @param sql - SQL query (dataset name must be quoted: "cf-monitor")
 * @returns Parsed query result rows
 */
export async function queryAE(
	accountId: string,
	apiToken: string,
	sql: string
): Promise<AEQueryResult> {
	const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiToken}`,
			'Content-Type': 'text/plain',
		},
		body: sql,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`AE SQL query failed (${response.status}): ${text}`);
	}

	const result = await response.json() as {
		data: Record<string, unknown>[];
		meta: { name: string; type: string }[];
		rows: number;
	};

	return result;
}

/**
 * Query AE for workers that have sent telemetry recently.
 * Returns a set of worker names with telemetry in the given interval.
 */
export async function getActiveWorkers(
	accountId: string,
	apiToken: string,
	intervalMinutes: number = 60
): Promise<Map<string, number>> {
	const sql = `
		SELECT blob1 AS worker_name, count() AS invocations
		FROM "cf-monitor"
		WHERE timestamp > NOW() - INTERVAL '${intervalMinutes}' MINUTE
		GROUP BY worker_name
	`;

	const result = await queryAE(accountId, apiToken, sql);
	const activeWorkers = new Map<string, number>();

	for (const row of result.data) {
		const name = row.worker_name as string;
		const count = Number(row.invocations);
		if (name) activeWorkers.set(name, count);
	}

	return activeWorkers;
}
