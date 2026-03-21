import { KV } from '../constants.js';
import type { MonitorWorkerEnv } from '../types.js';

/**
 * API endpoints for the cf-monitor worker.
 *
 * Routes:
 * - GET /status   → overall health, worker count, CB states
 * - GET /errors   → recent error fingerprints with GitHub issue links
 * - GET /budgets  → budget utilisation status
 * - GET /workers  → discovered workers
 * - GET /_health  → simple health check for Gatus
 */
export async function handleFetch(
	request: Request,
	env: MonitorWorkerEnv,
	_ctx: ExecutionContext
): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	if (request.method !== 'GET') {
		return Response.json({ error: 'Method not allowed' }, { status: 405 });
	}

	try {
		if (path === '/_health') return handleHealth(env);
		if (path === '/status') return handleStatus(env);
		if (path === '/errors') return handleErrors(env);
		if (path === '/budgets') return handleBudgets(env);
		if (path === '/workers') return handleWorkers(env);

		return Response.json({ error: 'Not found' }, { status: 404 });
	} catch (err) {
		console.error(`[cf-monitor:fetch] ${path} error: ${err}`);
		return Response.json({ error: 'Internal error' }, { status: 500 });
	}
}

// =============================================================================
// ROUTE HANDLERS
// =============================================================================

async function handleHealth(env: MonitorWorkerEnv): Promise<Response> {
	return Response.json({
		healthy: true,
		account: env.ACCOUNT_NAME,
		timestamp: Date.now(),
	});
}

async function handleStatus(env: MonitorWorkerEnv): Promise<Response> {
	const [accountCb, globalCb, workerList] = await Promise.all([
		env.CF_MONITOR_KV.get(KV.CB_ACCOUNT),
		env.CF_MONITOR_KV.get(KV.CB_GLOBAL),
		env.CF_MONITOR_KV.get(KV.WORKER_LIST),
	]);

	const workers = workerList ? JSON.parse(workerList) as string[] : [];

	return Response.json({
		account: env.ACCOUNT_NAME,
		accountId: env.CF_ACCOUNT_ID,
		healthy: !globalCb && accountCb !== 'paused',
		circuitBreaker: {
			global: globalCb === 'true' ? 'active' : 'inactive',
			account: accountCb ?? 'active',
		},
		workers: {
			count: workers.length,
			names: workers,
		},
		github: env.GITHUB_REPO ? { repo: env.GITHUB_REPO, configured: true } : { configured: false },
		slack: { configured: !!env.SLACK_WEBHOOK_URL },
		timestamp: Date.now(),
	});
}

async function handleErrors(env: MonitorWorkerEnv): Promise<Response> {
	// List recent error fingerprints from KV (prefix scan)
	const errors: Array<{ fingerprint: string; issueUrl: string }> = [];

	const list = await env.CF_MONITOR_KV.list({ prefix: KV.ERR_FINGERPRINT, limit: 50 });
	for (const key of list.keys) {
		const issueUrl = await env.CF_MONITOR_KV.get(key.name);
		if (issueUrl) {
			const fingerprint = key.name.replace(KV.ERR_FINGERPRINT, '');
			errors.push({ fingerprint, issueUrl });
		}
	}

	return Response.json({
		account: env.ACCOUNT_NAME,
		errors,
		count: errors.length,
		timestamp: Date.now(),
	});
}

async function handleBudgets(env: MonitorWorkerEnv): Promise<Response> {
	// List active circuit breakers
	const breakers: Array<{ featureId: string; status: string }> = [];

	const list = await env.CF_MONITOR_KV.list({ prefix: KV.CB_FEATURE, limit: 100 });
	for (const key of list.keys) {
		if (key.name.endsWith(':reason')) continue;
		const status = await env.CF_MONITOR_KV.get(key.name);
		const featureId = key.name.replace(KV.CB_FEATURE, '');
		breakers.push({ featureId, status: status ?? 'unknown' });
	}

	return Response.json({
		account: env.ACCOUNT_NAME,
		circuitBreakers: breakers,
		count: breakers.length,
		timestamp: Date.now(),
	});
}

async function handleWorkers(env: MonitorWorkerEnv): Promise<Response> {
	const workerList = await env.CF_MONITOR_KV.get(KV.WORKER_LIST);
	const workers = workerList ? JSON.parse(workerList) as string[] : [];

	return Response.json({
		account: env.ACCOUNT_NAME,
		workers,
		count: workers.length,
		timestamp: Date.now(),
	});
}
