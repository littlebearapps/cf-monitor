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

describe('soft error capture (#14)', () => {
	it('captures console.error() from ok-outcome events as soft_error', async () => {
		const event = createTraceItem({
			outcome: 'ok',
			exceptions: [],
			logs: [
				{ level: 'error', message: ['Database connection failed'], timestamp: Date.now() },
			],
		});

		await handleTailEvents([event], env, ctx);

		// Should create a GitHub issue for the soft error
		expect(mockFetch).toHaveBeenCalledOnce();
		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.title).toContain('soft_error');
		expect(body.labels).toContain('cf:error:soft_error');
	});

	it('stores console.warn() in KV digest instead of creating immediate issue', async () => {
		const event = createTraceItem({
			outcome: 'ok',
			exceptions: [],
			logs: [
				{ level: 'warn', message: ['Deprecated API used'], timestamp: Date.now() },
			],
		});

		await handleTailEvents([event], env, ctx);

		// Should NOT create a GitHub issue for warnings
		expect(mockFetch).not.toHaveBeenCalled();

		// Should store in KV digest
		const today = new Date().toISOString().slice(0, 10);
		const digestRaw = await env.CF_MONITOR_KV.get(`warn:digest:${today}`);
		expect(digestRaw).not.toBeNull();

		const digest = JSON.parse(digestRaw!);
		expect(digest).toHaveLength(1);
		expect(digest[0].script).toBe('my-worker');
		expect(digest[0].message).toBe('Deprecated API used');
	});

	it('deduplicates warnings in the same digest', async () => {
		const makeEvent = () => createTraceItem({
			outcome: 'ok',
			exceptions: [],
			logs: [
				{ level: 'warn', message: ['Same warning message'], timestamp: Date.now() },
			],
		});

		await handleTailEvents([makeEvent()], env, ctx);
		await handleTailEvents([makeEvent()], env, ctx);

		const today = new Date().toISOString().slice(0, 10);
		const digest = JSON.parse((await env.CF_MONITOR_KV.get(`warn:digest:${today}`))!);
		expect(digest).toHaveLength(1); // Not 2
	});

	it('processes both soft errors and warnings from the same event', async () => {
		const event = createTraceItem({
			outcome: 'ok',
			exceptions: [],
			logs: [
				{ level: 'error', message: ['Real error'], timestamp: Date.now() },
				{ level: 'warn', message: ['Just a warning'], timestamp: Date.now() },
			],
		});

		await handleTailEvents([event], env, ctx);

		// Soft error creates GitHub issue
		expect(mockFetch).toHaveBeenCalledOnce();

		// Warning stored in digest
		const today = new Date().toISOString().slice(0, 10);
		const digest = JSON.parse((await env.CF_MONITOR_KV.get(`warn:digest:${today}`))!);
		expect(digest).toHaveLength(1);
	});

	it('ignores ok events with no error or warn logs', async () => {
		const event = createTraceItem({
			outcome: 'ok',
			exceptions: [],
			logs: [
				{ level: 'log', message: ['Normal log'], timestamp: Date.now() },
			],
		});

		await handleTailEvents([event], env, ctx);
		expect(mockFetch).not.toHaveBeenCalled();
	});
});

describe('observability logging (#82)', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('logs batch summary', async () => {
		await handleTailEvents([createTraceItem()], env, ctx);
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[cf-monitor:tail] Batch:'));
	});

	it('warns when GitHub not configured', async () => {
		env.GITHUB_REPO = '';
		env.GITHUB_TOKEN = '';
		await handleTailEvents([createTraceItem()], env, ctx);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GitHub not configured'));
	});

	it('logs dedup skip reason', async () => {
		await handleTailEvents([createTraceItem()], env, ctx);
		logSpy.mockClear();
		await handleTailEvents([createTraceItem()], env, ctx);
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Dedup:'));
	});

	it('logs rate limit skip reason', async () => {
		for (let i = 0; i < 11; i++) {
			await handleTailEvents(
				[createTraceItem({
					exceptions: [{ name: 'Error', message: `Error ${i}`, timestamp: Date.now() }],
				})],
				env, ctx
			);
		}
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Rate limit:'));
	});

	it('logs issue creation success', async () => {
		await handleTailEvents([createTraceItem()], env, ctx);
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Created issue:'));
	});

	it('logs non-capturable outcome', async () => {
		await handleTailEvents([createTraceItem({ outcome: 'unknown_outcome' })], env, ctx);
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Skip non-capturable:'));
	});
});

