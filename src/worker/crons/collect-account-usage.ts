import { KV } from '../../constants.js';
import type { MonitorWorkerEnv, ServiceUsageSnapshot } from '../../types.js';

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const USAGE_DISCLAIMER = 'Approximate — from CF GraphQL Analytics API. Not authoritative for billing.';

/**
 * Hourly: Collect account-wide usage per CF service via GraphQL Analytics API.
 * Stores a daily snapshot in KV for the /usage endpoint.
 *
 * Services with GraphQL datasets: Workers, D1, KV, R2, Durable Objects.
 *
 * NOT available in GraphQL: AI Gateway, Vectorize, Queues, Workflows, Hyperdrive.
 * These services use REST APIs or dashboard-only metrics — may be added later.
 */
export async function collectAccountUsage(env: MonitorWorkerEnv): Promise<void> {
	if (!env.CLOUDFLARE_API_TOKEN || !env.CF_ACCOUNT_ID) {
		console.warn('[cf-monitor:usage] No CLOUDFLARE_API_TOKEN or CF_ACCOUNT_ID — skipping usage collection');
		return;
	}

	const now = new Date();
	const today = now.toISOString().slice(0, 10);

	// Query period: last 24 hours for daily accumulation
	const dayAgo = new Date(now.getTime() - 86_400_000);

	// Batch queries into 2 GraphQL requests to stay well under rate limits (25/5min)
	const [coreServices, extraServices] = await Promise.all([
		queryCoreServices(env, dayAgo, now),
		queryExtraServices(env, dayAgo, now),
	]);

	const snapshot: ServiceUsageSnapshot = {
		collected_at: now.toISOString(),
		disclaimer: USAGE_DISCLAIMER,
		services: {
			...coreServices,
			...extraServices,
		},
	};

	// Store daily snapshot (32-day TTL for billing period lookback)
	await env.CF_MONITOR_KV.put(
		`${KV.USAGE_ACCOUNT}${today}`,
		JSON.stringify(snapshot),
		{ expirationTtl: 2_764_800 }
	);

	const serviceCount = Object.keys(snapshot.services).length;
	console.log(`[cf-monitor:usage] Collected usage for ${serviceCount} services (${today})`);
}

// =============================================================================
// CORE SERVICES: Workers, D1, KV, R2
// =============================================================================

async function queryCoreServices(
	env: MonitorWorkerEnv,
	start: Date,
	end: Date
): Promise<ServiceUsageSnapshot['services']> {
	const startStr = start.toISOString();
	const endStr = end.toISOString();

	const query = `{
  viewer {
    accounts(filter: { accountTag: "${env.CF_ACCOUNT_ID}" }) {
      workersInvocationsAdaptive(
        filter: { datetime_geq: "${startStr}", datetime_lt: "${endStr}" }
        limit: 1000
      ) {
        sum { requests wallTime }
      }
      d1AnalyticsAdaptiveGroups(
        filter: { datetime_geq: "${startStr}", datetime_lt: "${endStr}" }
        limit: 100
      ) {
        sum { rowsRead rowsWritten }
      }
      kvOperationsAdaptiveGroups(
        filter: { datetime_geq: "${startStr}", datetime_lt: "${endStr}" }
        limit: 100
      ) {
        sum { readOperations writeOperations listOperations deleteOperations }
      }
      r2OperationsAdaptiveGroups(
        filter: { datetime_geq: "${startStr}", datetime_lt: "${endStr}" }
        limit: 100
      ) {
        dimensions { actionType }
        sum { requests }
      }
    }
  }
}`;

	const result = await executeGraphQL(env, query);
	if (!result) return {};

	const account = result.data?.viewer?.accounts?.[0];
	if (!account) {
		console.warn('[cf-monitor:usage] No account data in core GraphQL response');
		return {};
	}

	const services: ServiceUsageSnapshot['services'] = {};

	// Workers
	try {
		const workers = account.workersInvocationsAdaptive;
		if (workers?.length) {
			let totalRequests = 0;
			let totalCpuMs = 0;
			for (const w of workers) {
				totalRequests += w.sum?.requests ?? 0;
				totalCpuMs += w.sum?.wallTime ?? 0;
			}
			services.workers = { requests: totalRequests, cpuMs: totalCpuMs };
		}
	} catch { /* service unavailable — skip */ }

	// D1
	try {
		const d1 = account.d1AnalyticsAdaptiveGroups;
		if (d1?.length) {
			let rowsRead = 0;
			let rowsWritten = 0;
			for (const entry of d1) {
				rowsRead += entry.sum?.rowsRead ?? 0;
				rowsWritten += entry.sum?.rowsWritten ?? 0;
			}
			services.d1 = { rowsRead, rowsWritten };
		}
	} catch { /* skip */ }

	// KV
	try {
		const kv = account.kvOperationsAdaptiveGroups;
		if (kv?.length) {
			let reads = 0;
			let writes = 0;
			let deletes = 0;
			let lists = 0;
			for (const entry of kv) {
				reads += entry.sum?.readOperations ?? 0;
				writes += entry.sum?.writeOperations ?? 0;
				deletes += entry.sum?.deleteOperations ?? 0;
				lists += entry.sum?.listOperations ?? 0;
			}
			services.kv = { reads, writes, deletes, lists };
		}
	} catch { /* skip */ }

	// R2
	try {
		const r2 = account.r2OperationsAdaptiveGroups;
		if (r2?.length) {
			let classA = 0;
			let classB = 0;
			for (const entry of r2) {
				const action = entry.dimensions?.actionType ?? '';
				const count = entry.sum?.requests ?? 0;
				// Class A: ListBuckets, PutObject, CopyObject, CreateMultipartUpload, etc.
				// Class B: GetObject, HeadObject
				if (['GetObject', 'HeadObject', 'ListBucket'].includes(action)) {
					classB += count;
				} else {
					classA += count;
				}
			}
			services.r2 = { classA, classB };
		}
	} catch { /* skip */ }

	return services;
}

