import { describe, it, expect, vi } from 'vitest';
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
		expect(body.accountId).toBeUndefined(); // stripped for security (M6)
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

	it('GET /budgets shows "tripped" for STOP circuit breakers', async () => {
		const env = createMockMonitorWorkerEnv();
		await env.CF_MONITOR_KV.put(`${KV.CB_FEATURE}my-feature`, 'STOP');
		await env.CF_MONITOR_KV.put(`${KV.CB_FEATURE}my-feature:reason`, 'Budget exceeded');

		const resp = await handleFetch(createRequest('/budgets'), env, createMockCtx());
		const body = await resp.json() as { circuitBreakers: Array<{ featureId: string; status: string }>; count: number };

		expect(resp.status).toBe(200);
		expect(body.count).toBe(1);
		expect(body.circuitBreakers[0].featureId).toBe('my-feature');
		expect(body.circuitBreakers[0].status).toBe('tripped');
	});

	it('GET /budgets shows "resetting" for GO circuit breakers', async () => {
		const env = createMockMonitorWorkerEnv();
		await env.CF_MONITOR_KV.put(`${KV.CB_FEATURE}my-feature`, 'GO');

		const resp = await handleFetch(createRequest('/budgets'), env, createMockCtx());
		const body = await resp.json() as { circuitBreakers: Array<{ featureId: string; status: string }> };

		expect(body.circuitBreakers).toHaveLength(1);
		expect(body.circuitBreakers[0].status).toBe('resetting');
	});

	it('GET /budgets shows "tripped" when KV get returns null (edge cache inconsistency)', async () => {
		const env = createMockMonitorWorkerEnv();
		await env.CF_MONITOR_KV.put(`${KV.CB_FEATURE}stale-feature`, 'STOP');

		// Simulate edge cache inconsistency: list() finds key but get() returns null
		const originalGet = env.CF_MONITOR_KV.get.bind(env.CF_MONITOR_KV);
		vi.spyOn(env.CF_MONITOR_KV, 'get').mockImplementation(async (key: string, ...args: unknown[]) => {
			if (key === `${KV.CB_FEATURE}stale-feature`) return null;
			return (originalGet as Function)(key, ...args);
		});

		const resp = await handleFetch(createRequest('/budgets'), env, createMockCtx());
		const body = await resp.json() as { circuitBreakers: Array<{ featureId: string; status: string }> };

		expect(body.circuitBreakers).toHaveLength(1);
		expect(body.circuitBreakers[0].featureId).toBe('stale-feature');
		expect(body.circuitBreakers[0].status).toBe('tripped');
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

	it('POST to non-webhook path returns 404', async () => {
		const env = createMockMonitorWorkerEnv();
		const resp = await handleFetch(createRequest('/status', 'POST'), env, createMockCtx());
		expect(resp.status).toBe(404);
	});

	it('PUT returns 405', async () => {
		const env = createMockMonitorWorkerEnv();
		const resp = await handleFetch(createRequest('/status', 'PUT'), env, createMockCtx());
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

	it('GET /self-health returns 200 with health status', async () => {
		const env = createMockMonitorWorkerEnv();
		const resp = await handleFetch(createRequest('/self-health'), env, createMockCtx());

		expect(resp.status).toBe(200);
		const body = await resp.json() as Record<string, unknown>;
		expect(body).toHaveProperty('healthy');
		expect(body).toHaveProperty('handlers');
		expect(body).toHaveProperty('errors');
		expect(body).toHaveProperty('staleCrons');
	});

	it('GET /self-health returns 503 when stale cron detected', async () => {
		const env = createMockMonitorWorkerEnv();
		const staleTime = new Date(Date.now() - 7_200_000).toISOString();
		await env.CF_MONITOR_KV.put('self:v1:cron:last_run', JSON.stringify({
			'gap-detection': { lastRun: staleTime, durationMs: 10, success: true },
		}));

		const resp = await handleFetch(createRequest('/self-health'), env, createMockCtx());
		expect(resp.status).toBe(503);
	});
});

describe('GitHub webhook (#22)', () => {
	const webhookSecret = 'test-secret-123';

	async function computeSignature(body: string, secret: string): Promise<string> {
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			'raw',
			encoder.encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
		return `sha256=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
	}

	function createWebhookRequest(payload: object, signature: string, event: string = 'issues'): Request {
		const body = JSON.stringify(payload);
		return new Request('http://localhost/webhooks/github', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Hub-Signature-256': signature,
				'X-GitHub-Event': event,
			},
			body,
		});
	}

	const mockIssueBody = `## Error Details

| Field | Value |
|-------|-------|
| **Worker** | \`my-api\` |
| **Fingerprint** | \`abc123def456\` |`;

	it('rejects requests without signature', async () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).GITHUB_WEBHOOK_SECRET = webhookSecret;

		const req = new Request('http://localhost/webhooks/github', {
			method: 'POST',
			body: '{}',
		});
		const resp = await handleFetch(req, env, createMockCtx());
		expect(resp.status).toBe(401);
	});

	it('rejects requests with invalid signature', async () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).GITHUB_WEBHOOK_SECRET = webhookSecret;

		const req = createWebhookRequest({}, 'sha256=invalidhex');
		const resp = await handleFetch(req, env, createMockCtx());
		expect(resp.status).toBe(401);
	});

	it('removes fingerprint on issues.closed', async () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).GITHUB_WEBHOOK_SECRET = webhookSecret;

		// Pre-set a fingerprint
		await env.CF_MONITOR_KV.put(`${KV.ERR_FINGERPRINT}abc123def456`, 'https://github.com/test/issues/1');

		const payload = {
			action: 'closed',
			issue: {
				number: 1,
				html_url: 'https://github.com/test/issues/1',
				body: mockIssueBody,
				labels: [{ name: 'cf:error:exception' }],
			},
		};

		const body = JSON.stringify(payload);
		const sig = await computeSignature(body, webhookSecret);
		const req = createWebhookRequest(payload, sig);
		const resp = await handleFetch(req, env, createMockCtx());

		expect(resp.status).toBe(200);
		const result = await resp.json() as Record<string, unknown>;
		expect(result.action).toBe('fingerprint-removed');

		// Fingerprint should be gone
		const fp = await env.CF_MONITOR_KV.get(`${KV.ERR_FINGERPRINT}abc123def456`);
		expect(fp).toBeNull();
	});

	it('restores fingerprint on issues.reopened', async () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).GITHUB_WEBHOOK_SECRET = webhookSecret;

		const payload = {
			action: 'reopened',
			issue: {
				number: 1,
				html_url: 'https://github.com/test/issues/1',
				body: mockIssueBody,
				labels: [{ name: 'cf:error:exception' }],
			},
		};

		const body = JSON.stringify(payload);
		const sig = await computeSignature(body, webhookSecret);
		const req = createWebhookRequest(payload, sig);
		const resp = await handleFetch(req, env, createMockCtx());

		expect(resp.status).toBe(200);
		const result = await resp.json() as Record<string, unknown>;
		expect(result.action).toBe('fingerprint-restored');

		// Fingerprint should be restored
		const fp = await env.CF_MONITOR_KV.get(`${KV.ERR_FINGERPRINT}abc123def456`);
		expect(fp).toBe('https://github.com/test/issues/1');
	});

	it('mutes fingerprint on issues.labeled with cf:muted', async () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).GITHUB_WEBHOOK_SECRET = webhookSecret;

		const payload = {
			action: 'labeled',
			label: { name: 'cf:muted' },
			issue: {
				number: 1,
				html_url: 'https://github.com/test/issues/1',
				body: mockIssueBody,
				labels: [{ name: 'cf:error:exception' }, { name: 'cf:muted' }],
			},
		};

		const body = JSON.stringify(payload);
		const sig = await computeSignature(body, webhookSecret);
		const req = createWebhookRequest(payload, sig);
		const resp = await handleFetch(req, env, createMockCtx());

		expect(resp.status).toBe(200);
		const result = await resp.json() as Record<string, unknown>;
		expect(result.action).toBe('fingerprint-muted');

		const fp = await env.CF_MONITOR_KV.get(`${KV.ERR_FINGERPRINT}abc123def456`);
		expect(fp).toContain('muted:');
	});

	it('skips non-cf-monitor issues', async () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).GITHUB_WEBHOOK_SECRET = webhookSecret;

		const payload = {
			action: 'closed',
			issue: {
				number: 2,
				html_url: 'https://github.com/test/issues/2',
				body: 'Regular issue',
				labels: [{ name: 'bug' }],
			},
		};

		const body = JSON.stringify(payload);
		const sig = await computeSignature(body, webhookSecret);
		const req = createWebhookRequest(payload, sig);
		const resp = await handleFetch(req, env, createMockCtx());

		const result = await resp.json() as Record<string, unknown>;
		expect(result.skipped).toBe(true);
	});
});
