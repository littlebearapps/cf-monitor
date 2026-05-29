import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	collectAiGatewayUsage,
	mergeHourIntoDay,
} from '../../../src/worker/crons/collect-ai-gateway-usage.js';
import type { AiGatewayUsageSnapshot, MonitorWorkerEnv } from '../../../src/types.js';
import { KV, AE_FIELDS } from '../../../src/constants.js';

interface MockKVStore {
	get: ReturnType<typeof vi.fn>;
	put: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
	list: ReturnType<typeof vi.fn>;
	getWithMetadata: ReturnType<typeof vi.fn>;
}

function mockEnv(overrides?: Partial<MonitorWorkerEnv>): MonitorWorkerEnv & { CF_MONITOR_KV: MockKVStore } {
	const store = new Map<string, string>();
	const kv: MockKVStore = {
		get: vi.fn(async (key: string) => store.get(key) ?? null),
		put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
		delete: vi.fn(async (key: string) => { store.delete(key); }),
		list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
		getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
	};
	const env: MonitorWorkerEnv = {
		CF_MONITOR_KV: kv as unknown as KVNamespace,
		CF_MONITOR_AE: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
		CF_ACCOUNT_ID: 'aabbccdd11223344aabbccdd11223344',
		ACCOUNT_NAME: 'test-account',
		CLOUDFLARE_API_TOKEN: 'test-token',
		...overrides,
	};
	return env as MonitorWorkerEnv & { CF_MONITOR_KV: MockKVStore };
}

function cfListGateways(gateways: Array<{ id: string }>): Response {
	return Response.json({ success: true, result: gateways });
}

function cfLogsPage(rows: unknown[]): Response {
	return Response.json({ success: true, result: rows });
}

