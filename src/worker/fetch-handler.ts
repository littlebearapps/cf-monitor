import { KV, PRIORITY_MAP } from '../constants.js';
import type { MonitorWorkerEnv, TailOutcome } from '../types.js';
import { getSelfHealth, checkCronStaleness } from './self-monitor.js';
import { collectAccountMetrics } from './crons/collect-metrics.js';
import { checkBudgets } from './crons/budget-check.js';
import { detectGaps } from './crons/gap-detection.js';
import { detectCostSpikes } from './crons/cost-spike.js';
import { discoverWorkers } from './crons/worker-discovery.js';
import { runDailyRollup } from './crons/daily-rollup.js';
import { runSyntheticHealthCheck } from './crons/synthetic-health.js';
import { tripFeatureCb, resetFeatureCb, setAccountCbStatus } from '../sdk/circuit-breaker.js';
import { computeFingerprint } from './errors/fingerprint.js';
import { matchTransientPattern } from './errors/patterns.js';
import { formatBudgetWarning, formatErrorAlert } from './alerts/slack.js';
import { collectAccountUsage } from './crons/collect-account-usage.js';
import { getPlanOrCached, getBillingPeriodOrCached } from './account/subscriptions.js';
import { getAllowancesForPlan } from './account/plan-allowances.js';

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

		// Admin routes require Bearer token authentication
		if (path.startsWith('/admin/')) {
			if (!verifyAdminToken(request, env)) {
				return Response.json({ error: 'Unauthorized' }, { status: 401 });
			}
			if (path.startsWith('/admin/cron/')) return handleAdminCronTrigger(path, env);
			if (path === '/admin/cb/trip') return handleAdminCbTrip(request, env);
			if (path === '/admin/cb/reset') return handleAdminCbReset(request, env);
			if (path === '/admin/cb/account') return handleAdminCbAccount(request, env);
			if (path === '/admin/test/github-dry-run') return handleGitHubDryRun(request, env);
			if (path === '/admin/test/slack-dry-run') return handleSlackDryRun(request);
		}

		return Response.json({ error: 'Not found' }, { status: 404 });
	}

	if (request.method !== 'GET') {
		return Response.json({ error: 'Method not allowed' }, { status: 405 });
	}

	try {
		if (path === '/_health') return handleHealth(env);
		if (path === '/self-health') return handleSelfHealth(env);
		if (path === '/status') return handleStatus(env);
		if (path === '/errors') return handleErrors(env);
		if (path === '/budgets') return handleBudgets(env);
		if (path === '/workers') return handleWorkers(env);
		if (path === '/plan') return handlePlan(env);
		if (path === '/usage') return handleUsage(env);

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

async function handleSelfHealth(env: MonitorWorkerEnv): Promise<Response> {
	try {
		const status = await getSelfHealth(env);
		return Response.json({
			healthy: status.healthy,
			staleCrons: status.staleCrons,
			errors: status.todayErrors,
			handlers: status.handlerErrors,
			crons: status.crons,
			timestamp: Date.now(),
		}, { status: status.healthy ? 200 : 503 });
	} catch (err) {
		return Response.json({
			healthy: false,
			error: 'Failed to gather self-health',
			timestamp: Date.now(),
		}, { status: 500 });
	}
}

async function handleStatus(env: MonitorWorkerEnv): Promise<Response> {
	const [accountCb, globalCb, workerList, plan] = await Promise.all([
		env.CF_MONITOR_KV.get(KV.CB_ACCOUNT),
		env.CF_MONITOR_KV.get(KV.CB_GLOBAL),
		env.CF_MONITOR_KV.get(KV.WORKER_LIST),
		getPlanOrCached(env),
	]);

	const workers = workerList ? JSON.parse(workerList) as string[] : [];

	return Response.json({
		account: env.ACCOUNT_NAME,
		plan,
		healthy: !globalCb && accountCb !== 'paused',
		circuitBreaker: {
			global: globalCb === 'true' ? 'active' : 'inactive',
			account: accountCb ?? 'active',
		},
		workers: {
			count: workers.length,
		},
		github: { configured: !!env.GITHUB_REPO },
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

async function handlePlan(env: MonitorWorkerEnv): Promise<Response> {
	const [plan, billingPeriod] = await Promise.all([
		getPlanOrCached(env),
		getBillingPeriodOrCached(env),
	]);

	const allowances = getAllowancesForPlan(plan);
	const daysRemaining = billingPeriod
		? Math.max(0, Math.ceil((new Date(billingPeriod.end).getTime() - Date.now()) / 86_400_000))
		: undefined;

	return Response.json({
		account: env.ACCOUNT_NAME,
		plan,
		billingPeriod: billingPeriod ?? undefined,
		daysRemaining,
		allowances,
		timestamp: Date.now(),
	});
}

async function handleUsage(env: MonitorWorkerEnv): Promise<Response> {
	const today = new Date().toISOString().slice(0, 10);
	const [snapshotRaw, plan, billingPeriod] = await Promise.all([
		env.CF_MONITOR_KV.get(`${KV.USAGE_ACCOUNT}${today}`),
		getPlanOrCached(env),
		getBillingPeriodOrCached(env),
	]);

	const allowances = getAllowancesForPlan(plan);
	const snapshot = snapshotRaw ? JSON.parse(snapshotRaw) : null;

	return Response.json({
		account: env.ACCOUNT_NAME,
		plan,
		billingPeriod: billingPeriod ?? undefined,
		allowances,
		usage: snapshot,
		disclaimer: 'Approximate — from CF GraphQL Analytics API. Not authoritative for billing.',
		timestamp: Date.now(),
	});
}

async function handleBudgets(env: MonitorWorkerEnv): Promise<Response> {
	// List active circuit breakers
	const breakers: Array<{ featureId: string; status: string }> = [];

	const [list, billingPeriod] = await Promise.all([
		env.CF_MONITOR_KV.list({ prefix: KV.CB_FEATURE, limit: 100 }),
		getBillingPeriodOrCached(env),
	]);
	for (const key of list.keys) {
		if (key.name.endsWith(':reason')) continue;
		const raw = await env.CF_MONITOR_KV.get(key.name);
		const featureId = key.name.replace(KV.CB_FEATURE, '');

		let status: string;
		if (raw === 'STOP') {
			status = 'tripped';
		} else if (raw === 'GO') {
			status = 'resetting';
		} else if (raw === null) {
			status = 'tripped';
		} else {
			status = raw;
		}

		breakers.push({ featureId, status });
	}

	return Response.json({
		account: env.ACCOUNT_NAME,
		billingPeriod: billingPeriod ?? undefined,
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
	'collect-metrics': collectAccountMetrics,
	'collect-account-usage': collectAccountUsage,
	'synthetic-health': runSyntheticHealthCheck,
	'worker-discovery': discoverWorkers,
	'daily-rollup': runDailyRollup,
	'staleness-check': (env: MonitorWorkerEnv) => checkCronStaleness(env),
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
		console.error(`[cf-monitor:admin] ${cronName} error:`, err);
		return Response.json({
			ok: false,
			cron: cronName,
			error: 'Internal error',
			durationMs: Date.now() - start,
		}, { status: 500 });
	}
}

// =============================================================================
// ADMIN: CIRCUIT BREAKER CONTROL (for testing)
// =============================================================================

async function handleAdminCbTrip(request: Request, env: MonitorWorkerEnv): Promise<Response> {
	try {
		const body = await request.json() as { featureId?: string; reason?: string; ttlSeconds?: number };
		if (!body.featureId) {
			return Response.json({ error: 'Missing featureId' }, { status: 400 });
		}
		await tripFeatureCb(env.CF_MONITOR_KV, body.featureId, body.reason ?? 'admin', body.ttlSeconds ?? 3600);
		return Response.json({ ok: true, action: 'trip', featureId: body.featureId });
	} catch (err) {
		console.error('[cf-monitor:admin] CB trip error:', err);
		return Response.json({ error: 'Internal error' }, { status: 500 });
	}
}

async function handleAdminCbReset(request: Request, env: MonitorWorkerEnv): Promise<Response> {
	try {
		const body = await request.json() as { featureId?: string };
		if (!body.featureId) {
			return Response.json({ error: 'Missing featureId' }, { status: 400 });
		}
		await resetFeatureCb(env.CF_MONITOR_KV, body.featureId);
		return Response.json({ ok: true, action: 'reset', featureId: body.featureId });
	} catch (err) {
		console.error('[cf-monitor:admin] CB reset error:', err);
		return Response.json({ error: 'Internal error' }, { status: 500 });
	}
}

async function handleAdminCbAccount(request: Request, env: MonitorWorkerEnv): Promise<Response> {
	try {
		const body = await request.json() as { status?: string; ttlSeconds?: number };
		if (!body.status) {
			return Response.json({ error: 'Missing status (active|warning|paused)' }, { status: 400 });
		}
		if (body.status === 'clear') {
			await env.CF_MONITOR_KV.delete(KV.CB_ACCOUNT);
		} else {
			await setAccountCbStatus(env.CF_MONITOR_KV, body.status as 'active' | 'warning' | 'paused', body.ttlSeconds ?? 3600);
		}
		return Response.json({ ok: true, action: 'account', status: body.status });
	} catch (err) {
		console.error('[cf-monitor:admin] CB account error:', err);
		return Response.json({ error: 'Internal error' }, { status: 500 });
	}
}

// =============================================================================
// ADMIN: DRY-RUN TEST ENDPOINTS (#34, #35)
// =============================================================================

interface GitHubDryRunBody {
	scriptName?: string;
	outcome?: string;
	errorMessage?: string;
	errorName?: string;
}

async function handleGitHubDryRun(request: Request, env: MonitorWorkerEnv): Promise<Response> {
	try {
		const body = await request.json() as GitHubDryRunBody;
		const scriptName = body.scriptName ?? 'unknown';
		const outcome = body.outcome ?? 'exception';
		const errorMessage = body.errorMessage ?? 'Unknown error';
		const errorName = body.errorName ?? 'Error';
		const priority = PRIORITY_MAP[outcome] ?? 'P3';
		const fingerprint = computeFingerprint(scriptName, outcome, errorMessage);
		const isTransient = matchTransientPattern(errorMessage, outcome);

		const labels = [
			`cf:error:${outcome}`,
			`cf:priority:${priority.toLowerCase()}`,
		];
		if (isTransient) labels.push('cf:transient');

		const title = `[${priority}] ${scriptName}: ${outcome}`;
		const issueBody = formatDryRunIssueBody({
			scriptName,
			outcome: outcome as TailOutcome,
			priority,
			fingerprint,
			errorMessage,
			errorName,
			isTransient,
			accountName: env.ACCOUNT_NAME,
		});

		return Response.json({ title, body: issueBody, labels, fingerprint, priority, isTransient });
	} catch (err) {
		console.error('[cf-monitor:admin] GitHub dry-run error:', err);
		return Response.json({ error: 'Internal error' }, { status: 500 });
	}
}

function formatDryRunIssueBody(params: {
	scriptName: string;
	outcome: TailOutcome;
	priority: string;
	fingerprint: string;
	errorMessage: string;
	errorName: string;
	isTransient: boolean;
	accountName: string;
}): string {
	return `## Error Details

| Field | Value |
|-------|-------|
| **Worker** | \`${escapeMdCell(params.scriptName)}\` |
| **Outcome** | \`${escapeMdCell(params.outcome)}\` |
| **Priority** | ${escapeMdCell(params.priority)} |
| **Account** | ${escapeMdCell(params.accountName)} |
| **Transient** | ${params.isTransient ? 'Yes' : 'No'} |
| **Fingerprint** | \`${escapeMdCell(params.fingerprint)}\` |

### Error

\`\`\`
${params.errorName}: ${params.errorMessage}
\`\`\`

### Context

- **Detected by**: cf-monitor tail handler
- **Time**: ${new Date().toISOString()}
${params.isTransient ? '\n> This error matches a transient pattern. It may resolve on its own.' : ''}

---
*Generated by [cf-monitor](https://github.com/littlebearapps/cf-monitor)*`;
}

interface SlackDryRunBody {
	type?: string;
	featureId?: string;
	metric?: string;
	current?: number;
	limit?: number;
	scriptName?: string;
	outcome?: string;
	priority?: string;
	issueUrl?: string;
}

async function handleSlackDryRun(request: Request): Promise<Response> {
	try {
		const body = await request.json() as SlackDryRunBody;
		const type = body.type ?? 'budget-warning';

		if (type === 'budget-warning') {
			const current = body.current ?? 0;
			const limit = body.limit ?? 1000;
			const pct = limit > 0 ? (current / limit) * 100 : 0;
			const message = formatBudgetWarning(
				'test-account',
				body.featureId ?? 'unknown:feature',
				body.metric ?? 'kv_reads',
				current,
				limit,
				pct
			);
			return Response.json({ type, message });
		}

		if (type === 'error-alert') {
			const message = formatErrorAlert(
				'test-account',
				body.scriptName ?? 'unknown',
				body.outcome ?? 'exception',
				body.priority ?? 'P1',
				body.issueUrl ?? null
			);
			return Response.json({ type, message });
		}

		return Response.json({ error: `Unknown type: ${type}` }, { status: 400 });
	} catch (err) {
		console.error('[cf-monitor:admin] Slack dry-run error:', err);
		return Response.json({ error: 'Internal error' }, { status: 500 });
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

	// Replay protection: reject duplicate delivery IDs
	const deliveryId = request.headers.get('X-GitHub-Delivery');
	if (deliveryId) {
		const nonceKey = `webhook:nonce:${deliveryId}`;
		const existing = await env.CF_MONITOR_KV.get(nonceKey);
		if (existing) {
			return Response.json({ ok: true, skipped: true, reason: 'Duplicate delivery' });
		}
		await env.CF_MONITOR_KV.put(nonceKey, '1', { expirationTtl: 86400 }); // 24hr
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

/** Escape markdown-active characters for safe table cell interpolation. */
function escapeMdCell(s: string): string {
	return s.replace(/[|`\[\]()!*_~<>\\]/g, '\\$&');
}

/** Verify admin token from Authorization: Bearer header. */
function verifyAdminToken(request: Request, env: MonitorWorkerEnv): boolean {
	if (!env.ADMIN_TOKEN) return false;
	const header = request.headers.get('Authorization');
	if (!header) return false;
	const token = header.startsWith('Bearer ') ? header.slice(7) : '';
	if (token.length !== env.ADMIN_TOKEN.length) return false;
	// Timing-safe comparison
	let result = 0;
	for (let i = 0; i < token.length; i++) {
		result |= token.charCodeAt(i) ^ env.ADMIN_TOKEN.charCodeAt(i);
	}
	return result === 0;
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
