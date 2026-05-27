import { KV, AE_FIELDS, AE_FIELD_COUNT } from '../../constants.js';
import type {
	AiGatewayModelAggregate,
	AiGatewayUsageSnapshot,
	MonitorWorkerEnv,
} from '../../types.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;

/** Hard cap to keep per-hour collection cheap. Hot gateways trigger a Slack ping. */
const MAX_PAGES_PER_GATEWAY = 5;
const PER_PAGE = 1000;
const KV_SNAPSHOT_TTL_SECONDS = 2_764_800; // 32 days
const KV_AUTH_WARN_DEDUP_TTL = 86_400;     // 24h

const DISCLAIMER =
	'First-party Cloudflare AI Gateway logs. Costs reflect provider pass-through prices captured by the Gateway.';

// =============================================================================
// CF AI GATEWAY LOG TYPES (subset — only the fields we consume)
// =============================================================================

interface CfApiListResponse<T> {
	result: T | null;
	success: boolean;
	errors?: Array<{ message: string }>;
	result_info?: { page: number; per_page: number; count: number; total_count: number };
}

interface GatewaySummary {
	id: string;
	[key: string]: unknown;
}

interface AiGatewayLogRow {
	id?: string;
	provider?: string | null;
	model?: string | null;
	cost?: number | null;
	tokens_in?: number | null;
	tokens_out?: number | null;
	duration?: number | null;
	cached?: boolean | null;
	success?: boolean | null;
	status_code?: number | null;
	created_at?: string | null;
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

/**
 * Hourly: pull AI Gateway logs for the prior wall-clock hour, aggregate by
 * (gateway, provider, model), write per-bucket AE rows + a merged daily KV blob.
 *
 * Fail-open: any missing token, 401/403, network failure, or schema mismatch
 * logs once/day and returns without throwing. The consumer worker is never
 * affected by cf-monitor's own collection failures.
 */
export async function collectAiGatewayUsage(env: MonitorWorkerEnv): Promise<void> {
	if (!env.CLOUDFLARE_API_TOKEN || !env.CF_ACCOUNT_ID) {
		// No token / no account — silently skip on first boot, otherwise daily warn
		await warnOncePerDay(env, 'ai-gateway:no-token', '[cf-monitor:ai-gateway] No CLOUDFLARE_API_TOKEN or CF_ACCOUNT_ID — skipping');
		return;
	}

	if (!ACCOUNT_ID_RE.test(env.CF_ACCOUNT_ID)) {
		console.error('[cf-monitor:ai-gateway] Invalid CF_ACCOUNT_ID format — must be 32-char hex');
		return;
	}

	const now = new Date();
	const windowEnd = new Date(now);
	const windowStart = new Date(now.getTime() - 3_600_000);
	const today = now.toISOString().slice(0, 10);

	const gateways = await listGateways(env);
	if (gateways === null) {
		// Auth / network failure — already logged in helper. Fail-open.
		return;
	}
	if (gateways.length === 0) {
		console.log('[cf-monitor:ai-gateway] No gateways on account — nothing to collect');
		return;
	}

	// Per-gateway, per-provider, per-model aggregates for this hour
	type ProviderModelMap = Map<string, Map<string, MutableAggregate>>;
	const perGateway = new Map<string, ProviderModelMap>();

	let totalRowsSeen = 0;
	let totalRowsCollected = 0;
	let totalPageCapHits = 0;

	for (const gw of gateways) {
		const gwId = gw.id;
		if (!gwId) continue;

		const providers: ProviderModelMap = new Map();
		perGateway.set(gwId, providers);

		const { rowsCollected, pageCapHit } = await aggregateGatewayLogs(
			env,
			gwId,
			windowStart,
			windowEnd,
			providers,
		);
		totalRowsSeen += rowsCollected;
		totalRowsCollected += rowsCollected;
		if (pageCapHit) {
			totalPageCapHits++;
			await alertPageCap(env, gwId);
		}
	}

	if (totalRowsCollected === 0) {
		console.log(`[cf-monitor:ai-gateway] 0 log rows across ${gateways.length} gateway(s) for ${windowStart.toISOString()}..${windowEnd.toISOString()}`);
		// Still merge an empty hour into the daily KV blob so the snapshot's
		// lastUpdated stays fresh — but skip if there's no prior blob to avoid
		// creating a bunch of empty daily blobs on idle accounts.
		const existing = await readDailyBlob(env, today);
		if (existing) {
			existing.lastUpdated = Date.now();
			await writeDailyBlob(env, today, existing);
		}
		return;
	}

	// Convert aggregates to snapshot + AE rows
	const accountId = env.CF_ACCOUNT_ID;
	const snapshotGateways: AiGatewayUsageSnapshot['gateways'] = {};

	for (const [gwId, providers] of perGateway) {
		const providersOut: AiGatewayUsageSnapshot['gateways'][string]['providers'] = {};
		for (const [provider, models] of providers) {
			const modelsOut: Record<string, AiGatewayModelAggregate> = {};
			for (const [model, agg] of models) {
				const aggregate = finaliseAggregate(agg);
				modelsOut[model] = aggregate;
				writeAeRow(env, accountId, gwId, provider, model, aggregate);
			}
			providersOut[provider] = { models: modelsOut };
		}
		snapshotGateways[gwId] = { providers: providersOut };
	}

	// Merge into daily KV blob
	const existing = await readDailyBlob(env, today);
	const merged = mergeHourIntoDay(existing, today, snapshotGateways);
	await writeDailyBlob(env, today, merged);

	console.log(
		`[cf-monitor:ai-gateway] Collected ${totalRowsCollected} logs across ${gateways.length} gateway(s)` +
		(totalPageCapHits > 0 ? ` — ${totalPageCapHits} gateway(s) hit ${MAX_PAGES_PER_GATEWAY}-page cap` : ''),
	);
}

// =============================================================================
// CF API CALLS
// =============================================================================

async function listGateways(env: MonitorWorkerEnv): Promise<GatewaySummary[] | null> {
	const url = `${CF_API}/accounts/${env.CF_ACCOUNT_ID}/ai-gateway/gateways?per_page=50`;
	const response = await cfApiFetch(env, url);
	if (!response) return null;

	try {
		const data = await response.json() as CfApiListResponse<GatewaySummary[]>;
		if (!data.success) {
			console.warn(`[cf-monitor:ai-gateway] List gateways returned errors: ${data.errors?.[0]?.message ?? 'unknown'}`);
			return null;
		}
		return Array.isArray(data.result) ? data.result : [];
	} catch (err) {
		console.warn(`[cf-monitor:ai-gateway] Failed to parse gateway list: ${err}`);
		return null;
	}
}

interface MutableAggregate {
	requests: number;
	tokens_in: number;
	tokens_out: number;
	cost: number;
	cached: number;
	errors: number;
	durations: number[];
}

function finaliseAggregate(agg: MutableAggregate): AiGatewayModelAggregate {
	return {
		requests: agg.requests,
		tokens_in: agg.tokens_in,
		tokens_out: agg.tokens_out,
		cost: round6(agg.cost),
		cached: agg.cached,
		errors: agg.errors,
		p50_duration_ms: medianMs(agg.durations),
	};
}

async function aggregateGatewayLogs(
	env: MonitorWorkerEnv,
	gatewayId: string,
	windowStart: Date,
	windowEnd: Date,
	providers: Map<string, Map<string, MutableAggregate>>,
): Promise<{ rowsCollected: number; pageCapHit: boolean }> {
	let rowsCollected = 0;
	let page = 1;
	let pageCapHit = false;

	const startIso = windowStart.toISOString();
	const endIso = windowEnd.toISOString();

	while (page <= MAX_PAGES_PER_GATEWAY) {
		const params = new URLSearchParams({
			start_date: startIso,
			end_date: endIso,
			per_page: String(PER_PAGE),
			page: String(page),
			order_by: 'created_at',
			order_by_direction: 'desc',
		});
		const url = `${CF_API}/accounts/${env.CF_ACCOUNT_ID}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/logs?${params.toString()}`;
		const response = await cfApiFetch(env, url);
		if (!response) break;

		let data: CfApiListResponse<AiGatewayLogRow[]>;
		try {
			data = await response.json() as CfApiListResponse<AiGatewayLogRow[]>;
		} catch (err) {
			console.warn(`[cf-monitor:ai-gateway] ${gatewayId}: failed to parse logs page ${page}: ${err}`);
			break;
		}
		if (!data.success) {
			console.warn(`[cf-monitor:ai-gateway] ${gatewayId}: logs page ${page} returned errors: ${data.errors?.[0]?.message ?? 'unknown'}`);
			break;
		}

		const rows = Array.isArray(data.result) ? data.result : [];
		for (const row of rows) {
			ingestRow(providers, row);
		}
		rowsCollected += rows.length;

		// Stop when CF returns fewer than per_page rows (end of data)
		if (rows.length < PER_PAGE) break;
		if (page === MAX_PAGES_PER_GATEWAY) {
			pageCapHit = true;
		}
		page++;
	}

	return { rowsCollected, pageCapHit };
}

function ingestRow(
	providers: Map<string, Map<string, MutableAggregate>>,
	row: AiGatewayLogRow,
): void {
	const provider = (row.provider ?? 'unknown').toString();
	const model = (row.model ?? 'unknown').toString();

	let modelMap = providers.get(provider);
	if (!modelMap) {
		modelMap = new Map();
		providers.set(provider, modelMap);
	}
	let agg = modelMap.get(model);
	if (!agg) {
		agg = {
			requests: 0,
			tokens_in: 0,
			tokens_out: 0,
			cost: 0,
			cached: 0,
			errors: 0,
			durations: [],
		};
		modelMap.set(model, agg);
	}

	agg.requests++;
	agg.tokens_in += toNumber(row.tokens_in);
	agg.tokens_out += toNumber(row.tokens_out);
	agg.cost += toNumber(row.cost);
	if (row.cached === true) agg.cached++;
	if (row.success === false) agg.errors++;
	const dur = toNumber(row.duration);
	if (dur > 0) agg.durations.push(dur);
}

// =============================================================================
// ANALYTICS ENGINE
// =============================================================================

function writeAeRow(
	env: MonitorWorkerEnv,
	accountId: string,
	gatewayId: string,
	provider: string,
	model: string,
	agg: AiGatewayModelAggregate,
): void {
	try {
		const doubles = new Array(AE_FIELD_COUNT).fill(0);
		doubles[AE_FIELDS.aiGatewayRequests] = agg.requests;
		doubles[AE_FIELDS.aiGatewayTokensIn] = agg.tokens_in;
		doubles[AE_FIELDS.aiGatewayTokensOut] = agg.tokens_out;
		doubles[AE_FIELDS.aiGatewayCost] = agg.cost;
		doubles[AE_FIELDS.aiGatewayCachedCount] = agg.cached;
		doubles[AE_FIELDS.aiGatewayErrorCount] = agg.errors;
		doubles[AE_FIELDS.aiGatewayP50DurationMs] = agg.p50_duration_ms;

		env.CF_MONITOR_AE.writeDataPoint({
			blobs: [accountId, gatewayId, provider, model, 'ai-gateway'],
			doubles,
			indexes: [accountId],
		});
	} catch (err) {
		console.warn(`[cf-monitor:ai-gateway] AE write failed for ${gatewayId}/${provider}/${model}: ${err}`);
	}
}

// =============================================================================
// KV DAILY BLOB
// =============================================================================

async function readDailyBlob(env: MonitorWorkerEnv, today: string): Promise<AiGatewayUsageSnapshot | null> {
	try {
		const raw = await env.CF_MONITOR_KV.get(`${KV.USAGE_ACCOUNT_AI_GATEWAY}${today}`);
		if (!raw) return null;
		return JSON.parse(raw) as AiGatewayUsageSnapshot;
	} catch (err) {
		console.warn(`[cf-monitor:ai-gateway] Failed to read daily blob: ${err}`);
		return null;
	}
}

async function writeDailyBlob(env: MonitorWorkerEnv, today: string, snapshot: AiGatewayUsageSnapshot): Promise<void> {
	try {
		await env.CF_MONITOR_KV.put(
			`${KV.USAGE_ACCOUNT_AI_GATEWAY}${today}`,
			JSON.stringify(snapshot),
			{ expirationTtl: KV_SNAPSHOT_TTL_SECONDS },
		);
	} catch (err) {
		console.warn(`[cf-monitor:ai-gateway] Failed to write daily blob: ${err}`);
	}
}

/**
 * Merge an hour's per-gateway aggregates into the day's existing snapshot.
 * Each model aggregate is summed across hours; p50 across hours is approximated
 * by a request-weighted average of per-hour p50s (we don't keep raw durations
 * cross-hour to bound memory).
 */
export function mergeHourIntoDay(
	existing: AiGatewayUsageSnapshot | null,
	today: string,
	hourGateways: AiGatewayUsageSnapshot['gateways'],
): AiGatewayUsageSnapshot {
	const base: AiGatewayUsageSnapshot = existing ?? {
		date: today,
		gateways: {},
		totals: { requests: 0, tokens_in: 0, tokens_out: 0, cost: 0, cached: 0, errors: 0 },
		lastUpdated: 0,
		disclaimer: DISCLAIMER,
	};

	// Ensure required fields exist on legacy blobs missing newer fields
	if (!base.totals) base.totals = { requests: 0, tokens_in: 0, tokens_out: 0, cost: 0, cached: 0, errors: 0 };
	if (!base.disclaimer) base.disclaimer = DISCLAIMER;

	for (const [gwId, gw] of Object.entries(hourGateways)) {
		const baseGw = base.gateways[gwId] ?? { providers: {} };
		base.gateways[gwId] = baseGw;
		for (const [provider, prov] of Object.entries(gw.providers)) {
			const baseProv = baseGw.providers[provider] ?? { models: {} };
			baseGw.providers[provider] = baseProv;
			for (const [model, agg] of Object.entries(prov.models)) {
				const prev = baseProv.models[model];
				if (!prev) {
					baseProv.models[model] = { ...agg };
				} else {
					const totalReqs = prev.requests + agg.requests;
					const weightedP50 = totalReqs > 0
						? Math.round(
							((prev.p50_duration_ms * prev.requests) + (agg.p50_duration_ms * agg.requests)) / totalReqs,
						)
						: 0;
					baseProv.models[model] = {
						requests: totalReqs,
						tokens_in: prev.tokens_in + agg.tokens_in,
						tokens_out: prev.tokens_out + agg.tokens_out,
						cost: round6(prev.cost + agg.cost),
						cached: prev.cached + agg.cached,
						errors: prev.errors + agg.errors,
						p50_duration_ms: weightedP50,
					};
				}
				// Update totals
				base.totals.requests += agg.requests;
				base.totals.tokens_in += agg.tokens_in;
				base.totals.tokens_out += agg.tokens_out;
				base.totals.cost = round6(base.totals.cost + agg.cost);
				base.totals.cached += agg.cached;
				base.totals.errors += agg.errors;
			}
		}
	}

	base.lastUpdated = Date.now();
	base.date = today;
	return base;
}

// =============================================================================
// CF API FETCH HELPER (fail-open, dedup auth warnings to 1/day)
// =============================================================================

async function cfApiFetch(env: MonitorWorkerEnv, url: string): Promise<Response | null> {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
				'Content-Type': 'application/json',
			},
		});
	} catch (err) {
		console.warn(`[cf-monitor:ai-gateway] Network error fetching ${redactUrl(url)}: ${err}`);
		return null;
	}

	if (response.status === 401 || response.status === 403) {
		await warnOncePerDay(
			env,
			`ai-gateway:auth:${response.status}`,
			`[cf-monitor:ai-gateway] CF API returned ${response.status} — token likely lacks "AI Gateway:Read". Skipping until tomorrow.`,
		);
		return null;
	}
	if (response.status === 404) {
		// Gateway deleted between list and fetch, or AI Gateway not enabled on account
		await warnOncePerDay(
			env,
			'ai-gateway:404',
			'[cf-monitor:ai-gateway] CF API returned 404 — AI Gateway not enabled or gateway removed',
		);
		return null;
	}
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		console.warn(`[cf-monitor:ai-gateway] CF API ${response.status} on ${redactUrl(url)}: ${text.slice(0, 200)}`);
		return null;
	}
	return response;
}

