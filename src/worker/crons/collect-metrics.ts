import type { MonitorWorkerEnv } from '../../types.js';

/**
 * Hourly: Collect account-level metrics from Cloudflare GraphQL Analytics API.
 * Writes to Analytics Engine for time-series storage.
 */
/** Validate account ID format to prevent GraphQL injection. */
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;

export async function collectAccountMetrics(env: MonitorWorkerEnv): Promise<void> {
	if (!env.CLOUDFLARE_API_TOKEN || !env.CF_ACCOUNT_ID) {
		console.warn('[cf-monitor:collect] No CLOUDFLARE_API_TOKEN or CF_ACCOUNT_ID configured');
		return;
	}

	if (!ACCOUNT_ID_RE.test(env.CF_ACCOUNT_ID)) {
		console.error('[cf-monitor:collect] Invalid CF_ACCOUNT_ID format — must be 32-char hex');
		return;
	}

	const now = new Date();
	const hourAgo = new Date(now.getTime() - 3_600_000);

	try {
		const query = buildGraphQLQuery(env.CF_ACCOUNT_ID, hourAgo, now);
		const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ query }),
		});

		if (!response.ok) {
			const text = await response.text();
			console.error(`[cf-monitor:collect] GraphQL error (${response.status}): ${text.slice(0, 200)}`);
			return;
		}

		const data = await response.json() as GraphQLResponse;
		if (data.errors?.length) {
			console.error(`[cf-monitor:collect] GraphQL errors: ${JSON.stringify(data.errors[0])}`);
			return;
		}

		// Write metrics to AE
		writeMetricsToAE(env, data);
	} catch (err) {
		console.error(`[cf-monitor:collect] Failed: ${err}`);
	}
}

// =============================================================================
// GRAPHQL
// =============================================================================

function buildGraphQLQuery(accountId: string, start: Date, end: Date): string {
	const startStr = start.toISOString();
	const endStr = end.toISOString();
	const startDate = start.toISOString().slice(0, 10);
	const endDate = end.toISOString().slice(0, 10);

	return `{
  viewer {
    accounts(filter: { accountTag: "${accountId}" }) {
      workersInvocationsAdaptive(
        filter: {
          datetime_geq: "${startStr}"
          datetime_lt: "${endStr}"
        }
        limit: 1000
        orderBy: [sum_requests_DESC]
      ) {
        dimensions {
          scriptName
        }
        sum {
          requests
          errors
          subrequests
          wallTime
        }
      }
      d1AnalyticsAdaptiveGroups(
        filter: {
          date_geq: "${startDate}"
          date_leq: "${endDate}"
        }
        limit: 100
      ) {
        sum {
          readQueries
          writeQueries
          rowsRead
          rowsWritten
        }
      }
      kvOperationsAdaptiveGroups(
        filter: {
          datetime_geq: "${startStr}"
          datetime_lt: "${endStr}"
        }
        limit: 1000
      ) {
        dimensions {
          actionType
        }
        sum {
          requests
        }
      }
    }
  }
}`;
}

interface GraphQLResponse {
	data?: {
		viewer: {
			accounts: Array<{
				workersInvocationsAdaptive?: Array<{
					dimensions: { scriptName: string };
					sum: { requests: number; errors: number; subrequests: number; wallTime: number };
				}>;
				d1AnalyticsAdaptiveGroups?: Array<{
					sum: { readQueries: number; writeQueries: number; rowsRead: number; rowsWritten: number };
				}>;
				kvOperationsAdaptiveGroups?: Array<{
					dimensions?: { actionType?: string };
					sum: { requests: number };
				}>;
			}>;
		};
	};
	errors?: Array<{ message: string }>;
}

function writeMetricsToAE(env: MonitorWorkerEnv, data: GraphQLResponse): void {
	const accounts = data.data?.viewer?.accounts;
	if (!accounts?.length) return;

	const account = accounts[0];

	// Worker invocation metrics
	for (const worker of account.workersInvocationsAdaptive ?? []) {
		env.CF_MONITOR_AE.writeDataPoint({
			blobs: [worker.dimensions.scriptName, 'graphql', 'workers'],
			doubles: [
				0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
				worker.sum.requests, worker.sum.wallTime,
				0, 0, 0, 0, 0, 0, 0, 0,
			],
			indexes: [`${worker.dimensions.scriptName}:graphql:workers`],
		});
	}

	// D1 metrics (account-level aggregate)
	for (const d1 of account.d1AnalyticsAdaptiveGroups ?? []) {
		env.CF_MONITOR_AE.writeDataPoint({
			blobs: [env.ACCOUNT_NAME, 'graphql', 'd1'],
			doubles: [
				d1.sum.writeQueries, d1.sum.readQueries,
				0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
				d1.sum.rowsRead, d1.sum.rowsWritten,
				0, 0, 0, 0, 0, 0,
			],
			indexes: [`${env.ACCOUNT_NAME}:graphql:d1`],
		});
	}

	// KV metrics — aggregate by actionType
	let kvReads = 0, kvWrites = 0, kvDeletes = 0, kvLists = 0;
	for (const kv of account.kvOperationsAdaptiveGroups ?? []) {
		const action = kv.dimensions?.actionType ?? '';
		const count = kv.sum?.requests ?? 0;
		if (action === 'read') kvReads += count;
		else if (action === 'write') kvWrites += count;
		else if (action === 'delete') kvDeletes += count;
		else if (action === 'list') kvLists += count;
	}
	if (kvReads || kvWrites || kvDeletes || kvLists) {
		env.CF_MONITOR_AE.writeDataPoint({
			blobs: [env.ACCOUNT_NAME, 'graphql', 'kv'],
			doubles: [
				0, 0,
				kvReads, kvWrites,
				0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
				kvDeletes, kvLists,
				0, 0, 0, 0,
			],
			indexes: [`${env.ACCOUNT_NAME}:graphql:kv`],
		});
	}
}
