import { KV } from '../constants.js';
import type { MonitorWorkerEnv } from '../types.js';
import { collectAccountMetrics } from './crons/collect-metrics.js';
import { checkBudgets } from './crons/budget-check.js';
import { detectGaps } from './crons/gap-detection.js';
import { detectCostSpikes } from './crons/cost-spike.js';
import { discoverWorkers } from './crons/worker-discovery.js';
import { runDailyRollup } from './crons/daily-rollup.js';
import { runSyntheticHealthCheck } from './crons/synthetic-health.js';

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

	// POST routes
	if (request.method === 'POST') {
		if (path === '/webhooks/github') return handleGitHubWebhook(request, env);
		if (path.startsWith('/admin/cron/')) return handleAdminCronTrigger(path, env);
		return Response.json({ error: 'Not found' }, { status: 404 });
	}

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

// =============================================================================
// ADMIN: MANUAL CRON TRIGGERS (for testing)
// =============================================================================

const CRON_HANDLERS: Record<string, (env: MonitorWorkerEnv) => Promise<void>> = {
	'gap-detection': detectGaps,
	'budget-check': checkBudgets,
	'cost-spike': detectCostSpikes,
	'metrics': collectAccountMetrics,
	'synthetic-health': runSyntheticHealthCheck,
	'worker-discovery': discoverWorkers,
	'daily-rollup': runDailyRollup,
};

async function handleAdminCronTrigger(path: string, env: MonitorWorkerEnv): Promise<Response> {
	const cronName = path.replace('/admin/cron/', '');
	const handler = CRON_HANDLERS[cronName];

	if (!handler) {
		return Response.json({
			error: `Unknown cron: ${cronName}`,
			available: Object.keys(CRON_HANDLERS),
		}, { status: 400 });
	}

	const start = Date.now();
	try {
		await handler(env);
		return Response.json({
			ok: true,
			cron: cronName,
			durationMs: Date.now() - start,
		});
	} catch (err) {
		return Response.json({
			ok: false,
			cron: cronName,
			error: String(err),
			durationMs: Date.now() - start,
		}, { status: 500 });
	}
}

// =============================================================================
// GITHUB WEBHOOK (#22)
// =============================================================================

async function handleGitHubWebhook(request: Request, env: MonitorWorkerEnv): Promise<Response> {
	const secret = (env as unknown as Record<string, unknown>).GITHUB_WEBHOOK_SECRET as string | undefined;
	if (!secret) {
		return Response.json({ error: 'Webhook secret not configured' }, { status: 500 });
	}

	// Verify HMAC-SHA256 signature
	const signature = request.headers.get('X-Hub-Signature-256');
	if (!signature) {
		return Response.json({ error: 'Missing signature' }, { status: 401 });
	}

	const body = await request.text();
	const isValid = await verifyHmacSha256(body, signature, secret);
	if (!isValid) {
		return Response.json({ error: 'Invalid signature' }, { status: 401 });
	}

	const event = request.headers.get('X-GitHub-Event');
	if (event !== 'issues') {
		return Response.json({ ok: true, skipped: true, reason: `Unhandled event: ${event}` });
	}

	const payload = JSON.parse(body) as GitHubWebhookPayload;
	const action = payload.action;
	const issue = payload.issue;

	if (!issue) {
		return Response.json({ ok: true, skipped: true, reason: 'No issue in payload' });
	}

	// Only process issues created by cf-monitor (look for cf:error:* labels)
	const hasCfLabel = issue.labels?.some((l: { name: string }) => l.name.startsWith('cf:'));
	if (!hasCfLabel) {
		return Response.json({ ok: true, skipped: true, reason: 'Not a cf-monitor issue' });
	}

	try {
		if (action === 'closed') {
			// Remove fingerprint from KV — allows re-creation if error recurs
			await removeFingerprint(env, issue);
			return Response.json({ ok: true, action: 'fingerprint-removed' });
		}

		if (action === 'reopened') {
			// Re-add fingerprint to KV — suppresses duplicate creation
			await restoreFingerprint(env, issue);
			return Response.json({ ok: true, action: 'fingerprint-restored' });
		}

		if (action === 'labeled') {
			const label = payload.label?.name;
			if (label === 'cf:muted') {
				// Store fingerprint as muted (longer TTL, skipped by tail handler)
				await muteFingerprint(env, issue);
				return Response.json({ ok: true, action: 'fingerprint-muted' });
			}
		}

		return Response.json({ ok: true, skipped: true, reason: `Unhandled action: ${action}` });
	} catch (err) {
		console.error(`[cf-monitor:webhook] Error processing ${action}: ${err}`);
		return Response.json({ error: 'Processing failed' }, { status: 500 });
	}
}

/** Verify HMAC-SHA256 signature from GitHub webhook. */
async function verifyHmacSha256(body: string, signature: string, secret: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
	const computed = `sha256=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')}`;

	// Timing-safe comparison
	if (computed.length !== signature.length) return false;
	let result = 0;
	for (let i = 0; i < computed.length; i++) {
		result |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
	}
	return result === 0;
}

/** Extract fingerprint from issue body and remove from KV. */
async function removeFingerprint(env: MonitorWorkerEnv, issue: GitHubIssue): Promise<void> {
	const fingerprint = extractFingerprint(issue);
	if (fingerprint) {
		await env.CF_MONITOR_KV.delete(`${KV.ERR_FINGERPRINT}${fingerprint}`);
	}
}

/** Re-add fingerprint → issue URL mapping to KV. */
async function restoreFingerprint(env: MonitorWorkerEnv, issue: GitHubIssue): Promise<void> {
	const fingerprint = extractFingerprint(issue);
	if (fingerprint) {
		await env.CF_MONITOR_KV.put(
			`${KV.ERR_FINGERPRINT}${fingerprint}`,
			issue.html_url,
			{ expirationTtl: 7_776_000 } // 90 days
		);
	}
}

/** Store fingerprint as muted (prevents future alerts). */
async function muteFingerprint(env: MonitorWorkerEnv, issue: GitHubIssue): Promise<void> {
	const fingerprint = extractFingerprint(issue);
	if (fingerprint) {
		await env.CF_MONITOR_KV.put(
			`${KV.ERR_FINGERPRINT}${fingerprint}`,
			`muted:${issue.html_url}`,
			{ expirationTtl: 7_776_000 }
		);
	}
}

/** Extract fingerprint from issue body (looks for `| **Fingerprint** | `...` |` table row). */
function extractFingerprint(issue: GitHubIssue): string | null {
	const body = issue.body ?? '';
	const match = body.match(/\*\*Fingerprint\*\*\s*\|\s*`([^`]+)`/);
	return match ? match[1] : null;
}

interface GitHubWebhookPayload {
	action: string;
	issue?: GitHubIssue;
	label?: { name: string };
}

interface GitHubIssue {
	number: number;
	html_url: string;
	body?: string;
	labels?: Array<{ name: string }>;
}
