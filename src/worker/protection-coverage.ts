/**
 * Protection Coverage report engine.
 *
 * Consumes existing KV snapshots + worker discovery + SDK heartbeats to produce an
 * audit-style report of which surfaces are protected / partially_protected / unprotected /
 * unknown. AUDIT-ONLY — no Cloudflare mutations. Destructive Tier-3 actions (route detach,
 * cron disable, WAF rules, safe-mode deploys, AI Gateway / CPU-limit setters) are
 * deferred.
 *
 * Every finding from this phase has `destructive_action_required: false`. The protection
 * score is a deterministic heuristic — see docs/protection-coverage.md.
 */

import { KV } from '../constants.js';
import type {
	AiGatewayUsageSnapshot,
	ConfidenceLabel,
	MonitorWorkerEnv,
	PagesDiscoverySnapshot,
	ProtectionCoverageReport,
	ProtectionFinding,
	ProtectionSeverity,
	QueueRealtimeSnapshot,
	ServiceUsageSnapshot,
	VectorizeDiscoverySnapshot,
} from '../types.js';

const FOLLOWUP_DOC = './docs/research/billing-endpoints-follow-up.md';
const BUDGET_ALERT_DOC = './docs/research/budget-alert-registration-todo.md';

/** Brief §C: deterministic score model. */
const SEVERITY_PENALTY: Record<ProtectionSeverity, number> = {
	critical: 20, high: 12, medium: 6, low: 2, info: 0,
};

/**
 * Pure score function. -penalty for unprotected, half for partially_protected, capped small
 * penalty for unknown high-risk surfaces. Clamped 0–100.
 */
export function computeProtectionScore(findings: ProtectionFinding[]): number {
	let score = 100;
	for (const f of findings) {
		if (f.status === 'protected' || f.status === 'not_applicable') continue;
		const penalty = SEVERITY_PENALTY[f.severity];
		if (f.status === 'unprotected') score -= penalty;
		else if (f.status === 'partially_protected') score -= Math.ceil(penalty / 2);
		else if (f.status === 'unknown') score -= Math.min(5, Math.ceil(penalty / 2));
	}
	return Math.max(0, Math.min(100, Math.round(score)));
}

/** Single entry point — reads KV once, runs all 10 finding helpers, composes the report. */
export async function buildProtectionReport(env: MonitorWorkerEnv): Promise<ProtectionCoverageReport> {
	const today = new Date().toISOString().slice(0, 10);

	const [
		usageRaw,
		aiGatewayRaw,
		queuesRaw,
		pagesRaw,
		vectorizeRaw,
		budgetAlertRaw,
		workerListRaw,
		heartbeatList,
	] = await Promise.all([
		env.CF_MONITOR_KV.get(`${KV.USAGE_ACCOUNT}${today}`),
		env.CF_MONITOR_KV.get(`${KV.USAGE_ACCOUNT_AI_GATEWAY}${today}`),
		env.CF_MONITOR_KV.get(`${KV.USAGE_QUEUE_REALTIME}${today}`),
		env.CF_MONITOR_KV.get(`${KV.USAGE_PAGES_DISCOVERY}${today}`),
		env.CF_MONITOR_KV.get(`${KV.USAGE_VECTORIZE_DISCOVERY}${today}`),
		env.CF_MONITOR_KV.get(KV.CONFIG_BUDGET_ALERT),
		env.CF_MONITOR_KV.get(KV.WORKER_LIST),
		env.CF_MONITOR_KV.list({ prefix: KV.WORKER_REGISTRY }),
	]);

	const usage = parseJson<ServiceUsageSnapshot>(usageRaw);
	const aiGateway = parseJson<AiGatewayUsageSnapshot>(aiGatewayRaw);
	const queues = parseJson<QueueRealtimeSnapshot>(queuesRaw);
	const pages = parseJson<PagesDiscoverySnapshot>(pagesRaw);
	const vectorize = parseJson<VectorizeDiscoverySnapshot>(vectorizeRaw);
	const budgetAlert = parseJson<Record<string, unknown>>(budgetAlertRaw);
	const workerList = parseJson<string[]>(workerListRaw) ?? [];

	// Workers with SDK heartbeats (set of names). Heartbeat keys: `${KV.WORKER_REGISTRY}<name>:last_seen`.
	const heartbeats = new Set<string>();
	const lastSeenSuffix = ':last_seen';
	for (const k of heartbeatList.keys) {
		if (k.name.endsWith(lastSeenSuffix)) {
			heartbeats.add(k.name.slice(KV.WORKER_REGISTRY.length, -lastSeenSuffix.length));
		}
	}

	const findings: ProtectionFinding[] = [
		...checkBillingReality(),
		...checkBudgetAlert(budgetAlert),
		...checkQueueStorm(queues),
		...checkPagesAmbiguity(pages),
		...checkVectorizeVisibility(vectorize),
		...checkR2ListBucket(usage),
		...checkRuntimeSdkCoverage(workerList, heartbeats),
		...checkAiGatewayNativeControls(aiGateway),
		...checkWorkerCpuLimits(workerList),
		...checkSafeModeControls(workerList),
	];

	return {
		generated_at: new Date().toISOString(),
		account: env.ACCOUNT_NAME ?? 'unknown',
		summary: summarise(findings),
		findings,
		confidence: {
			overall: 'analytics_estimate',
			usage: 'analytics_estimate',
			runtime: heartbeats.size > 0 ? 'runtime_metered' : 'unknown',
			billing: 'dashboard_documented_no_public_api',
		},
		caveats: [
			'Protection score is a heuristic, not actuarial. See docs/protection-coverage.md.',
			'Visibility ≠ enforcement. Runtime SDK / binding proxies remain the strongest layer.',
			'CF Budget Alerts are alert-only; current-cycle invoice-grade per-product spend is dashboard-only.',
			'Destructive Tier-3 controls (route detach, cron disable, WAF rules, safe-mode deploy, AI Gateway / CPU-limit setters) are not yet implemented.',
		],
	};
}

