import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverVectorizeIndexes } from '../../../src/worker/crons/discover-vectorize-indexes.js';
import type { MonitorWorkerEnv, VectorizeDiscoverySnapshot } from '../../../src/types.js';
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
		CF_ACCOUNT_ID: 'aabbccdd11223344aabbccdd11223344',
		ACCOUNT_NAME: 'test-account',
		CLOUDFLARE_API_TOKEN: 'test-token',
		...overrides,
	};
}

function listResp(indexes: Array<Record<string, unknown>>): Response {
	return Response.json({ success: true, result: indexes });
}

function readSnapshot(env: MonitorWorkerEnv): VectorizeDiscoverySnapshot | null {
	const putMock = env.CF_MONITOR_KV.put as ReturnType<typeof vi.fn>;
	const call = putMock.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).startsWith(KV.USAGE_VECTORIZE_DISCOVERY));
	return call ? JSON.parse(call[1] as string) as VectorizeDiscoverySnapshot : null;
}

describe('discoverVectorizeIndexes', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('skips when no API token', async () => {
		const env = mockEnv({ CLOUDFLARE_API_TOKEN: undefined });
		await discoverVectorizeIndexes(env);
		expect(env.CF_MONITOR_KV.put).not.toHaveBeenCalled();
	});

	it('writes an empty snapshot when no indexes exist', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(listResp([]));
		await discoverVectorizeIndexes(env);
		const snap = readSnapshot(env)!;
		expect(snap.indexes).toEqual([]);
		expect(snap.partial).toBe(false);
		expect(snap.confidence).toBe('runtime_metered');
		expect(snap.caveat).toContain('vector counts not collected');
	});

	it('captures index metadata (V2 schema with config.{dimensions,metric})', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(listResp([
			{
				name: 'embeddings',
				description: 'product embeddings',
				config: { dimensions: 1536, metric: 'cosine' },
				created_on: '2025-09-01T00:00:00Z',
				modified_on: '2026-05-01T00:00:00Z',
			},
		]));
		await discoverVectorizeIndexes(env);
		const snap = readSnapshot(env)!;
		expect(snap.indexes).toHaveLength(1);
		expect(snap.indexes[0]).toMatchObject({
			name: 'embeddings',
			dimensions: 1536,
			metric: 'cosine',
			description: 'product embeddings',
		});
	});

	it('captures index metadata (V1 flat schema fallback)', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(listResp([
			{ name: 'legacy-idx', dimensions: 768, metric: 'euclidean' },
		]));
		await discoverVectorizeIndexes(env);
		const snap = readSnapshot(env)!;
		expect(snap.indexes[0]).toMatchObject({
			name: 'legacy-idx',
			dimensions: 768,
			metric: 'euclidean',
		});
	});

	it('always sets partial:false and includes the documented caveat', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(listResp([{ name: 'a' }]));
		await discoverVectorizeIndexes(env);
		const snap = readSnapshot(env)!;
		expect(snap.partial).toBe(false);
		expect(snap.caveat).toMatch(/vector counts not collected/i);
	});

	it('skips writing on 403 (permission denied)', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
		await discoverVectorizeIndexes(env);
		expect(env.CF_MONITOR_KV.put).not.toHaveBeenCalled();
	});
});
