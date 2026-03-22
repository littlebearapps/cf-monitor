import { describe, it, expect, vi, beforeEach } from 'vitest';
import { collectAccountUsage } from '../../../src/worker/crons/collect-account-usage.js';
import type { MonitorWorkerEnv } from '../../../src/types.js';
import { KV } from '../../../src/constants.js';

function mockEnv(overrides?: Partial<MonitorWorkerEnv>): MonitorWorkerEnv {
	const store = new Map<string, string>();
	return {
		CF_MONITOR_KV: {
			get: vi.fn(async (key: string) => store.get(key) ?? null),
			put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
			delete: vi.fn(),
			list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
			getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
		} as unknown as KVNamespace,
		CF_MONITOR_AE: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
		CF_ACCOUNT_ID: 'test-account-id',
		ACCOUNT_NAME: 'test-account',
		CLOUDFLARE_API_TOKEN: 'test-token',
		...overrides,
	};
}

function graphqlResponse(data: Record<string, unknown>) {
	return Response.json({ data: { viewer: { accounts: [data] } } });
}

describe('collectAccountUsage', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('skips when no API token', async () => {
		const env = mockEnv({ CLOUDFLARE_API_TOKEN: undefined });
		await collectAccountUsage(env);
		expect(env.CF_MONITOR_KV.put).not.toHaveBeenCalled();
	});

	it('stores daily usage snapshot in KV', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch')
			// Core services query
			.mockResolvedValueOnce(graphqlResponse({
				workersInvocationsAdaptive: [{ sum: { requests: 1000, wallTime: 5000 } }],
				d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 50000, rowsWritten: 1000 } }],
				kvOperationsAdaptiveGroups: [{ sum: { readOperations: 3000, writeOperations: 100, listOperations: 5, deleteOperations: 2 } }],
				r2OperationsAdaptiveGroups: [],
			}))
			// Extra services query (Durable Objects only)
			.mockResolvedValueOnce(graphqlResponse({
				durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 200 } }],
			}));

		await collectAccountUsage(env);

		expect(env.CF_MONITOR_KV.put).toHaveBeenCalledWith(
			expect.stringMatching(/^usage:account:\d{4}-\d{2}-\d{2}$/),
			expect.any(String),
			expect.objectContaining({ expirationTtl: 2_764_800 })
		);

		// Verify snapshot content
		const putCall = (env.CF_MONITOR_KV.put as ReturnType<typeof vi.fn>).mock.calls[0];
		const snapshot = JSON.parse(putCall[1]);
		expect(snapshot.disclaimer).toContain('Not authoritative');
		expect(snapshot.services.workers).toEqual({ requests: 1000, cpuMs: 5000 });
		expect(snapshot.services.d1).toEqual({ rowsRead: 50000, rowsWritten: 1000 });
		expect(snapshot.services.kv).toEqual({ reads: 3000, writes: 100, deletes: 2, lists: 5 });
		expect(snapshot.services.durableObjects).toEqual({ requests: 200, storedBytes: 0 });
	});

	it('handles partial GraphQL failures gracefully', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch')
			// Core services succeed
			.mockResolvedValueOnce(graphqlResponse({
				workersInvocationsAdaptive: [{ sum: { requests: 500, wallTime: 1000 } }],
			}))
			// Extra services fail
			.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

		await collectAccountUsage(env);

		// Should still store partial results
		expect(env.CF_MONITOR_KV.put).toHaveBeenCalled();
		const putCall = (env.CF_MONITOR_KV.put as ReturnType<typeof vi.fn>).mock.calls[0];
		const snapshot = JSON.parse(putCall[1]);
		expect(snapshot.services.workers).toEqual({ requests: 500, cpuMs: 1000 });
	});

	it('handles empty results for unused services', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(graphqlResponse({}))
			.mockResolvedValueOnce(graphqlResponse({}));

		await collectAccountUsage(env);

		expect(env.CF_MONITOR_KV.put).toHaveBeenCalled();
		const putCall = (env.CF_MONITOR_KV.put as ReturnType<typeof vi.fn>).mock.calls[0];
		const snapshot = JSON.parse(putCall[1]);
		expect(Object.keys(snapshot.services)).toHaveLength(0);
	});

	it('aggregates multiple entries per service', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(graphqlResponse({
				workersInvocationsAdaptive: [
					{ sum: { requests: 300, wallTime: 1000 } },
					{ sum: { requests: 700, wallTime: 2000 } },
				],
			}))
			.mockResolvedValueOnce(graphqlResponse({}));

		await collectAccountUsage(env);

		const putCall = (env.CF_MONITOR_KV.put as ReturnType<typeof vi.fn>).mock.calls[0];
		const snapshot = JSON.parse(putCall[1]);
		expect(snapshot.services.workers).toEqual({ requests: 1000, cpuMs: 3000 });
	});
});