// =============================================================================
// FINDING HELPERS — one per brief §D #1–#10
// =============================================================================

function checkBillingReality(): ProtectionFinding[] {
	return [{
		id: 'billing-reality-check',
		title: 'No invoice-grade current-cycle per-product cost API',
		severity: 'medium',
		status: 'partially_protected',
		resource_type: 'global',
		evidence: 'Cloudflare offers no public API for invoice-grade per-product current-cycle cost. /billing/usage is a generic metric query, not the Billable Usage dashboard. /billing/history surfaces past invoices only.',
		missing_controls: ['programmatic billable-usage feed'],
		recommended_actions: [
			'Continue using cf-monitor GraphQL + runtime estimates for current-cycle spend.',
			'For invoice-grade current-cycle data, check the Cloudflare dashboard manually.',
			'For historical invoice totals, /billing/history is billing-authoritative (not yet wired — see follow-up doc).',
		],
		confidence: 'analytics_estimate',
		source: 'static (research)',
		destructive_action_required: false,
		docs_ref: FOLLOWUP_DOC,
	}];
}

function checkBudgetAlert(budgetAlert: Record<string, unknown> | null): ProtectionFinding[] {
	if (budgetAlert) {
		const threshold = typeof budgetAlert.threshold === 'number' ? budgetAlert.threshold : undefined;
		return [{
			id: 'budget-alert-registered',
			title: 'Cloudflare Budget Alert subscription registered (alert-only)',
			severity: 'medium',
			status: 'partially_protected',
			resource_type: 'global',
			evidence: `cf-monitor-managed CF Budget Alert subscription is active${threshold !== undefined ? ` (user-stated threshold $${threshold}/mo)` : ''}.`,
			missing_controls: ['dashboard threshold verification', 'enforcement (CF Budget Alerts are alert-only)'],
			recommended_actions: [
				'Verify the $-threshold in the Cloudflare dashboard at Manage Account > Billing > Billable Usage > Add a Budget Alert. The Notifications API only routes the alert; the dollar threshold is configured in the dashboard.',
			],
			confidence: 'alert_only',
			source: 'KV.CONFIG_BUDGET_ALERT',
			destructive_action_required: false,
			docs_ref: BUDGET_ALERT_DOC,
		}];
	}
	return [{
		id: 'budget-alert-missing',
		title: 'No Cloudflare Budget Alert subscription registered',
		severity: 'medium',
		status: 'unprotected',
		resource_type: 'global',
		evidence: 'No KV.CONFIG_BUDGET_ALERT blob present — `cf-monitor init --register-budget-alert <n>` has not been run.',
		missing_controls: ['Cloudflare Budget Alert subscription'],
		recommended_actions: [
			'Run `npx cf-monitor init --register-budget-alert <threshold>` to subscribe a notification policy.',
			'Then configure the $-threshold in the CF dashboard. CF Budget Alerts are alert-only — they do not stop spend.',
		],
		confidence: 'alert_only',
		source: 'KV.CONFIG_BUDGET_ALERT',
		destructive_action_required: false,
		docs_ref: BUDGET_ALERT_DOC,
	}];
}