describe('daily issue cap (#92)', () => {
	it('prevents more than 50 issues per script per day', async () => {
		// Pre-seed daily counter near the limit
		const today = new Date().toISOString().slice(0, 10);
		await env.CF_MONITOR_KV.put(`err:rate:my-worker:daily:${today}`, '50', { expirationTtl: 90000 });

		await handleTailEvents(
			[createTraceItem({
				exceptions: [{ name: 'Error', message: 'New unique error', timestamp: Date.now() }],
			})],
			env,
			ctx
		);

		// Should NOT create a GitHub issue (daily cap reached)
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it('allows issues when daily counter is below cap', async () => {
		const today = new Date().toISOString().slice(0, 10);
		await env.CF_MONITOR_KV.put(`err:rate:my-worker:daily:${today}`, '49', { expirationTtl: 90000 });

		await handleTailEvents(
			[createTraceItem({
				exceptions: [{ name: 'Error', message: 'New unique error below cap', timestamp: Date.now() }],
			})],
			env,
			ctx
		);

		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it('increments daily counter after issue creation', async () => {
		await handleTailEvents([createTraceItem()], env, ctx);

		const today = new Date().toISOString().slice(0, 10);
		const count = await env.CF_MONITOR_KV.get(`err:rate:my-worker:daily:${today}`);
		expect(count).toBe('1');
	});
});

describe('custom transient patterns (#92)', () => {
	it('uses custom transient patterns from env for daily dedup', async () => {
		env._customTransientPatterns = [
			{ name: 'custom-billing', match: 'insufficient.*balance' },
		];

		// First event with matching message should create an issue
		await handleTailEvents(
			[createTraceItem({
				exceptions: [{ name: 'Error', message: 'DeepSeek: 402 Insufficient Balance', timestamp: Date.now() }],
			})],
			env,
			ctx
		);
		expect(mockFetch).toHaveBeenCalledOnce();

		mockFetch.mockClear();

		// Second event same day — transient dedup should prevent duplicate
		await handleTailEvents(
			[createTraceItem({
				scriptName: 'my-worker',
				exceptions: [{ name: 'Error', message: 'DeepSeek: 402 Insufficient Balance again', timestamp: Date.now() }],
			})],
			env,
			ctx
		);

		// The built-in billing-exhausted pattern or custom pattern catches it,
		// and transient dedup key prevents the second issue
		// (First event already set the transient key)
		expect(mockFetch).not.toHaveBeenCalled();
	});
});

describe('soft error transient dedup (#99)', () => {
	it('deduplicates transient soft errors to one issue per pattern per day', async () => {
		// First soft error with rate limit message — should create issue
		const event1 = createTraceItem({
			outcome: 'ok',
			exceptions: [],
			logs: [
				{ level: 'error', message: ['429 Too Many Requests from API'], timestamp: Date.now() },
			],
		});
		await handleTailEvents([event1], env, ctx);
		expect(mockFetch).toHaveBeenCalledOnce();

		mockFetch.mockClear();

		// Second soft error same pattern same day — transient dedup should skip
		const event2 = createTraceItem({
			outcome: 'ok',
			exceptions: [],
			logs: [
				{ level: 'error', message: ['429 Too Many Requests again'], timestamp: Date.now() },
			],
		});
		await handleTailEvents([event2], env, ctx);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it('allows non-transient soft errors through', async () => {
		const event = createTraceItem({
			outcome: 'ok',
			exceptions: [],
			logs: [
				{ level: 'error', message: ['TypeError: Cannot read property of undefined'], timestamp: Date.now() },
			],
		});
		await handleTailEvents([event], env, ctx);
		expect(mockFetch).toHaveBeenCalledOnce();
	});
});

describe('batch-level dedup (#99 — #1228 burst)', () => {
	it('deduplicates identical errors within the same tail batch', async () => {
		const events = [
			createTraceItem({
				scriptName: 'bc-worker',
				exceptions: [{ name: 'Error', message: 'Gemini 503 Service Unavailable', timestamp: Date.now() }],
			}),
			createTraceItem({
				scriptName: 'bc-worker',
				exceptions: [{ name: 'Error', message: 'Gemini 503 Service Unavailable', timestamp: Date.now() }],
			}),
			createTraceItem({
				scriptName: 'bc-worker',
				exceptions: [{ name: 'Error', message: 'Gemini 503 Service Unavailable', timestamp: Date.now() }],
			}),
			createTraceItem({
				scriptName: 'bc-worker',
				exceptions: [{ name: 'Error', message: 'Gemini 503 Service Unavailable', timestamp: Date.now() }],
			}),
		];

		await handleTailEvents(events, env, ctx);

		// Only 1 issue should be created despite 4 identical errors in the batch
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it('allows different errors in the same batch through', async () => {
		const events = [
			createTraceItem({
				scriptName: 'bc-worker',
				exceptions: [{ name: 'Error', message: 'Gemini 503 Service Unavailable', timestamp: Date.now() }],
			}),
			createTraceItem({
				scriptName: 'bc-worker',
				exceptions: [{ name: 'TypeError', message: 'Cannot read property of undefined', timestamp: Date.now() }],
			}),
		];

		await handleTailEvents(events, env, ctx);

		// 2 different errors → 2 issues
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it('deduplicates identical soft errors within the same batch', async () => {
		const events = [
			createTraceItem({
				outcome: 'ok',
				exceptions: [],
				logs: [
					{ level: 'error', message: ['Database connection failed'], timestamp: Date.now() },
					{ level: 'error', message: ['Database connection failed'], timestamp: Date.now() },
				],
			}),
		];

		await handleTailEvents(events, env, ctx);

		// Only 1 issue for the duplicate soft errors
		expect(mockFetch).toHaveBeenCalledOnce();
	});
});
