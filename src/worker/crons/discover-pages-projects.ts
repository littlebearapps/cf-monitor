import { KV } from '../../constants.js';
import type {
	MonitorWorkerEnv,
	PagesDiscoverySnapshot,
	PagesProjectRow,
} from '../../types.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const KV_TTL_SECONDS = 2_764_800; // 32 days
const PER_PAGE = 100;

/**
 * Daily: List Pages projects on the account via REST.
 *
 * Endpoint: `GET /accounts/{id}/pages/projects?per_page=100` (single page only).
 * If the account has more than 100 Pages projects the response is truncated and
 * `partial: true` is set — extremely unlikely for any account we monitor.
 *
 * Pages billing: static assets are free; only Pages Functions are billed (as Workers).
 * We do NOT probe per-project to determine whether Functions are used — that would cost
 * extra REST calls per project. Every row carries `functions_usage: 'unknown'`, and the
 * dashboard should NOT imply every Pages project is billable.
 *
 * Fail-open: list failures (403/5xx/network) are logged and skip the KV write.
 */
export async function discoverPagesProjects(env: MonitorWorkerEnv): Promise<void> {
	if (!env.CLOUDFLARE_API_TOKEN || !env.CF_ACCOUNT_ID) {
		console.warn('[cf-monitor:pages] No CLOUDFLARE_API_TOKEN or CF_ACCOUNT_ID — skipping');
		return;
	}
	if (!ACCOUNT_ID_RE.test(env.CF_ACCOUNT_ID)) {
		console.error('[cf-monitor:pages] Invalid CF_ACCOUNT_ID format — must be 32-char hex');
		return;
	}

	const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
	const today = new Date().toISOString().slice(0, 10);

	let raw: Array<Record<string, unknown>>;
	let partial = false;
	try {
		const resp = await fetch(`${CF_API}/accounts/${env.CF_ACCOUNT_ID}/pages/projects?per_page=${PER_PAGE}`, { headers });
		if (!resp.ok) {
			console.warn(`[cf-monitor:pages] List projects failed (${resp.status}) — skipping`);
			return;
		}
		const body = (await resp.json()) as { result?: unknown; result_info?: { total_count?: number } };
		if (!Array.isArray(body.result)) {
			console.warn('[cf-monitor:pages] Malformed list response — skipping');
			return;
		}
		raw = body.result as Array<Record<string, unknown>>;
		const total = body.result_info?.total_count;
		if (typeof total === 'number' && total > raw.length) partial = true;
	} catch (err) {
		console.warn(`[cf-monitor:pages] List projects threw — skipping: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	const projects: PagesProjectRow[] = raw.map((p) => {
		const latest = p.latest_deployment as Record<string, unknown> | undefined;
		const row: PagesProjectRow = {
			name: typeof p.name === 'string' ? p.name : '',
			functions_usage: 'unknown',
		};
		if (typeof p.id === 'string') row.id = p.id;
		if (typeof p.production_branch === 'string') row.production_branch = p.production_branch;
		if (typeof p.created_on === 'string') row.created_on = p.created_on;
		if (typeof p.modified_on === 'string') row.modified_on = p.modified_on;
		if (latest && typeof latest === 'object') {
			row.latest_deployment = {
				id: typeof latest.id === 'string' ? latest.id : undefined,
				stage: typeof latest.latest_stage === 'object' && latest.latest_stage && typeof (latest.latest_stage as Record<string, unknown>).name === 'string'
					? ((latest.latest_stage as Record<string, unknown>).name as string)
					: undefined,
				created_on: typeof latest.created_on === 'string' ? latest.created_on : undefined,
			};
		}
		return row;
	});

	const snapshot: PagesDiscoverySnapshot = {
		collected_at: new Date().toISOString(),
		source: 'cloudflare_rest',
		confidence: 'runtime_metered',
		projects,
		partial,
	};

	try {
		await env.CF_MONITOR_KV.put(
			`${KV.USAGE_PAGES_DISCOVERY}${today}`,
			JSON.stringify(snapshot),
			{ expirationTtl: KV_TTL_SECONDS },
		);
	} catch (err) {
		console.warn(`[cf-monitor:pages] KV put failed: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	console.log(`[cf-monitor:pages] Discovered ${projects.length} Pages project(s) (${today})${partial ? ' [partial — paginated]' : ''}`);
}
