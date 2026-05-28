import { KV } from '../../constants.js';
import type {
	MonitorWorkerEnv,
	VectorizeDiscoverySnapshot,
	VectorizeIndexRow,
} from '../../types.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const KV_TTL_SECONDS = 2_764_800; // 32 days
const PER_PAGE = 50;

/**
 * Daily: List Vectorize indexes on the account via REST.
 *
 * Endpoint: `GET /accounts/{id}/vectorize/indexes?per_page=50` (single page).
 *
 * **Metadata only.** We deliberately do NOT compute per-index vector counts in this pass —
 * that would require paginating `list_vectors` per index, which is expensive and can hit
 * CF API rate limits on accounts with many indexes. The snapshot carries an explicit
 * caveat so consumers know counts are not collected.
 *
 * If a future pass wants vector counts, gate it behind a configurable cap + opt-in.
 *
 * Fail-open: list failures (403/5xx/network) are logged and skip the KV write.
 */
export async function discoverVectorizeIndexes(env: MonitorWorkerEnv): Promise<void> {
	if (!env.CLOUDFLARE_API_TOKEN || !env.CF_ACCOUNT_ID) {
		console.warn('[cf-monitor:vectorize] No CLOUDFLARE_API_TOKEN or CF_ACCOUNT_ID — skipping');
		return;
	}
	if (!ACCOUNT_ID_RE.test(env.CF_ACCOUNT_ID)) {
		console.error('[cf-monitor:vectorize] Invalid CF_ACCOUNT_ID format — must be 32-char hex');
		return;
	}

	const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
	const today = new Date().toISOString().slice(0, 10);

	let raw: Array<Record<string, unknown>>;
	try {
		const resp = await fetch(`${CF_API}/accounts/${env.CF_ACCOUNT_ID}/vectorize/indexes?per_page=${PER_PAGE}`, { headers });
		if (!resp.ok) {
			console.warn(`[cf-monitor:vectorize] List indexes failed (${resp.status}) — skipping`);
			return;
		}
		const body = (await resp.json()) as { result?: unknown };
		if (!Array.isArray(body.result)) {
			console.warn('[cf-monitor:vectorize] Malformed list response — skipping');
			return;
		}
		raw = body.result as Array<Record<string, unknown>>;
	} catch (err) {
		console.warn(`[cf-monitor:vectorize] List indexes threw — skipping: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	const indexes: VectorizeIndexRow[] = raw.map((idx) => {
		const config = idx.config as Record<string, unknown> | undefined;
		const row: VectorizeIndexRow = {
			name: typeof idx.name === 'string' ? idx.name : '',
		};
		// Try `config.dimensions`/`config.metric` first (V2 API), fall back to flat fields (V1).
		const dimsRaw = config?.dimensions ?? idx.dimensions;
		if (typeof dimsRaw === 'number') row.dimensions = dimsRaw;
		const metricRaw = config?.metric ?? idx.metric;
		if (typeof metricRaw === 'string') row.metric = metricRaw;
		if (typeof idx.description === 'string') row.description = idx.description;
		if (typeof idx.created_on === 'string') row.created_on = idx.created_on;
		if (typeof idx.modified_on === 'string') row.modified_on = idx.modified_on;
		return row;
	});

	const snapshot: VectorizeDiscoverySnapshot = {
		collected_at: new Date().toISOString(),
		source: 'cloudflare_rest',
		confidence: 'runtime_metered',
		indexes,
		partial: false,
		caveat: 'Per-index vector counts not collected — would require paginating list_vectors per index, which risks CF API rate-limit cost. Metadata only this pass.',
	};

	try {
		await env.CF_MONITOR_KV.put(
			`${KV.USAGE_VECTORIZE_DISCOVERY}${today}`,
			JSON.stringify(snapshot),
			{ expirationTtl: KV_TTL_SECONDS },
		);
	} catch (err) {
		console.warn(`[cf-monitor:vectorize] KV put failed: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	console.log(`[cf-monitor:vectorize] Discovered ${indexes.length} Vectorize index(es) (${today})`);
}