function checkQueueStorm(snap: QueueRealtimeSnapshot | null): ProtectionFinding[] {
	if (!snap) {
		return [{
			id: 'queue-realtime-missing',
			title: 'Queue realtime backlog not collected today',
			severity: 'info',
			status: 'unknown',
			resource_type: 'queue',
			evidence: 'No KV.USAGE_QUEUE_REALTIME blob for today. Hourly collector may not have run yet or the token lacks Queues Read.',
			missing_controls: ['hourly queue backlog visibility'],
			recommended_actions: ['Verify the collect-queue-realtime cron is enabled and the token has Queues Read.'],
			confidence: 'unknown',
			source: 'KV.USAGE_QUEUE_REALTIME',
			destructive_action_required: false,
		}];
	}

	if (snap.queues.length === 0) {
		return [{
			id: 'queue-realtime-empty',
			title: 'No queues on account',
			severity: 'info',
			status: 'not_applicable',
			resource_type: 'queue',
			evidence: 'Queue collector ran and found zero queues.',
			missing_controls: [],
			recommended_actions: [],
			confidence: 'runtime_metered',
			source: 'KV.USAGE_QUEUE_REALTIME',
			destructive_action_required: false,
		}];
	}

	const findings: ProtectionFinding[] = [{
		id: 'queue-realtime-present',
		title: `Queue realtime backlog visibility (${snap.queues.length} queue${snap.queues.length === 1 ? '' : 's'})`,
		severity: 'info',
		status: 'partially_protected',
		resource_type: 'queue',
		evidence: `${snap.queues.length} queue${snap.queues.length === 1 ? '' : 's'} polled hourly. Visibility only — producer-side runtime guards (cf-monitor SDK queue proxy) are the enforcement layer.`,
		missing_controls: ['runtime producer-side enforcement (per-queue)'],
		recommended_actions: ['Ensure consumer workers calling the queues are instrumented with cf-monitor SDK (`monitor()`) so per-invocation budgets apply.'],
		confidence: 'runtime_metered',
		source: 'KV.USAGE_QUEUE_REALTIME',
		destructive_action_required: false,
	}];

	for (const q of snap.queues) {
		const backlogCount = q.backlog_count ?? 0;
		// CF Queues API returns oldest_message_timestamp_ms = 0 when the queue is empty (Phase 12
		// finding against the Platform account). `Date.now() - 0` would otherwise look like a
		// 57-year-old message and trip the >6h critical bucket. Treat empty queues as no-age-signal.
		const isEmpty = backlogCount === 0 || (q.oldest_message_timestamp_ms ?? 0) === 0;
		const oldestAgeMs = isEmpty ? 0 : Date.now() - (q.oldest_message_timestamp_ms ?? Date.now());
		const oldestAgeMin = Math.floor(oldestAgeMs / 60_000);

		const countSev = backlogCount > 100_000 ? 'critical'
			: backlogCount > 10_000 ? 'high'
			: backlogCount > 1_000 ? 'medium'
			: null;
		const ageSev = oldestAgeMin > 360 ? 'critical' : oldestAgeMin > 60 ? 'high' : oldestAgeMin > 15 ? 'medium' : null;

		if (countSev) {
			findings.push({
				id: `queue-backlog:${q.id}`,
				title: `Queue backlog count is ${backlogCount.toLocaleString()} on '${q.name || q.id}'`,
				severity: countSev,
				status: 'unprotected',
				resource_type: 'queue',
				resource_id: q.id,
				resource_name: q.name,
				evidence: `backlog_count = ${backlogCount} (thresholds: medium >1k, high >10k, critical >100k)`,
				missing_controls: ['consumer keeping up with producer rate'],
				recommended_actions: [
					'Investigate consumer throughput. Check max_concurrency, DLQ config, and consumer Worker errors.',
					'If unrecoverable, the CF dashboard supports queue purge (destructive).',
				],
				confidence: 'runtime_metered',
				source: 'KV.USAGE_QUEUE_REALTIME',
				destructive_action_required: false,
			});
		}

		if (ageSev) {
			findings.push({
				id: `queue-age:${q.id}`,
				title: `Queue oldest message age is ${oldestAgeMin} minutes on '${q.name || q.id}'`,
				severity: ageSev,
				status: 'unprotected',
				resource_type: 'queue',
				resource_id: q.id,
				resource_name: q.name,
				evidence: `oldest_message_timestamp_ms = ${q.oldest_message_timestamp_ms} (~${oldestAgeMin} min old; thresholds: medium >15m, high >1h, critical >6h)`,
				missing_controls: ['consumer keeping up with producer rate'],
				recommended_actions: ['Same as backlog-count finding — investigate consumer; consider DLQ inspection.'],
				confidence: 'runtime_metered',
				source: 'KV.USAGE_QUEUE_REALTIME',
				destructive_action_required: false,
			});
		}
	}

	return findings;
}

