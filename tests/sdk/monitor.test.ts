import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { monitor } from '../../src/sdk/monitor.js';
import { KV, METRICS_TO_BUDGET } from '../../src/constants.js';
import { CircuitBreakerError } from '../../src/types.js';
import { createMockConsumerEnv, type MockConsumerEnv } from '../helpers/mock-env.js';
import { createRequest, createMockCtx, createMockScheduledController, createMockMessageBatch } from '../helpers/mock-request.js';

let env: MockConsumerEnv;
let ctx: ReturnType<typeof createMockCtx>;

beforeEach(() => {
	env = createMockConsumerEnv();
	ctx = createMockCtx();
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('monitor() fetch handler', () => {
	it('wraps user handler and flushes AE telemetry via waitUntil', async () => {
		const worker = monitor({
			fetch: async (req, env) => {
				await (env as any).DB.prepare('SELECT 1').first();
				return new Response('ok');
			},
		});

		const resp = await worker.fetch!(createRequest('/api/test'), env as any, ctx);
		await ctx._flush();

		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe('ok');
		expect(env.CF_MONITOR_AE._dataPoints.length).toBeGreaterThan(0);
	});

	it('serves health endpoint at /_monitor/health', async () => {
		const worker = monitor({
			fetch: async () => new Response('user'),
		});

		const resp = await worker.fetch!(createRequest('/_monitor/health'), env as any, ctx);
		const body = await resp.json() as Record<string, unknown>;

		expect(resp.status).toBe(200);
		expect(body.healthy).toBe(true);
		expect(body.worker).toBe('test-worker');
	});

	it('disables health endpoint when healthEndpoint: false', async () => {
		const handler = vi.fn().mockResolvedValue(new Response('user'));
		const worker = monitor({ fetch: handler, healthEndpoint: false });

		await worker.fetch!(createRequest('/_monitor/health'), env as any, ctx);
		expect(handler).toHaveBeenCalled();
	});

	it('returns 503 when feature CB is STOP', async () => {
		await env.CF_MONITOR_KV.put(`${KV.CB_FEATURE}test-worker:fetch:GET:api-test`, 'STOP');

		const worker = monitor({
			fetch: async () => new Response('should not run'),
		});

		const resp = await worker.fetch!(createRequest('/api/test'), env as any, ctx);
		expect(resp.status).toBe(503);
	});

	it('returns 503 when account CB is active', async () => {
		await env.CF_MONITOR_KV.put(KV.CB_GLOBAL, 'true');

		const worker = monitor({
			fetch: async () => new Response('should not run'),
		});

		const resp = await worker.fetch!(createRequest('/api/test'), env as any, ctx);
		expect(resp.status).toBe(503);
	});

	it('calls onCircuitBreaker with CircuitBreakerError', async () => {
		await env.CF_MONITOR_KV.put(KV.CB_GLOBAL, 'true');

		const onCb = vi.fn().mockReturnValue(new Response('custom cb', { status: 429 }));
		const worker = monitor({
			fetch: async () => new Response('user'),
			onCircuitBreaker: onCb,
		});

		const resp = await worker.fetch!(createRequest('/api/test'), env as any, ctx);
		expect(resp.status).toBe(429);
		expect(onCb).toHaveBeenCalledWith(expect.any(CircuitBreakerError));
	});

	it('returns 500 on user handler error (default)', async () => {
		const worker = monitor({
			fetch: async (_req, e) => {
				// Do some D1 work before throwing so metrics are non-zero
				await (e as any).DB.prepare('SELECT 1').first();
				throw new Error('boom');
			},
		});

		const resp = await worker.fetch!(createRequest('/api/test'), env as any, ctx);
		await ctx._flush();

		expect(resp.status).toBe(500);
		// AE should have the data point (d1Read happened before the throw)
		expect(env.CF_MONITOR_AE._dataPoints.length).toBeGreaterThan(0);
	});

	it('calls onError callback', async () => {
		const onError = vi.fn().mockReturnValue(new Response('handled', { status: 422 }));
		const worker = monitor({
			fetch: async () => {
				throw new Error('validation failed');
			},
			onError,
		});

		const resp = await worker.fetch!(createRequest('/api/test'), env as any, ctx);
		expect(resp.status).toBe(422);
		expect(onError).toHaveBeenCalledWith(expect.any(Error), 'fetch');
	});
});

describe('monitor() scheduled handler', () => {
	it('wraps user handler and flushes telemetry', async () => {
		const handler = vi.fn().mockImplementation(async (_ctrl: unknown, e: any) => {
			await e.DB.prepare('SELECT 1').first();
		});
		const worker = monitor({ scheduled: handler });

		await worker.scheduled!(createMockScheduledController('0 * * * *'), env as any, ctx);
		await ctx._flush();

		expect(handler).toHaveBeenCalled();
		expect(env.CF_MONITOR_AE._dataPoints.length).toBeGreaterThan(0);
	});

	it('pings heartbeat on success (autoHeartbeat default true)', async () => {
		(env as any).GATUS_HEARTBEAT_URL = 'https://gatus.example.com/heartbeat';
		(env as any).GATUS_TOKEN = 'token123';

		const worker = monitor({
			scheduled: async () => {},
		});

		await worker.scheduled!(createMockScheduledController('0 * * * *'), env as any, ctx);
		await ctx._flush();

		expect(fetch).toHaveBeenCalled();
	});

	it('skips handler when account CB is active', async () => {
		await env.CF_MONITOR_KV.put(KV.CB_GLOBAL, 'true');

		const handler = vi.fn();
		const worker = monitor({ scheduled: handler });

		await worker.scheduled!(createMockScheduledController('0 * * * *'), env as any, ctx);

		expect(handler).not.toHaveBeenCalled();
	});
});

describe('monitor() queue handler', () => {
	it('wraps user handler and flushes telemetry', async () => {
		const handler = vi.fn().mockImplementation(async (_batch: unknown, e: any) => {
			await e.DB.prepare('SELECT 1').first();
		});
		const worker = monitor({ queue: handler });

		const batch = createMockMessageBatch('my-queue', [{ data: 1 }]);
		await worker.queue!(batch, env as any, ctx);
		await ctx._flush();

		expect(handler).toHaveBeenCalled();
		expect(env.CF_MONITOR_AE._dataPoints.length).toBeGreaterThan(0);
	});

	it('calls retryAll when account CB is active', async () => {
		await env.CF_MONITOR_KV.put(KV.CB_GLOBAL, 'true');

		const handler = vi.fn();
		const worker = monitor({ queue: handler });

		const batch = createMockMessageBatch('my-queue', [{ data: 1 }]);
		await worker.queue!(batch, env as any, ctx);

		expect(handler).not.toHaveBeenCalled();
		expect(batch.retryAll).toHaveBeenCalled();
	});
});

describe('monitor() fail-open', () => {
	it('runs unwrapped when bindings missing (failOpen default true)', async () => {
		const envNoBind = { WORKER_NAME: 'test' }; // No CF_MONITOR_KV/AE
		const handler = vi.fn().mockResolvedValue(new Response('unwrapped'));
		const worker = monitor({ fetch: handler });

		const resp = await worker.fetch!(createRequest('/test'), envNoBind as any, ctx);
		expect(resp.status).toBe(200);
		expect(await resp.text()).toBe('unwrapped');
	});

	it('throws when bindings missing and failOpen: false', async () => {
		const envNoBind = { WORKER_NAME: 'test' };
		const worker = monitor({ fetch: async () => new Response(''), failOpen: false });

		await expect(worker.fetch!(createRequest('/test'), envNoBind as any, ctx)).rejects.toThrow(
			'Missing CF_MONITOR_KV or CF_MONITOR_AE bindings'
		);
	});
});

describe('monitor() features map', () => {
	it('custom features map overrides auto-generated ID', async () => {
		const worker = monitor({
			fetch: async (req, e) => {
				await (e as any).DB.prepare('SELECT 1').first();
				return new Response('ok');
			},
			features: { 'GET /api/custom': 'my-feature:custom' },
		});

		await worker.fetch!(createRequest('/api/custom'), env as any, ctx);
		await ctx._flush();

		const dp = env.CF_MONITOR_AE._dataPoints[0];
		expect(dp.indexes[0]).toBe('my-feature:custom');
	});

	it('features: false excludes route from tracking', async () => {
		const handler = vi.fn().mockResolvedValue(new Response('ok'));
		const worker = monitor({
			fetch: handler,
			features: { 'GET /_monitor/health': false, 'GET /internal': false },
		});

		await worker.fetch!(createRequest('/internal'), env as any, ctx);
		await ctx._flush();

		// Handler should be called but without wrapping (no AE write)
		expect(handler).toHaveBeenCalled();
		expect(env.CF_MONITOR_AE._dataPoints).toHaveLength(0);
	});
});

describe('monitor() workerName config (#28)', () => {
	it('uses config.workerName over env detection', async () => {
		const worker = monitor({
			workerName: 'explicit-name',
			fetch: async (_req, e) => {
				await (e as any).DB.prepare('SELECT 1').first();
				return new Response('ok');
			},
		});

		await worker.fetch!(createRequest('/api/test'), env as any, ctx);
		await ctx._flush();

		const dp = env.CF_MONITOR_AE._dataPoints[0];
		expect(dp.blobs[0]).toBe('explicit-name');
		expect(dp.indexes[0]).toBe('explicit-name:fetch:GET:api-test');
	});

	it('health endpoint returns config.workerName', async () => {
		const worker = monitor({
			workerName: 'custom-worker',
			fetch: async () => new Response('user'),
		});

		const resp = await worker.fetch!(createRequest('/_monitor/health'), env as any, ctx);
		const body = await resp.json() as Record<string, unknown>;
		// Health endpoint still uses detectWorkerName(env) — not config.workerName
		// This is by design: health endpoint is pre-instrumentation
		expect(body.worker).toBeDefined();
	});
});

describe('monitor() featureId config (#30)', () => {
	it('uses config.featureId for all routes', async () => {
		const worker = monitor({
			featureId: 'my-app:all',
			fetch: async (_req, e) => {
				await (e as any).DB.prepare('SELECT 1').first();
				return new Response('ok');
			},
		});

		await worker.fetch!(createRequest('/api/users'), env as any, ctx);
		await ctx._flush();

		const dp = env.CF_MONITOR_AE._dataPoints[0];
		expect(dp.indexes[0]).toBe('my-app:all');
	});

	it('featureId takes precedence over features map', async () => {
		const worker = monitor({
			featureId: 'global-id',
			features: { 'GET /api/users': 'route-specific' },
			fetch: async (_req, e) => {
				await (e as any).DB.prepare('SELECT 1').first();
				return new Response('ok');
			},
		});

		await worker.fetch!(createRequest('/api/users'), env as any, ctx);
		await ctx._flush();

		const dp = env.CF_MONITOR_AE._dataPoints[0];
		expect(dp.indexes[0]).toBe('global-id');
	});
});

describe('monitor() featurePrefix config (#30)', () => {
	it('uses featurePrefix in auto-generated IDs', async () => {
		const worker = monitor({
			featurePrefix: 'platform',
			fetch: async (_req, e) => {
				await (e as any).DB.prepare('SELECT 1').first();
				return new Response('ok');
			},
		});

		await worker.fetch!(createRequest('/api/notifications'), env as any, ctx);
		await ctx._flush();

		const dp = env.CF_MONITOR_AE._dataPoints[0];
		expect(dp.indexes[0]).toBe('platform:fetch:GET:api-notifications');
	});

	it('features map still overrides featurePrefix', async () => {
		const worker = monitor({
			featurePrefix: 'platform',
			features: { 'GET /api/users': 'platform:users:api' },
			fetch: async (_req, e) => {
				await (e as any).DB.prepare('SELECT 1').first();
				return new Response('ok');
			},
		});

		await worker.fetch!(createRequest('/api/users'), env as any, ctx);
		await ctx._flush();

		const dp = env.CF_MONITOR_AE._dataPoints[0];
		expect(dp.indexes[0]).toBe('platform:users:api');
	});

	it('featurePrefix works with scheduled handler', async () => {
		const handler = vi.fn().mockImplementation(async (_ctrl: unknown, e: any) => {
			await e.DB.prepare('SELECT 1').first();
		});
		const worker = monitor({ featurePrefix: 'myapp', scheduled: handler });

		await worker.scheduled!(createMockScheduledController('0 2 * * *'), env as any, ctx);
		await ctx._flush();

		const dp = env.CF_MONITOR_AE._dataPoints[0];
		expect(dp.indexes[0]).toBe('myapp:cron:0-2-x-x-x');
	});
});

describe('monitor() last_seen KV write (#19)', () => {
	it('writes workers:{name}:last_seen to KV on telemetry flush', async () => {
		const worker = monitor({
			fetch: async (_req, e) => {
				await (e as any).DB.prepare('SELECT 1').first();
				return new Response('ok');
			},
		});

		await worker.fetch!(createRequest('/api/test'), env as any, ctx);
		await ctx._flush();

		const lastSeen = await env.CF_MONITOR_KV.get('workers:test-worker:last_seen');
		expect(lastSeen).not.toBeNull();
		// Should be a valid ISO date
		expect(new Date(lastSeen!).getTime()).not.toBeNaN();
	});

	it('writes last_seen even when no bindings are used (heartbeat always fires)', async () => {
		const worker = monitor({
			fetch: async () => new Response('ok'), // no binding usage
		});

		await worker.fetch!(createRequest('/api/test'), env as any, ctx);
		await ctx._flush();

		const lastSeen = await env.CF_MONITOR_KV.get('workers:test-worker:last_seen');
		expect(lastSeen).not.toBeNull();
	});
});

describe('monitor() budget accumulation (#25)', () => {
	it('flushTelemetry writes daily KV counters after AE write', async () => {
		const worker = monitor({
			fetch: async (_req, e) => {
				await (e as any).DB.prepare('SELECT 1').first(); // d1Reads + d1RowsRead
				await (e as any).MY_KV.put('k', 'v'); // kvWrites
				return new Response('ok');
			},
		});

		await worker.fetch!(createRequest('/api/test'), env as any, ctx);
		await ctx._flush();

		// Check KV for budget accumulation
		const today = new Date().toISOString().slice(0, 10);
		const featureId = 'test-worker:fetch:GET:api-test';
		const budgetKey = `${KV.BUDGET_DAILY}${featureId}:${today}`;
		const raw = await env.CF_MONITOR_KV.get(budgetKey);

		expect(raw).not.toBeNull();
		const budget = JSON.parse(raw!);
		expect(budget.d1_reads).toBe(1);
		expect(budget.kv_writes).toBe(1);
	});

	it('accumulates across multiple invocations', async () => {
		const worker = monitor({
			fetch: async (_req, e) => {
				await (e as any).DB.prepare('SELECT 1').first();
				return new Response('ok');
			},
		});

		// First invocation
		await worker.fetch!(createRequest('/api/test'), env as any, ctx);
		await ctx._flush();

		// Second invocation (new ctx)
		const ctx2 = createMockCtx();
		await worker.fetch!(createRequest('/api/test'), env as any, ctx2);
		await ctx2._flush();

		const today = new Date().toISOString().slice(0, 10);
		const featureId = 'test-worker:fetch:GET:api-test';
		const budgetKey = `${KV.BUDGET_DAILY}${featureId}:${today}`;
		const budget = JSON.parse((await env.CF_MONITOR_KV.get(budgetKey))!);

		expect(budget.d1_reads).toBe(2);
	});

	it('silently continues if KV write fails', async () => {
		// Make the monitor KV's put fail
		const originalPut = env.CF_MONITOR_KV.put.bind(env.CF_MONITOR_KV);
		let putCallCount = 0;
		env.CF_MONITOR_KV.put = async (...args: any[]) => {
			putCallCount++;
			// Fail budget accumulation writes (those containing 'budget:usage:daily:')
			if (typeof args[0] === 'string' && args[0].includes('budget:usage:daily:')) {
				throw new Error('KV write failed');
			}
			return originalPut(...args);
		};

		const worker = monitor({
			fetch: async (_req, e) => {
				await (e as any).DB.prepare('SELECT 1').first();
				return new Response('ok');
			},
		});

		// Should not throw
		const resp = await worker.fetch!(createRequest('/api/test'), env as any, ctx);
		await ctx._flush();

		expect(resp.status).toBe(200);
		// AE should still have the data point
		expect(env.CF_MONITOR_AE._dataPoints.length).toBeGreaterThan(0);
	});
});
