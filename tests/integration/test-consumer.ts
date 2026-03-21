/**
 * Enhanced test consumer worker for comprehensive integration tests.
 * 10 routes exercising: multi-path feature IDs, KV proxy tracking,
 * error capture, soft errors, warnings, and POST methods.
 */

import { monitor } from '../../src/index.js';

interface ConsumerEnv {
	CF_MONITOR_KV: KVNamespace;
	CF_MONITOR_AE: AnalyticsEngineDataset;
	TEST_KV: KVNamespace;
	WORKER_NAME: string;
}

export default monitor<ConsumerEnv>({
	workerName: 'test-cf-monitor-consumer',
	fetch: async (request, env) => {
		const url = new URL(request.url);
		const path = url.pathname;

		// Happy path — basic telemetry
		if (path === '/api/test') {
			return Response.json({ ok: true, timestamp: Date.now() });
		}

		// Throw exception — tests error capture pipeline (tail handler)
		if (path === '/api/error') {
			throw new Error('Intentional test error');
		}

		// Numeric segment in path — tests feature ID normalisation
		// Feature ID should strip '123': test-cf-monitor-consumer:fetch:GET:api-users
		if (path.startsWith('/api/users/')) {
			return Response.json({ ok: true, route: 'users', path });
		}

		// POST method — tests multi-method feature IDs
		if (path === '/api/submit' && request.method === 'POST') {
			return Response.json({ ok: true, method: 'POST' });
		}

		// KV read via proxy — tests KV binding tracking
		if (path === '/api/kv-read') {
			const value = await env.TEST_KV.get('test-key');
			return Response.json({ ok: true, kvValue: value });
		}

		// Soft error — logs console.error() but returns 200 (ok outcome + error log)
		if (path === '/api/soft-error') {
			console.error('Soft error: test soft error for integration testing');
			return Response.json({ ok: true, softError: true });
		}

		// Warning — logs console.warn() for warning digest
		if (path === '/api/warning') {
			console.warn('Test warning for integration testing');
			return Response.json({ ok: true, warning: true });
		}

		// Distinct error types for tail pipeline testing (#33)
		if (path === '/api/error-type-a') {
			throw new TypeError('Integration test error type A: null reference');
		}
		if (path === '/api/error-type-b') {
			throw new RangeError('Integration test error type B: index out of bounds');
		}

		// 10 consecutive KV reads for proxy tracking verification (#40)
		if (path === '/api/limit-test') {
			for (let i = 0; i < 10; i++) {
				await env.TEST_KV.get(`limit-test-key-${i}`);
			}
			return Response.json({ ok: true, reads: 10 });
		}

		// Slow response — tests cpuMs tracking
		if (path === '/api/slow') {
			const start = Date.now();
			while (Date.now() - start < 100) {
				// Burn ~100ms of CPU
			}
			return Response.json({ ok: true, delayMs: Date.now() - start });
		}

		return new Response('Not found', { status: 404 });
	},
});