function checkPagesAmbiguity(snap: PagesDiscoverySnapshot | null): ProtectionFinding[] {
	if (!snap || snap.projects.length === 0) return [];
	return snap.projects.map((p) => ({
		id: `pages-project:${p.id ?? p.name}`,
		title: `Pages project '${p.name}' — Functions usage unknown`,
		severity: 'medium',
		status: 'unknown',
		resource_type: 'pages-project',
		resource_id: p.id,
		resource_name: p.name,
		evidence: 'Pages static assets are free; only Pages Functions are billed (as Workers). cf-monitor does not probe per-project to detect Functions usage.',
		missing_controls: ['per-project Functions-usage attribution'],
		recommended_actions: [
			'Confirm whether this Pages project uses Functions (CF dashboard → Pages → project → Functions).',
			'If it uses Functions, ensure the standard Worker budgets apply.',
		],
		confidence: 'runtime_metered',
		source: 'KV.USAGE_PAGES_DISCOVERY',
		destructive_action_required: false,
	}));
}

function checkVectorizeVisibility(snap: VectorizeDiscoverySnapshot | null): ProtectionFinding[] {
	if (!snap || snap.indexes.length === 0) return [];
	return snap.indexes.map((idx) => ({
		id: `vectorize-index:${idx.name}`,
		title: `Vectorize index '${idx.name}' — vector count not collected`,
		severity: 'low',
		status: 'partially_protected',
		resource_type: 'vectorize-index',
		resource_name: idx.name,
		evidence: `Metadata visible (dimensions=${idx.dimensions ?? '?'}, metric=${idx.metric ?? '?'}). Per-index vector counts NOT collected — would require paginating list_vectors per index, which risks CF API rate-limit cost.`,
		missing_controls: ['vector-count visibility (intentional)'],
		recommended_actions: [
			'Rely on runtime Vectorize proxy metrics (cf-monitor SDK) for write/query enforcement.',
			'Do not enable full REST list_vectors scans by default.',
		],
		confidence: 'runtime_metered',
		source: 'KV.USAGE_VECTORIZE_DISCOVERY',
		destructive_action_required: false,
	}));
}

function checkR2ListBucket(snap: ServiceUsageSnapshot | null): ProtectionFinding[] {
	if (!snap?.services?.r2) return [];
	return [{
		id: 'r2-listbucket-unknown',
		title: 'R2 ListBucket actionType is classified `unknown` (not Class B)',
		severity: 'low',
		status: 'partially_protected',
		resource_type: 'r2',
		evidence: 'R2 usage was observed (services.r2 present). If `ListBucket` operations occurred this cycle they were logged as `unknown` and excluded from classA/classB counters — see src/worker/crons/r2-classification.ts. Final Class A vs B awaits a per-operation Billing Read invoice.',
		missing_controls: ['authoritative ListBucket classification'],
		recommended_actions: [
			'Keep the conservative `unknown` classification until invoice evidence resolves it.',
			'If a per-operation invoice becomes available, reclassify in r2-classification.ts.',
		],
		confidence: 'unknown',
		source: 'KV.USAGE_ACCOUNT',
		destructive_action_required: false,
		docs_ref: FOLLOWUP_DOC,
	}];
}