/**
 * Log a warning at most once per UTC day using KV dedup. Mirrors the
 * subscriptions.ts pattern but without spamming Slack.
 */
async function warnOncePerDay(env: MonitorWorkerEnv, key: string, message: string): Promise<void> {
	try {
		const today = new Date().toISOString().slice(0, 10);
		const dedupKey = `${KV.BUDGET_WARN}${key}:${today}`;
		const existing = await env.CF_MONITOR_KV.get(dedupKey);
		if (existing) return;
		console.warn(message);
		await env.CF_MONITOR_KV.put(dedupKey, '1', { expirationTtl: KV_AUTH_WARN_DEDUP_TTL });
	} catch {
		// Even the dedup write may fail — surface the original message in any case
		console.warn(message);
	}
}

async function alertPageCap(env: MonitorWorkerEnv, gatewayId: string): Promise<void> {
	try {
		const today = new Date().toISOString().slice(0, 10);
		const { sendSlackAlert } = await import('../alerts/slack.js');
		await sendSlackAlert(
			env,
			`ai-gateway:pagecap:${gatewayId}:${today}`,
			KV_AUTH_WARN_DEDUP_TTL,
			{
				text: `:warning: cf-monitor: AI Gateway \`${gatewayId}\` hit the ${MAX_PAGES_PER_GATEWAY}-page-per-hour log collection cap. Some logs were truncated from the hourly aggregate.`,
			},
		);
	} catch (err) {
		console.warn(`[cf-monitor:ai-gateway] Failed to send page-cap alert: ${err}`);
	}
}

// =============================================================================
// SMALL HELPERS
// =============================================================================

function toNumber(v: unknown): number {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string') {
		const parsed = Number(v);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function round6(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.round(n * 1_000_000) / 1_000_000;
}

function medianMs(durations: number[]): number {
	if (durations.length === 0) return 0;
	const sorted = [...durations].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const p50 = sorted.length % 2 === 0
		? (sorted[mid - 1] + sorted[mid]) / 2
		: sorted[mid];
	return Math.round(p50);
}

/** Strip query string for log redaction (URLs include date params, no secrets). */
function redactUrl(url: string): string {
	const idx = url.indexOf('?');
	return idx === -1 ? url : url.slice(0, idx) + '?…';
}
