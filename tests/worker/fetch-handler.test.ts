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

	it('GET endpoints include CORS headers', async () => {
		const env = createMockMonitorWorkerEnv();
		const resp = await handleFetch(createRequest('/_health'), env, createMockCtx());

		expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(resp.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
	});

	it('OPTIONS returns 204 with CORS headers', async () => {
		const env = createMockMonitorWorkerEnv();
		const req = new Request('http://localhost/_health', { method: 'OPTIONS' });
		const resp = await handleFetch(req, env, createMockCtx());

		expect(resp.status).toBe(204);
		expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(resp.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
		expect(resp.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
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

	// =========================================================================
	// AI Gateway routes (v0.4.0)
	// =========================================================================

	it('GET /usage/ai-gateway returns no_data when KV blob missing', async () => {
		const env = createMockMonitorWorkerEnv();
		const resp = await handleFetch(createRequest('/usage/ai-gateway'), env, createMockCtx());

		expect(resp.status).toBe(200);
		const body = await resp.json() as Record<string, unknown>;
		expect(body.status).toBe('no_data');
		expect(body.account).toBe('test-account');
	});

	it('GET /usage/ai-gateway returns snapshot when KV blob present', async () => {
		const env = createMockMonitorWorkerEnv();
		const today = new Date().toISOString().slice(0, 10);
		const snapshot = {
			date: today,
			gateways: {
				platform: {
					providers: {
						openai: {
							models: {
								'gpt-4o': { requests: 5, tokens_in: 250, tokens_out: 125, cost: 0.075, cached: 1, errors: 0, p50_duration_ms: 320 },
							},
						},
					},
				},
			},
			totals: { requests: 5, tokens_in: 250, tokens_out: 125, cost: 0.075, cached: 1, errors: 0 },
			lastUpdated: Date.now(),
			disclaimer: 'test',
		};
		await env.CF_MONITOR_KV.put(`${KV.USAGE_ACCOUNT_AI_GATEWAY}${today}`, JSON.stringify(snapshot));

		const resp = await handleFetch(createRequest('/usage/ai-gateway'), env, createMockCtx());
		expect(resp.status).toBe(200);
		const body = await resp.json() as { status: string; snapshot: typeof snapshot };
		expect(body.status).toBe('ok');
		expect(body.snapshot.totals.requests).toBe(5);
	});

	it('GET /usage/ai-gateway rejects malformed date param', async () => {
		const env = createMockMonitorWorkerEnv();
		const resp = await handleFetch(createRequest('/usage/ai-gateway?date=not-a-date'), env, createMockCtx());
		expect(resp.status).toBe(400);
	});

	it('GET /usage/ai-gateway rejects dates older than 32 days', async () => {
		const env = createMockMonitorWorkerEnv();
		const old = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
		const resp = await handleFetch(createRequest(`/usage/ai-gateway?date=${old}`), env, createMockCtx());
		expect(resp.status).toBe(400);
	});

	it('GET /usage merges AI Gateway totals into services.aiGateway when present', async () => {
		const env = createMockMonitorWorkerEnv();
		const today = new Date().toISOString().slice(0, 10);
		// Seed the GraphQL snapshot
		await env.CF_MONITOR_KV.put(`${KV.USAGE_ACCOUNT}${today}`, JSON.stringify({
			collected_at: new Date().toISOString(),
			disclaimer: 'gql',
			services: {
				workers: { requests: 100, cpuMs: 5000 },
			},
		}));
		// Seed the AI Gateway snapshot
		await env.CF_MONITOR_KV.put(`${KV.USAGE_ACCOUNT_AI_GATEWAY}${today}`, JSON.stringify({
			date: today,
			gateways: {},
			totals: { requests: 12, tokens_in: 1000, tokens_out: 500, cost: 0.42, cached: 2, errors: 1 },
			lastUpdated: Date.now(),
			disclaimer: 'ai',
		}));

		const resp = await handleFetch(createRequest('/usage'), env, createMockCtx());
		const body = await resp.json() as { usage: { services: Record<string, Record<string, number>> } };
		expect(body.usage.services.aiGateway).toEqual({
			requests: 12,
			tokens_in: 1000,
			tokens_out: 500,
			cost: 0.42,
			cached: 2,
			errors: 1,
		});
		expect(body.usage.services.workers).toEqual({ requests: 100, cpuMs: 5000 });
	});

	it('GET /usage backward-compat invariant when no Tier-2 KV blobs are present', async () => {
		// With NO queues_realtime / pages / vectorize_indexes blobs seeded, the response must still
		// carry every Phase-1 field (byte-identical) and the new optional fields are null.
		const env = createMockMonitorWorkerEnv();
		const resp = await handleFetch(createRequest('/usage'), env, createMockCtx());
		const body = await resp.json() as Record<string, unknown>;
		expect(resp.status).toBe(200);
		expect(body).toHaveProperty('account');
		expect(body).toHaveProperty('plan');
		expect(body).toHaveProperty('allowances');
		expect(body).toHaveProperty('disclaimer');
		expect(body).toHaveProperty('timestamp');
		expect(typeof body.timestamp).toBe('number');
		// Tier-2 additions: present as keys but null when no blobs.
		expect(body.queues_realtime).toBeNull();
		expect(body.pages).toBeNull();
		expect(body.vectorize_indexes).toBeNull();
	});

	it('GET /usage carries the documented confidence labels for every visible section', async () => {
		const env = createMockMonitorWorkerEnv();
		const resp = await handleFetch(createRequest('/usage'), env, createMockCtx());
		const body = await resp.json() as { confidence: Record<string, string> };
		expect(body.confidence).toEqual({
			workers: 'analytics_estimate',
			d1: 'analytics_estimate',
			kv: 'analytics_estimate',
			r2: 'analytics_estimate',
			durableObjects: 'analytics_estimate',
			aiGateway: 'billing_authoritative',
			plan: 'billing_authoritative',
			queues_realtime: 'runtime_metered',
			pages: 'runtime_metered',
			vectorize_indexes: 'runtime_metered',
			billable_usage_dashboard: 'dashboard_documented_no_public_api',
			budget_alert: 'alert_only',
		});
	});

	it('GET /usage hydrates the opt-in budget_alert subscription when registered', async () => {
		const env = createMockMonitorWorkerEnv();
		await env.CF_MONITOR_KV.put(KV.CONFIG_BUDGET_ALERT, JSON.stringify({
			policy_id: 'pol-abc-123',
			threshold: 100,
			alert_type: 'billing_budget_alert',
			label: 'alert_only',
			recipient: 'email',
			registered_at: '2026-05-28T00:00:00Z',
			dashboard_threshold_url: 'https://dash.cloudflare.com/?to=/:account/billing/billable-usage',
		}));
		const resp = await handleFetch(createRequest('/usage'), env, createMockCtx());
		const body = await resp.json() as { budget_alert: { policy_id: string; label: string; threshold: number } };
		expect(body.budget_alert.policy_id).toBe('pol-abc-123');
		expect(body.budget_alert.label).toBe('alert_only');
		expect(body.budget_alert.threshold).toBe(100);
	});

	it('GET /usage returns null budget_alert when the subscription has not been opt-in created', async () => {
		const env = createMockMonitorWorkerEnv();
		const resp = await handleFetch(createRequest('/usage'), env, createMockCtx());
		const body = await resp.json() as Record<string, unknown>;
		expect(body.budget_alert).toBeNull();
	});

	it('GET /usage hydrates the three Tier-2 snapshots when KV blobs are populated', async () => {
		const env = createMockMonitorWorkerEnv();
		const today = new Date().toISOString().slice(0, 10);
		await env.CF_MONITOR_KV.put(`${KV.USAGE_QUEUE_REALTIME}${today}`, JSON.stringify({
			collected_at: '2026-05-28T00:00:00Z',
			source: 'cloudflare_rest',
			confidence: 'runtime_metered',
			queues: [{ id: 'q1', name: 'tasks', backlog_count: 7 }],
			partial: false,
		}));
		await env.CF_MONITOR_KV.put(`${KV.USAGE_PAGES_DISCOVERY}${today}`, JSON.stringify({
			collected_at: '2026-05-28T00:00:00Z',
			source: 'cloudflare_rest',
			confidence: 'runtime_metered',
			projects: [{ name: 'marketing', functions_usage: 'unknown' }],
			partial: false,
		}));
		await env.CF_MONITOR_KV.put(`${KV.USAGE_VECTORIZE_DISCOVERY}${today}`, JSON.stringify({
			collected_at: '2026-05-28T00:00:00Z',
			source: 'cloudflare_rest',
			confidence: 'runtime_metered',
			indexes: [{ name: 'embeddings', dimensions: 1536, metric: 'cosine' }],
			partial: false,
			caveat: 'Per-index vector counts not collected — would require paginating list_vectors per index, which risks CF API rate-limit cost. Metadata only this pass.',
		}));

		const resp = await handleFetch(createRequest('/usage'), env, createMockCtx());
		const body = await resp.json() as {
			queues_realtime: { queues: Array<{ id: string }> };
			pages: { projects: Array<{ name: string; functions_usage: string }> };
			vectorize_indexes: { indexes: Array<{ name: string }>; partial: boolean };
		};
		expect(body.queues_realtime.queues[0].id).toBe('q1');
		expect(body.pages.projects[0]).toMatchObject({ name: 'marketing', functions_usage: 'unknown' });
		expect(body.vectorize_indexes.indexes[0].name).toBe('embeddings');
		expect(body.vectorize_indexes.partial).toBe(false);
	});

	it('GET /protection returns a coverage report with CORS + the expected shape (auth-required)', async () => {
		// /protection is auth-required by default (Phase 9). Use the admin token.
		const env = createMockMonitorWorkerEnv({ ADMIN_TOKEN: 'test-admin-token' });
		const resp = await handleFetch(
			new Request('http://localhost/protection', { headers: { Authorization: 'Bearer test-admin-token' } }),
			env,
			createMockCtx(),
		);
		expect(resp.status).toBe(200);
		expect(resp.headers.get('access-control-allow-origin')).toBe('*');
		const body = await resp.json() as {
			summary: { score: number };
			findings: Array<{ id: string; severity: string; status: string }>;
			confidence: { overall: string; billing: string };
			caveats: string[];
		};
		expect(body.summary.score).toBeGreaterThanOrEqual(0);
		expect(body.summary.score).toBeLessThanOrEqual(100);
		expect(body.findings.length).toBeGreaterThan(0);
		expect(body.caveats.length).toBeGreaterThan(0);
		expect(body.confidence.billing).toBe('dashboard_documented_no_public_api');
	});

	// =========================================================================
	// Phase 9 — Security + Read Endpoint Hardening
	// =========================================================================

	it('GET /protection returns 401 + WWW-Authenticate when no token is sent', async () => {
		const env = createMockMonitorWorkerEnv({ ADMIN_TOKEN: 'test-admin-token' });
		const resp = await handleFetch(createRequest('/protection'), env, createMockCtx());
		expect(resp.status).toBe(401);
		expect(resp.headers.get('WWW-Authenticate')).toMatch(/^Bearer/);
		expect(resp.headers.get('access-control-allow-origin')).toBe('*');
		const body = await resp.json() as Record<string, unknown>;
		expect(body).toEqual({ error: 'Unauthorized' });
	});

	it('GET /protection returns 401 when an invalid token is sent', async () => {
		const env = createMockMonitorWorkerEnv({ ADMIN_TOKEN: 'real-token' });
		const resp = await handleFetch(
			new Request('http://localhost/protection', { headers: { Authorization: 'Bearer wrong-token' } }),
			env,
			createMockCtx(),
		);
		expect(resp.status).toBe(401);
	});

	it('GET /protection returns a redacted body when CF_MONITOR_PROTECTION_PUBLIC=redacted and no auth', async () => {
		const env = createMockMonitorWorkerEnv({
			ADMIN_TOKEN: 'test-admin-token',
			CF_MONITOR_PROTECTION_PUBLIC: 'redacted',
		});
		const resp = await handleFetch(createRequest('/protection'), env, createMockCtx());
		expect(resp.status).toBe(200);
		const body = await resp.json() as { account: string; summary: { score: number }; findings: Array<{ resource_name?: string }> };
		expect(body.account).toBe('<REDACTED>');
		expect(body.summary.score).toBeGreaterThanOrEqual(0);
		// No finding should leak a resource_name (Phase 9 redaction).
		expect(body.findings.every((f) => f.resource_name === undefined || f.resource_name === '<REDACTED>')).toBe(true);
	});

	it('GET /usage stays public by default (Phase 4 backward-compat invariant)', async () => {
		const env = createMockMonitorWorkerEnv();
		const resp = await handleFetch(createRequest('/usage'), env, createMockCtx());
		expect(resp.status).toBe(200);
	});

	it('GET /usage returns 401 when CF_MONITOR_REQUIRE_AUTH_FOR_READS=true and no token', async () => {
		const env = createMockMonitorWorkerEnv({
			ADMIN_TOKEN: 'test-admin-token',
			CF_MONITOR_REQUIRE_AUTH_FOR_READS: 'true',
		});
		const resp = await handleFetch(createRequest('/usage'), env, createMockCtx());
		expect(resp.status).toBe(401);
		expect(resp.headers.get('WWW-Authenticate')).toMatch(/^Bearer/);
	});

	it('GET /usage returns 200 when CF_MONITOR_REQUIRE_AUTH_FOR_READS=true and valid token is sent', async () => {
		const env = createMockMonitorWorkerEnv({
			ADMIN_TOKEN: 'test-admin-token',
			CF_MONITOR_REQUIRE_AUTH_FOR_READS: 'true',
		});
		const resp = await handleFetch(
			new Request('http://localhost/usage', { headers: { Authorization: 'Bearer test-admin-token' } }),
			env,
			createMockCtx(),
		);
		expect(resp.status).toBe(200);
	});

	it('GET /_health stays public even when CF_MONITOR_REQUIRE_AUTH_FOR_READS=true, but drops the account name', async () => {
		const env = createMockMonitorWorkerEnv({
			ADMIN_TOKEN: 'test-admin-token',
			CF_MONITOR_REQUIRE_AUTH_FOR_READS: 'true',
		});
		const resp = await handleFetch(createRequest('/_health'), env, createMockCtx());
		expect(resp.status).toBe(200);
		const body = await resp.json() as Record<string, unknown>;
		expect(body.healthy).toBe(true);
		expect(body.account).toBeUndefined(); // No leakage of account name to anonymous probes
	});

	it('all owner_only endpoints return 401 when the flag is set and no token is sent', async () => {
		const env = createMockMonitorWorkerEnv({
			ADMIN_TOKEN: 'test-admin-token',
			CF_MONITOR_REQUIRE_AUTH_FOR_READS: 'true',
		});
		const paths = ['/status', '/errors', '/budgets', '/workers', '/plan', '/usage', '/self-health'];
		for (const p of paths) {
			const resp = await handleFetch(createRequest(p), env, createMockCtx());
			expect(resp.status, `${p} should require auth when flag is set`).toBe(401);
		}
	});

	it('OPTIONS preflight stays public and CORS-permissive even with auth flag set', async () => {
		const env = createMockMonitorWorkerEnv({
			ADMIN_TOKEN: 'test-admin-token',
			CF_MONITOR_REQUIRE_AUTH_FOR_READS: 'true',
		});
		const req = new Request('http://localhost/usage', { method: 'OPTIONS' });
		const resp = await handleFetch(req, env, createMockCtx());
		expect(resp.status).toBe(204);
		expect(resp.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
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