// =============================================================================
// EXTRA SERVICES: AI, AI Gateway, Durable Objects, Vectorize, Queues
// =============================================================================

async function queryExtraServices(
	env: MonitorWorkerEnv,
	start: Date,
	end: Date
): Promise<ServiceUsageSnapshot['services']> {
	const startStr = start.toISOString();
	const endStr = end.toISOString();

	// Only Durable Objects has a GraphQL Analytics dataset.
	// AI Gateway, Vectorize, and Queues do NOT have GraphQL datasets —
	// they use REST APIs or dashboard-only metrics.
	const query = `{
  viewer {
    accounts(filter: { accountTag: "${env.CF_ACCOUNT_ID}" }) {
      durableObjectsInvocationsAdaptiveGroups(
        filter: { datetime_geq: "${startStr}", datetime_lt: "${endStr}" }
        limit: 100
      ) {
        sum { requests }
      }
    }
  }
}`;

	const result = await executeGraphQL(env, query);
	if (!result) return {};

	const account = result.data?.viewer?.accounts?.[0];
	if (!account) return {};

	const services: ServiceUsageSnapshot['services'] = {};

	// Durable Objects
	try {
		const doData = account.durableObjectsInvocationsAdaptiveGroups;
		if (doData?.length) {
			let totalRequests = 0;
			for (const entry of doData) {
				totalRequests += entry.sum?.requests ?? 0;
			}
			if (totalRequests > 0) {
				services.durableObjects = { requests: totalRequests, storedBytes: 0 };
			}
		}
	} catch { /* skip */ }

	return services;
}

// =============================================================================
// GRAPHQL EXECUTOR
// =============================================================================

/* eslint-disable @typescript-eslint/no-explicit-any */
async function executeGraphQL(env: MonitorWorkerEnv, query: string): Promise<any | null> {
	try {
		const response = await fetch(GRAPHQL_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ query }),
		});

		if (!response.ok) {
			const text = await response.text();
			console.error(`[cf-monitor:usage] GraphQL error (${response.status}): ${text.slice(0, 200)}`);
			return null;
		}

		const data = await response.json();
		if ((data as any).errors?.length) {
			console.warn(`[cf-monitor:usage] GraphQL errors: ${JSON.stringify((data as any).errors[0])}`);
			// Partial results may still be usable — return data
		}

		return data;
	} catch (err) {
		console.error(`[cf-monitor:usage] GraphQL request failed: ${err}`);
		return null;
	}
}
/* eslint-enable @typescript-eslint/no-explicit-any */