describe('collectAiGatewayUsage', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('skips when no API token', async () => {
		const env = mockEnv({ CLOUDFLARE_API_TOKEN: undefined });
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		await collectAiGatewayUsage(env);
		expect(fetchSpy).not.toHaveBeenCalled();
		// First-time warn is gated via warnOncePerDay → KV put for dedup is allowed,
		// but no snapshot must be written.
		const snapshotKeys = (env.CF_MONITOR_KV.put.mock.calls as Array<[string, ...unknown[]]>)
			.map(([k]) => k)
			.filter((k) => k.startsWith(KV.USAGE_ACCOUNT_AI_GATEWAY));
		expect(snapshotKeys).toHaveLength(0);
	});

	it('skips when account id is malformed', async () => {
		const env = mockEnv({ CF_ACCOUNT_ID: 'not-hex' });
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		await collectAiGatewayUsage(env);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('returns gracefully when no gateways exist', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(cfListGateways([]));
		await collectAiGatewayUsage(env);
		expect(env.CF_MONITOR_AE.writeDataPoint).not.toHaveBeenCalled();
	});

	it('aggregates logs by gateway/provider/model, writes AE + KV', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch')
			// listGateways
			.mockResolvedValueOnce(cfListGateways([{ id: 'platform' }]))
			// page 1 (returns < per_page → terminates pagination)
			.mockResolvedValueOnce(cfLogsPage([
				{ provider: 'openai', model: 'gpt-4o', cost: 0.012, tokens_in: 100, tokens_out: 50, duration: 200, cached: false, success: true },
				{ provider: 'openai', model: 'gpt-4o', cost: 0.018, tokens_in: 150, tokens_out: 80, duration: 400, cached: false, success: true },
				{ provider: 'openai', model: 'gpt-4o', cost: 0.000, tokens_in: 0, tokens_out: 0, duration: 5, cached: true, success: true },
				{ provider: 'google-ai-studio', model: 'gemini-2.5-flash-lite', cost: 0.0005, tokens_in: 200, tokens_out: 100, duration: 150, cached: false, success: true },
				{ provider: 'google-ai-studio', model: 'gemini-2.5-flash-lite', cost: 0, tokens_in: 0, tokens_out: 0, duration: 90, cached: false, success: false },
			]));

		await collectAiGatewayUsage(env);

		const aeCalls = (env.CF_MONITOR_AE.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls;
		// 2 (gateway, provider, model) buckets
		expect(aeCalls).toHaveLength(2);

		const openaiCall = aeCalls.find((c: Array<{ blobs: string[] }>) => c[0].blobs[3] === 'gpt-4o');
		expect(openaiCall).toBeDefined();
		const openaiPoint = (openaiCall as Array<Record<string, unknown>>)[0] as { blobs: string[]; doubles: number[]; indexes: string[] };
		expect(openaiPoint.blobs[0]).toBe('aabbccdd11223344aabbccdd11223344');
		expect(openaiPoint.blobs[1]).toBe('platform');
		expect(openaiPoint.blobs[2]).toBe('openai');
		expect(openaiPoint.blobs[3]).toBe('gpt-4o');
		expect(openaiPoint.blobs[4]).toBe('ai-gateway');
		expect(openaiPoint.indexes[0]).toBe('aabbccdd11223344aabbccdd11223344');
		expect(openaiPoint.doubles[AE_FIELDS.aiGatewayRequests]).toBe(3);
		expect(openaiPoint.doubles[AE_FIELDS.aiGatewayTokensIn]).toBe(250);
		expect(openaiPoint.doubles[AE_FIELDS.aiGatewayTokensOut]).toBe(130);
		expect(openaiPoint.doubles[AE_FIELDS.aiGatewayCost]).toBeCloseTo(0.030, 6);
		expect(openaiPoint.doubles[AE_FIELDS.aiGatewayCachedCount]).toBe(1);
		expect(openaiPoint.doubles[AE_FIELDS.aiGatewayErrorCount]).toBe(0);

		const geminiCall = aeCalls.find((c: Array<{ blobs: string[] }>) => c[0].blobs[2] === 'google-ai-studio');
		expect(geminiCall).toBeDefined();
		const geminiPoint = (geminiCall as Array<Record<string, unknown>>)[0] as { doubles: number[] };
		expect(geminiPoint.doubles[AE_FIELDS.aiGatewayRequests]).toBe(2);
		expect(geminiPoint.doubles[AE_FIELDS.aiGatewayErrorCount]).toBe(1);

		// KV snapshot
		const putCalls = env.CF_MONITOR_KV.put.mock.calls as Array<[string, string, unknown]>;
		const snapshotCall = putCalls.find(([key]) => key.startsWith(KV.USAGE_ACCOUNT_AI_GATEWAY));
		expect(snapshotCall).toBeDefined();
		const [snapshotKey, snapshotJson] = snapshotCall as [string, string, { expirationTtl: number }];
		expect(snapshotKey).toMatch(/^usage:account:ai-gateway:\d{4}-\d{2}-\d{2}$/);

		const snapshot = JSON.parse(snapshotJson) as AiGatewayUsageSnapshot;
		expect(snapshot.totals.requests).toBe(5);
		expect(snapshot.totals.cached).toBe(1);
		expect(snapshot.totals.errors).toBe(1);
		expect(snapshot.gateways.platform.providers.openai.models['gpt-4o'].requests).toBe(3);
		expect(snapshot.gateways.platform.providers['google-ai-studio'].models['gemini-2.5-flash-lite'].errors).toBe(1);
	});

	it('paginates up to MAX_PAGES_PER_GATEWAY and stops, flagging page cap', async () => {
		const env = mockEnv();
		const fullPage = Array.from({ length: 1000 }, (_, i) => ({
			provider: 'openai',
			model: 'gpt-4o',
			cost: 0,
			tokens_in: 1,
			tokens_out: 1,
			duration: 10,
			cached: false,
			success: true,
			id: `row-${i}`,
		}));
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(cfListGateways([{ id: 'busy' }]))
			.mockResolvedValueOnce(cfLogsPage(fullPage))   // page 1
			.mockResolvedValueOnce(cfLogsPage(fullPage))   // page 2
			.mockResolvedValueOnce(cfLogsPage(fullPage))   // page 3
			.mockResolvedValueOnce(cfLogsPage(fullPage))   // page 4
			.mockResolvedValueOnce(cfLogsPage(fullPage));  // page 5 (cap)

		await collectAiGatewayUsage(env);

		// 1 list + 5 log pages = 6 fetches; no 6th log page
		expect(fetchSpy).toHaveBeenCalledTimes(6);
	});

	it('treats 403 from gateway list as fail-open (no AE, no snapshot)', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
		await collectAiGatewayUsage(env);
		expect(env.CF_MONITOR_AE.writeDataPoint).not.toHaveBeenCalled();
		const snapshotKeys = (env.CF_MONITOR_KV.put.mock.calls as Array<[string, ...unknown[]]>)
			.map(([k]) => k)
			.filter((k) => k.startsWith(KV.USAGE_ACCOUNT_AI_GATEWAY));
		expect(snapshotKeys).toHaveLength(0);
	});

	it('handles malformed log rows defensively', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(cfListGateways([{ id: 'platform' }]))
			.mockResolvedValueOnce(cfLogsPage([
				{ provider: null, model: null, cost: 'NaN', tokens_in: 'abc', tokens_out: undefined, duration: -5 },
				{ /* completely empty */ },
			]));

		await collectAiGatewayUsage(env);

		const aeCalls = (env.CF_MONITOR_AE.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls;
		// Two rows fall into the 'unknown/unknown' bucket
		expect(aeCalls).toHaveLength(1);
		const point = aeCalls[0][0] as { blobs: string[]; doubles: number[] };
		expect(point.blobs[2]).toBe('unknown');
		expect(point.blobs[3]).toBe('unknown');
		expect(point.doubles[AE_FIELDS.aiGatewayRequests]).toBe(2);
		expect(point.doubles[AE_FIELDS.aiGatewayTokensIn]).toBe(0);
		expect(point.doubles[AE_FIELDS.aiGatewayCost]).toBe(0);
	});
});

