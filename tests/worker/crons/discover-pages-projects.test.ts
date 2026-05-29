import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverPagesProjects } from '../../../src/worker/crons/discover-pages-projects.js';
import type { MonitorWorkerEnv, PagesDiscoverySnapshot } from '../../../src/types.js';
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

function listResp(projects: Array<Record<string, unknown>>, totalCount?: number): Response {
	return Response.json({
		success: true,
		result: projects,
		result_info: { total_count: totalCount ?? projects.length },
	});
}

function readSnapshot(env: MonitorWorkerEnv): PagesDiscoverySnapshot | null {
	const putMock = env.CF_MONITOR_KV.put as ReturnType<typeof vi.fn>;
	const call = putMock.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).startsWith(KV.USAGE_PAGES_DISCOVERY));
	return call ? JSON.parse(call[1] as string) as PagesDiscoverySnapshot : null;
}

describe('discoverPagesProjects', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('skips when no API token', async () => {
		const env = mockEnv({ CLOUDFLARE_API_TOKEN: undefined });
		await discoverPagesProjects(env);
		expect(env.CF_MONITOR_KV.put).not.toHaveBeenCalled();
	});

	it('writes an empty snapshot when no projects exist', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(listResp([]));
		await discoverPagesProjects(env);
		const snap = readSnapshot(env)!;
		expect(snap.projects).toEqual([]);
		expect(snap.partial).toBe(false);
		expect(snap.confidence).toBe('runtime_metered');
		expect(snap.source).toBe('cloudflare_rest');
	});

	it('captures projects and marks every one functions_usage:unknown', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(listResp([
			{
				name: 'marketing-site',
				id: 'p1',
				production_branch: 'main',
				created_on: '2025-09-01T00:00:00Z',
				modified_on: '2026-05-01T00:00:00Z',
				latest_deployment: { id: 'd1', latest_stage: { name: 'deploy' }, created_on: '2026-05-01T00:00:00Z' },
			},
			{ name: 'blog', id: 'p2', production_branch: 'main' },
		]));
		await discoverPagesProjects(env);
		const snap = readSnapshot(env)!;
		expect(snap.projects).toHaveLength(2);
		expect(snap.projects.every((p) => p.functions_usage === 'unknown')).toBe(true);
		const m = snap.projects.find((p) => p.name === 'marketing-site')!;
		expect(m.id).toBe('p1');
		expect(m.production_branch).toBe('main');
		expect(m.latest_deployment).toEqual({ id: 'd1', stage: 'deploy', created_on: '2026-05-01T00:00:00Z' });
	});

	it('marks partial:true when result_info.total_count exceeds page size', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(listResp(
			[{ name: 'p1' }, { name: 'p2' }],
			150, // server says there are 150 total but only returned 2
		));
		await discoverPagesProjects(env);
		const snap = readSnapshot(env)!;
		expect(snap.partial).toBe(true);
	});

	it('skips writing on 403 (permission denied)', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
		await discoverPagesProjects(env);
		expect(env.CF_MONITOR_KV.put).not.toHaveBeenCalled();
	});
});
