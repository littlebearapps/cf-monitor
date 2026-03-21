import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleTailEvents } from '../../src/worker/tail-handler.js';
import { KV } from '../../src/constants.js';
import { createMockMonitorWorkerEnv, type MockMonitorWorkerEnv } from '../helpers/mock-env.js';
import { createMockCtx } from '../helpers/mock-request.js';

function createTraceItem(overrides?: Record<string, unknown>): TraceItem {
	return {
		scriptName: 'my-worker',
		outcome: 'exception',
		logs: [],
		exceptions: [{ name: 'Error', message: 'Something broke', timestamp: Date.now() }],
		event: null,
		eventTimestamp: Date.now(),
		diagnosticsChannelEvents: [],
		scriptVersion: undefined,
		scriptTags: [],
		dispatchNamespace: undefined,
		entrypoint: undefined,
		truncated: false,
		...overrides,
	} as unknown as TraceItem;
}

let env: MockMonitorWorkerEnv;
let ctx: ReturnType<typeof createMockCtx>;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
	env = createMockMonitorWorkerEnv({
		GITHUB_REPO: 'owner/repo',
		GITHUB_TOKEN: 'ghp_test',
	});
	ctx = createMockCtx();
	mockFetch = vi.fn().mockImplementation(() =>
		Promise.resolve(new Response(JSON.stringify({ html_url: 'https://github.com/test/repo/issues/1' }), {
			status: 201,
			headers: { 'Content-Type': 'application/json' },
		}))
	);
	vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('handleTailEvents', () => {
	it('captures exception outcome and creates GitHub issue', async () => {
		await handleTailEvents([createTraceItem()], env, ctx);

		expect(mockFetch).toHaveBeenCalledOnce();
		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.title).toContain('my-worker: exception');
	});

	it('stores fingerprint → issue URL in KV', async () => {
		await handleTailEvents([createTraceItem()], env, ctx);

		const keys = await env.CF_MONITOR_KV.list({ prefix: KV.ERR_FINGERPRINT });
		expect(keys.keys.length).toBeGreaterThan(0);
	});

	it('ignores ok outcome', async () => {
		await handleTailEvents([createTraceItem({ outcome: 'ok' })], env, ctx);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it('captures all error outcomes', async () => {
		const outcomes = ['exception', 'exceededCpu', 'exceededMemory', 'canceled', 'responseStreamDisconnected', 'scriptNotFound'];

		for (const outcome of outcomes) {
			env.CF_MONITOR_KV._reset();
			env.CF_MONITOR_AE._reset();
			mockFetch.mockClear();

			await handleTailEvents(
				[createTraceItem({ outcome, scriptName: `worker-${outcome}` })],
				env,
				ctx
			);

			expect(mockFetch).toHaveBeenCalled();
		}
	});

	it('deduplicates by fingerprint — second event skipped', async () => {
		await handleTailEvents([createTraceItem()], env, ctx);
		expect(mockFetch).toHaveBeenCalledOnce();

		mockFetch.mockClear();
		await handleTailEvents([createTraceItem()], env, ctx);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it('rate limits to 10 issues per script per hour', async () => {
		for (let i = 0; i < 12; i++) {
			await handleTailEvents(
				[createTraceItem({
					exceptions: [{ name: 'Error', message: `Unique error ${i}`, timestamp: Date.now() }],
				})],
				env,
				ctx
			);
		}

		// Should have created at most 10 issues
		expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(10);
	});

	it('writes error metrics to AE', async () => {
		await handleTailEvents([createTraceItem()], env, ctx);

		expect(env.CF_MONITOR_AE._dataPoints.length).toBeGreaterThan(0);
		const dp = env.CF_MONITOR_AE._dataPoints[0];
		expect(dp.blobs[0]).toBe('my-worker');
		expect(dp.blobs[1]).toBe('error');
	});

	it('handles GitHub API failure gracefully', async () => {
		mockFetch.mockRejectedValue(new Error('Network error'));

		// Should not throw
		await handleTailEvents([createTraceItem()], env, ctx);
	});

	it('one event failure does not break the batch', async () => {
		const events = [
			createTraceItem({ scriptName: 'worker-a' }),
			createTraceItem({ scriptName: null }), // scriptName is null
			createTraceItem({ scriptName: 'worker-c' }),
		];

		// Should process all events without throwing
		await handleTailEvents(events, env, ctx);

		// At least 2 GitHub issues created (worker-a and worker-c, maybe null too)
		expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
	});
});
