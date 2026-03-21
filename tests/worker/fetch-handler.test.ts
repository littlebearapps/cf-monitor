import { describe, it, expect } from 'vitest';
import { handleFetch } from '../../src/worker/fetch-handler.js';
import { KV } from '../../src/constants.js';
import { createMockMonitorWorkerEnv } from '../helpers/mock-env.js';
import { createRequest, createMockCtx } from '../helpers/mock-request.js';

describe('handleFetch', () => {
	it('GET /_health returns 200 with account name', async () => {
		const env = createMockMonitorWorkerEnv();
		const resp = await handleFetch(createRequest('/_health'), env, createMockCtx());

		expect(resp.status).toBe(200);
		const body = await resp.json() as Record<string, unknown>;
		expect(body.healthy).toBe(true);
		expect(body.account).toBe('test-account');
	});

	it('GET /status returns CB states and worker count', async () => {
		const env = createMockMonitorWorkerEnv();
		await env.CF_MONITOR_KV.put(KV.WORKER_LIST, JSON.stringify(['worker-a', 'worker-b']));

		const resp = await handleFetch(createRequest('/status'), env, createMockCtx());
		const body = await resp.json() as Record<string, unknown>;

		expect(resp.status).toBe(200);
		expect((body.workers as Record<string, unknown>).count).toBe(2);
		expect(body.accountId).toBe('test-account-id');
	});

	it('GET /errors lists fingerprints from KV', async () => {
		const env = createMockMonitorWorkerEnv();
		await env.CF_MONITOR_KV.put(`${KV.ERR_FINGERPRINT}abc123`, 'https://github.com/issues/1');
		await env.CF_MONITOR_KV.put(`${KV.ERR_FINGERPRINT}def456`, 'https://github.com/issues/2');

		const resp = await handleFetch(createRequest('/errors'), env, createMockCtx());
		const body = await resp.json() as Record<string, unknown>;

		expect(resp.status).toBe(200);
		expect(body.count).toBe(2);
		expect((body.errors as Array<Record<string, string>>)[0].fingerprint).toBe('abc123');
	});

	it('GET /budgets lists active circuit breakers', async () => {
		const env = createMockMonitorWorkerEnv();
		await env.CF_MONITOR_KV.put(`${KV.CB_FEATURE}my-feature`, 'STOP');
		await env.CF_MONITOR_KV.put(`${KV.CB_FEATURE}my-feature:reason`, 'Budget exceeded');

		const resp = await handleFetch(createRequest('/budgets'), env, createMockCtx());
		const body = await resp.json() as Record<string, unknown>;

		expect(resp.status).toBe(200);
		// Should have 1 CB (reason key is filtered out)
		expect(body.count).toBe(1);
	});

	it('GET /workers returns discovered workers', async () => {
		const env = createMockMonitorWorkerEnv();
		await env.CF_MONITOR_KV.put(KV.WORKER_LIST, JSON.stringify(['api', 'cron']));

		const resp = await handleFetch(createRequest('/workers'), env, createMockCtx());
		const body = await resp.json() as Record<string, unknown>;

		expect(resp.status).toBe(200);
		expect(body.workers).toEqual(['api', 'cron']);
		expect(body.count).toBe(2);
	});

	it('POST returns 405', async () => {
		const env = createMockMonitorWorkerEnv();
		const resp = await handleFetch(createRequest('/status', 'POST'), env, createMockCtx());
		expect(resp.status).toBe(405);
	});

	it('unknown path returns 404', async () => {
		const env = createMockMonitorWorkerEnv();
		const resp = await handleFetch(createRequest('/nonexistent'), env, createMockCtx());
		expect(resp.status).toBe(404);
	});

	it('handles empty KV state gracefully', async () => {
		const env = createMockMonitorWorkerEnv();

		const statusResp = await handleFetch(createRequest('/status'), env, createMockCtx());
		expect(statusResp.status).toBe(200);

		const errorsResp = await handleFetch(createRequest('/errors'), env, createMockCtx());
		const body = await errorsResp.json() as Record<string, unknown>;
		expect(body.count).toBe(0);
	});
});