function checkRuntimeSdkCoverage(workerList: string[], heartbeats: Set<string>): ProtectionFinding[] {
	if (workerList.length === 0) {
		return [{
			id: 'runtime-sdk-no-workers',
			title: 'No workers discovered — runtime SDK coverage unknown',
			severity: 'info',
			status: 'unknown',
			resource_type: 'worker',
			evidence: 'Worker discovery cron has not populated KV.WORKER_LIST.',
			missing_controls: ['worker discovery'],
			recommended_actions: ['Trigger `worker-discovery` cron or wait for the daily run.'],
			confidence: 'unknown',
			source: 'KV.WORKER_LIST',
			destructive_action_required: false,
		}];
	}

	const findings: ProtectionFinding[] = [];
	for (const name of workerList) {
		if (heartbeats.has(name)) {
			findings.push({
				id: `runtime-sdk:${name}`,
				title: `Worker '${name}' is instrumented with cf-monitor SDK`,
				severity: 'info',
				status: 'protected',
				resource_type: 'worker',
				resource_name: name,
				evidence: 'SDK heartbeat present at workers:<name>:last_seen — runtime per-invocation budgets apply.',
				missing_controls: [],
				recommended_actions: [],
				confidence: 'runtime_metered',
				source: 'KV.WORKER_REGISTRY (heartbeat)',
				destructive_action_required: false,
			});
		} else {
			findings.push({
				id: `runtime-sdk-missing:${name}`,
				title: `Worker '${name}' is NOT instrumented with cf-monitor SDK`,
				severity: 'medium',
				status: 'partially_protected',
				resource_type: 'worker',
				resource_name: name,
				evidence: 'Worker discovered via REST but no SDK heartbeat in KV. Visibility-only — runtime budget enforcement is not active.',
				missing_controls: ['runtime per-invocation budget enforcement'],
				recommended_actions: [
					`Install @littlebearapps/cf-monitor and wrap the worker entry with monitor(...) in '${name}'.`,
					'Visibility (REST/GraphQL) is not enforcement — only runtime SDK can hard-stop blast radius.',
				],
				confidence: 'runtime_metered',
				source: 'KV.WORKER_LIST vs KV.WORKER_REGISTRY heartbeats',
				destructive_action_required: false,
			});
		}
	}
	return findings;
}

function checkAiGatewayNativeControls(snap: AiGatewayUsageSnapshot | null): ProtectionFinding[] {
	if (!snap) return [];
	return [{
		id: 'ai-gateway-native-controls-unknown',
		title: 'AI Gateway native rate-limit / Budget Limit settings unknown',
		severity: 'high',
		status: 'unknown',
		resource_type: 'ai-gateway',
		evidence: 'AI Gateway usage is being collected (logs-based) but cf-monitor does not yet audit per-gateway native rate_limiting or Dynamic Routes Budget Limit settings.',
		missing_controls: ['audit of AI Gateway rate_limiting_*', 'audit of Dynamic Routes Budget Limit per route'],
		recommended_actions: [
			'Tier 3: audit each gateway via GET /accounts/{id}/ai-gateway/gateways/{id} and report rate-limit / Dynamic Route Budget Limit presence.',
			'Do NOT mutate AI Gateway settings in this pass.',
		],
		confidence: 'unknown',
		source: 'KV.USAGE_ACCOUNT_AI_GATEWAY',
		destructive_action_required: false,
	}];
}