describe('mergeHourIntoDay', () => {
	const today = '2026-05-27';

	it('creates a fresh snapshot when no prior exists', () => {
		const merged = mergeHourIntoDay(null, today, {
			'platform': {
				providers: {
					'openai': {
						models: {
							'gpt-4o': { requests: 2, tokens_in: 100, tokens_out: 50, cost: 0.03, cached: 0, errors: 0, p50_duration_ms: 300 },
						},
					},
				},
			},
		});

		expect(merged.date).toBe(today);
		expect(merged.totals.requests).toBe(2);
		expect(merged.totals.cost).toBeCloseTo(0.03, 6);
		expect(merged.gateways.platform.providers.openai.models['gpt-4o'].requests).toBe(2);
		expect(merged.lastUpdated).toBeGreaterThan(0);
		expect(merged.disclaimer).toBeTruthy();
	});

	it('sums repeated (gateway, provider, model) across hours', () => {
		const first = mergeHourIntoDay(null, today, {
			'platform': {
				providers: {
					'openai': {
						models: {
							'gpt-4o': { requests: 2, tokens_in: 100, tokens_out: 50, cost: 0.03, cached: 0, errors: 0, p50_duration_ms: 200 },
						},
					},
				},
			},
		});
		const second = mergeHourIntoDay(first, today, {
			'platform': {
				providers: {
					'openai': {
						models: {
							'gpt-4o': { requests: 3, tokens_in: 150, tokens_out: 75, cost: 0.045, cached: 1, errors: 1, p50_duration_ms: 400 },
						},
					},
				},
			},
		});

		const gpt = second.gateways.platform.providers.openai.models['gpt-4o'];
		expect(gpt.requests).toBe(5);
		expect(gpt.tokens_in).toBe(250);
		expect(gpt.tokens_out).toBe(125);
		expect(gpt.cost).toBeCloseTo(0.075, 6);
		expect(gpt.cached).toBe(1);
		expect(gpt.errors).toBe(1);
		// Weighted p50: (200*2 + 400*3) / 5 = 320
		expect(gpt.p50_duration_ms).toBe(320);
		expect(second.totals.requests).toBe(5);
	});

	it('adds new (provider, model) buckets without disturbing existing ones', () => {
		const first = mergeHourIntoDay(null, today, {
			'platform': {
				providers: {
					'openai': {
						models: {
							'gpt-4o': { requests: 1, tokens_in: 10, tokens_out: 5, cost: 0.001, cached: 0, errors: 0, p50_duration_ms: 100 },
						},
					},
				},
			},
		});
		const second = mergeHourIntoDay(first, today, {
			'platform': {
				providers: {
					'google-ai-studio': {
						models: {
							'gemini-2.5-flash-lite': { requests: 4, tokens_in: 40, tokens_out: 20, cost: 0.002, cached: 0, errors: 0, p50_duration_ms: 150 },
						},
					},
				},
			},
		});

		expect(Object.keys(second.gateways.platform.providers)).toEqual(['openai', 'google-ai-studio']);
		expect(second.totals.requests).toBe(5);
	});
});
