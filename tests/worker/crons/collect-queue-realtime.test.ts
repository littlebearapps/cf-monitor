import { describe, it, expect, vi, beforeEach } from 'vitest';
import { collectQueueRealtime } from '../../../src/worker/crons/collect-queue-realtime.js';
import type { MonitorWorkerEnv, QueueRealtimeSnapshot } from '../../../src/types.js';
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

function listQueuesResp(queues: Array<{ queue_id: string; queue_name: string }>): Response {
	return Response.json({ success: true, result: queues });
}
function metricsResp(m: { backlog_count?: number; backlog_bytes?: number; oldest_message_timestamp_ms?: number }): Response {
	return Response.json({ success: true, result: m });
}

function readSnapshot(env: MonitorWorkerEnv): QueueRealtimeSnapshot | null {
	const putMock = env.CF_MONITOR_KV.put as ReturnType<typeof vi.fn>;
	const call = putMock.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).startsWith(KV.USAGE_QUEUE_REALTIME));
	return call ? JSON.parse(call[1] as string) as QueueRealtimeSnapshot : null;
}

describe('collectQueueRealtime', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('skips when no API token', async () => {
		const env = mockEnv({ CLOUDFLARE_API_TOKEN: undefined });
		await collectQueueRealtime(env);
		expect(env.CF_MONITOR_KV.put).not.toHaveBeenCalled();
	});

	it('writes an empty snapshot when no queues exist', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(listQueuesResp([]));
		await collectQueueRealtime(env);
		const snap = readSnapshot(env);
		expect(snap).not.toBeNull();
		expect(snap!.queues).toEqual([]);
		expect(snap!.partial).toBe(false);
		expect(snap!.confidence).toBe('runtime_metered');
		expect(snap!.source).toBe('cloudflare_rest');
	});

	it('captures one queue successfully', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(listQueuesResp([{ queue_id: 'q1', queue_name: 'tasks' }]))
			.mockResolvedValueOnce(metricsResp({ backlog_count: 42, backlog_bytes: 1024, oldest_message_timestamp_ms: 17_000_000 }));
		await collectQueueRealtime(env);
		const snap = readSnapshot(env)!;
		expect(snap.queues).toHaveLength(1);
		expect(snap.queues[0]).toMatchObject({
			id: 'q1',
			name: 'tasks',
			backlog_count: 42,
			backlog_bytes: 1024,
			oldest_message_timestamp_ms: 17_000_000,
		});
		expect(snap.partial).toBe(false);
	});

	it('survives a single queue failure (partial=true, per-queue error captured)', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(listQueuesResp([
				{ queue_id: 'q1', queue_name: 'good' },
				{ queue_id: 'q2', queue_name: 'broken' },
			]))
			.mockResolvedValueOnce(metricsResp({ backlog_count: 5, backlog_bytes: 200, oldest_message_timestamp_ms: 0 }))
			.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
		await collectQueueRealtime(env);
		const snap = readSnapshot(env)!;
		expect(snap.queues).toHaveLength(2);
		expect(snap.partial).toBe(true);
		const broken = snap.queues.find((q) => q.id === 'q2')!;
		expect(broken.error).toBe('HTTP 403');
		expect(broken.backlog_count).toBeUndefined();
		const good = snap.queues.find((q) => q.id === 'q1')!;
		expect(good.error).toBeUndefined();
		expect(good.backlog_count).toBe(5);
	});

	it('handles malformed metrics body without aborting', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(listQueuesResp([{ queue_id: 'q1', queue_name: 'tasks' }]))
			.mockResolvedValueOnce(new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }));
		await collectQueueRealtime(env);
		const snap = readSnapshot(env)!;
		expect(snap.queues[0].error).toBe('malformed_response');
		expect(snap.partial).toBe(true);
	});

	it('handles 429 / 5xx on metrics call gracefully', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(listQueuesResp([
				{ queue_id: 'a', queue_name: 'a' },
				{ queue_id: 'b', queue_name: 'b' },
			]))
			.mockResolvedValueOnce(new Response('Too Many Requests', { status: 429 }))
			.mockResolvedValueOnce(new Response('Server Error', { status: 503 }));
		await collectQueueRealtime(env);
		const snap = readSnapshot(env)!;
		const errors = snap.queues.map((q) => q.error);
		expect(errors).toContain('HTTP 429');
		expect(errors).toContain('HTTP 503');
		expect(snap.partial).toBe(true);
	});

	it('does not write a snapshot if listing queues fails (403)', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
		await collectQueueRealtime(env);
		expect(env.CF_MONITOR_KV.put).not.toHaveBeenCalled();
	});
});
