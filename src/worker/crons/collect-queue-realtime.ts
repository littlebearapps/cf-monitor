import { KV } from '../../constants.js';
import type {
	MonitorWorkerEnv,
	QueueRealtimeRow,
	QueueRealtimeSnapshot,
} from '../../types.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const KV_TTL_SECONDS = 2_764_800; // 32 days
const MAX_QUEUES_PER_RUN = 100;   // Defensive cap to keep per-hour collection cheap.

/**
 * Hourly: Collect realtime backlog metrics for every queue on the account via REST.
 *
 * Endpoints:
 *  - `GET /accounts/{id}/queues`                       — list queues
 *  - `GET /accounts/{id}/queues/{queue_id}/metrics`    — per-queue realtime backlog
 *
 * Fail-open: a single queue's metric failure must NOT fail the whole collection. We use
 * `Promise.allSettled` and embed an `error` field on rejected rows. The top-level
 * `partial` flag is set if any per-queue call failed; the worker logs once per cycle and
 * still persists the partial snapshot.
 */
export async function collectQueueRealtime(env: MonitorWorkerEnv): Promise<void> {
	if (!env.CLOUDFLARE_API_TOKEN || !env.CF_ACCOUNT_ID) {
		console.warn('[cf-monitor:queue-realtime] No CLOUDFLARE_API_TOKEN or CF_ACCOUNT_ID — skipping');
		return;
	}
	if (!ACCOUNT_ID_RE.test(env.CF_ACCOUNT_ID)) {
		console.error('[cf-monitor:queue-realtime] Invalid CF_ACCOUNT_ID format — must be 32-char hex');
		return;
	}

	const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
	const today = new Date().toISOString().slice(0, 10);

	// Step 1: list queues. A failure here is total; degrade gracefully and emit nothing.
	let queues: Array<{ queue_id: string; queue_name: string }>;
	try {
		const resp = await fetch(`${CF_API}/accounts/${env.CF_ACCOUNT_ID}/queues?per_page=${MAX_QUEUES_PER_RUN}`, { headers });
		if (!resp.ok) {
			console.warn(`[cf-monitor:queue-realtime] List queues failed (${resp.status}) — skipping`);
			return;
		}
		const body = (await resp.json()) as { result?: Array<{ queue_id?: string; queue_name?: string }> };
		queues = (body.result ?? []).map((q) => ({
			queue_id: q.queue_id ?? '',
			queue_name: q.queue_name ?? '',
		})).filter((q) => q.queue_id);
	} catch (err) {
		console.warn(`[cf-monitor:queue-realtime] List queues threw — skipping: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	// Step 2: per-queue metrics — settled concurrency, fail-open per queue.
	const settled = await Promise.allSettled(
		queues.map((q) => fetchQueueMetrics(env.CF_ACCOUNT_ID!, q.queue_id, q.queue_name, headers)),
	);

	let anyFailed = false;
	const rows: QueueRealtimeRow[] = settled.map((s) => {
		if (s.status === 'fulfilled') return s.value;
		anyFailed = true;
		// `Promise.allSettled` never reaches here because fetchQueueMetrics catches internally,
		// but be defensive in case of a synchronous throw upstream.
		return { id: '', name: '', error: s.reason instanceof Error ? s.reason.message : String(s.reason) };
	});
	if (rows.some((r) => r.error)) anyFailed = true;

	const snapshot: QueueRealtimeSnapshot = {
		collected_at: new Date().toISOString(),
		source: 'cloudflare_rest',
		confidence: 'runtime_metered',
		queues: rows,
		partial: anyFailed,
	};

	try {
		await env.CF_MONITOR_KV.put(
			`${KV.USAGE_QUEUE_REALTIME}${today}`,
			JSON.stringify(snapshot),
			{ expirationTtl: KV_TTL_SECONDS },
		);
	} catch (err) {
		console.warn(`[cf-monitor:queue-realtime] KV put failed: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	console.log(`[cf-monitor:queue-realtime] Collected backlog for ${rows.length} queues (${today})${anyFailed ? ' [partial]' : ''}`);
}

async function fetchQueueMetrics(
	accountId: string,
	queueId: string,
	queueName: string,
	headers: Record<string, string>,
): Promise<QueueRealtimeRow> {
	try {
		const resp = await fetch(`${CF_API}/accounts/${accountId}/queues/${encodeURIComponent(queueId)}/metrics`, { headers });
		if (!resp.ok) {
			return { id: queueId, name: queueName, error: `HTTP ${resp.status}` };
		}
		// Tolerate malformed bodies — they should not abort the run.
		const body = (await resp.json().catch(() => null)) as {
			result?: { backlog_count?: number; backlog_bytes?: number; oldest_message_timestamp_ms?: number };
		} | null;
		const m = body?.result;
		if (!m || typeof m !== 'object') {
			return { id: queueId, name: queueName, error: 'malformed_response' };
		}
		return {
			id: queueId,
			name: queueName,
			backlog_count: typeof m.backlog_count === 'number' ? m.backlog_count : undefined,
			backlog_bytes: typeof m.backlog_bytes === 'number' ? m.backlog_bytes : undefined,
			oldest_message_timestamp_ms: typeof m.oldest_message_timestamp_ms === 'number' ? m.oldest_message_timestamp_ms : undefined,
		};
	} catch (err) {
		return { id: queueId, name: queueName, error: err instanceof Error ? err.message : String(err) };
	}
}