function checkWorkerCpuLimits(workerList: string[]): ProtectionFinding[] {
	const sev: ProtectionSeverity = workerList.length > 0 ? 'medium' : 'low';
	return [{
		id: 'worker-cpu-limits-not-audited',
		title: 'Per-worker CPU / subrequest native limits not audited',
		severity: sev,
		status: 'unknown',
		resource_type: 'worker',
		evidence: `cf-monitor does not yet collect per-script settings (limits.cpu_ms, limits.subrequests). Worker count: ${workerList.length}.`,
		missing_controls: ['per-script CPU/subrequest limit audit'],
		recommended_actions: [
			'Tier 3: collect per-script settings via GET /accounts/{id}/workers/scripts/{name}/settings and report missing/low values.',
		],
		confidence: 'unknown',
		source: 'static (not collected)',
		destructive_action_required: false,
	}];
}

function checkSafeModeControls(workerList: string[]): ProtectionFinding[] {
	const sev: ProtectionSeverity = workerList.length > 5 ? 'high' : 'medium';
	return [{
		id: 'safe-mode-controls-deferred',
		title: 'Destructive emergency controls (route detach, cron disable, WAF, safe-mode) not implemented',
		severity: sev,
		status: 'unprotected',
		resource_type: 'global',
		evidence: `${workerList.length} worker(s) discovered. Emergency controls (route detach, cron disable, account-level WAF rules, safe-mode deploy) require a controller token (Workers Scripts Edit / Workers Routes Edit / Zone WAF Write / Notifications Write). Not implemented this pass.`,
		missing_controls: ['controller-token-driven emergency controls'],
		recommended_actions: [
			'Tier 3: build a separate `cf-monitor controller` command tier requiring an opt-in controller token.',
			'For now: rely on runtime SDK budget enforcement; manual dashboard intervention for emergencies.',
		],
		confidence: 'unknown',
		source: 'static (not implemented)',
		destructive_action_required: false,
	}];
}

// =============================================================================
// HELPERS
// =============================================================================

function summarise(findings: ProtectionFinding[]): ProtectionCoverageReport['summary'] {
	const s = {
		score: 0,
		protected: 0,
		partially_protected: 0,
		unprotected: 0,
		unknown: 0,
		not_applicable: 0,
		critical: 0,
		high: 0,
		medium: 0,
		low: 0,
		info: 0,
	};
	for (const f of findings) {
		s[f.status]++;
		s[f.severity]++;
	}
	s.score = computeProtectionScore(findings);
	return s;
}

function parseJson<T>(raw: string | null): T | null {
	if (!raw) return null;
	try { return JSON.parse(raw) as T; } catch { return null; }
}

// Type guard avoid: ConfidenceLabel is only imported as a type. This export is here for tests.
export const _internals = { SEVERITY_PENALTY };
// Re-export ConfidenceLabel for callers that need it without circular import noise.
export type { ConfidenceLabel };

// =============================================================================
// REDACTION (Phase 9 — opt-in public-redacted /protection variant)
// =============================================================================

/**
 * Return a deep copy of the report with sensitive identifiers scrubbed.
 *
 * Scrubbed: `account`, every finding's `resource_id` / `resource_name`, and any worker / queue /
 * Pages / Vectorize names that appear inside `evidence` strings. Severity / status / score /
 * counts / confidence labels / recommended_actions / docs_ref remain visible — the score and
 * categorical breakdown are the whole point of the public variant.
 *
 * Triggered only when `CF_MONITOR_PROTECTION_PUBLIC=redacted` AND the request lacks auth. The
 * default-safe path (no env var) is 401, not redacted.
 */
export function redactProtectionReport(report: ProtectionCoverageReport): ProtectionCoverageReport {
	return {
		...report,
		account: '<REDACTED>',
		findings: report.findings.map((f) => ({
			...f,
			resource_id: f.resource_id ? '<REDACTED>' : undefined,
			resource_name: f.resource_name ? '<REDACTED>' : undefined,
			evidence: scrubEvidence(f),
		})),
	};
}

/**
 * Replace the original resource_name (if present) with `<REDACTED>` inside the evidence string,
 * to catch the common pattern where evidence quotes the worker/queue/pages/index name.
 *
 * For findings without a resource_name, leave evidence untouched — those are global / catalogue
 * statements like the billing-reality-check, which don't carry sensitive identifiers.
 */
function scrubEvidence(f: ProtectionFinding): string {
	if (!f.resource_name || f.resource_name.length === 0) return f.evidence;
	// Use split/join (regex-safe — names may contain special chars).
	return f.evidence.split(f.resource_name).join('<REDACTED>');
}
