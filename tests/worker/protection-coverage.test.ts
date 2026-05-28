import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	buildProtectionReport,
	computeProtectionScore,
} from '../../src/worker/protection-coverage.js';
import type {
	MonitorWorkerEnv,
	ProtectionFinding,
	ProtectionCoverageReport,
} from '../../src/types.js';
import { KV } from '../../src/constants.js';

function mockEnv(overrides?: Partial<MonitorWorkerEnv>): MonitorWorkerEnv {
	const store = new Map<string, string>();
	return {
		CF_MONITOR_KV: {
			get: vi.fn(async (key: string) => store.get(key) ?? null),
			put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
			delete: vi.fn(async (key: string) => { store.delete(key); }),
			list: vi.fn(async (opts?: { prefix?: string }) => {
				const prefix = opts?.prefix ?? '';
				const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
				return { keys, list_complete: true, cacheStatus: null };
			}),
			getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
		} as unknown as KVNamespace,
		CF_MONITOR_AE: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
		CF_ACCOUNT_ID: 'aabbccdd11223344aabbccdd11223344',
		ACCOUNT_NAME: 'test-account',
		CLOUDFLARE_API_TOKEN: 'test-token',
		...overrides,
	};
}

async function seedKV(env: MonitorWorkerEnv, key: string, value: unknown): Promise<void> {
	await env.CF_MONITOR_KV.put(key, JSON.stringify(value));
}

function findingById(report: ProtectionCoverageReport, id: string): ProtectionFinding | undefined {
	return report.findings.find((f) => f.id === id);
}

describe('computeProtectionScore', () => {
	it('returns 100 for an empty list', () => {
		expect(computeProtectionScore([])).toBe(100);
	});

	it('penalises unprotected findings by severity', () => {
		const f = (sev: 'critical' | 'high' | 'medium' | 'low' | 'info', status: 'unprotected' | 'partially_protected'): ProtectionFinding => ({
			id: 'x', title: 't', severity: sev, status,
			resource_type: 'global', evidence: '', missing_controls: [], recommended_actions: [],
			confidence: 'unknown', source: 'test', destructive_action_required: false,
		});
		expect(computeProtectionScore([f('critical', 'unprotected')])).toBe(80);
		expect(computeProtectionScore([f('high', 'unprotected')])).toBe(88);
		expect(computeProtectionScore([f('medium', 'unprotected')])).toBe(94);
		expect(computeProtectionScore([f('low', 'unprotected')])).toBe(98);
		expect(computeProtectionScore([f('info', 'unprotected')])).toBe(100);
	});

	it('halves penalty for partially_protected (ceil)', () => {
		const f: ProtectionFinding = {
			id: 'x', title: 't', severity: 'high', status: 'partially_protected',
			resource_type: 'global', evidence: '', missing_controls: [], recommended_actions: [],
			confidence: 'unknown', source: 'test', destructive_action_required: false,
		};
		expect(computeProtectionScore([f])).toBe(94); // ceil(12/2) = 6
	});

	it('caps unknown high-risk penalty at 5', () => {
		const f: ProtectionFinding = {
			id: 'x', title: 't', severity: 'critical', status: 'unknown',
			resource_type: 'global', evidence: '', missing_controls: [], recommended_actions: [],
			confidence: 'unknown', source: 'test', destructive_action_required: false,
		};
		expect(computeProtectionScore([f])).toBe(95); // min(5, ceil(20/2)) = 5
	});

	it('clamps to 0', () => {
		const f: ProtectionFinding = {
			id: 'x', title: 't', severity: 'critical', status: 'unprotected',
			resource_type: 'global', evidence: '', missing_controls: [], recommended_actions: [],
			confidence: 'unknown', source: 'test', destructive_action_required: false,
		};
		expect(computeProtectionScore([f, f, f, f, f, f])).toBe(0); // 6 × 20 = 120, clamp 0
	});

	it('ignores protected / not_applicable findings', () => {
		const f = (status: 'protected' | 'not_applicable'): ProtectionFinding => ({
			id: 'x', title: 't', severity: 'critical', status,
			resource_type: 'global', evidence: '', missing_controls: [], recommended_actions: [],
			confidence: 'unknown', source: 'test', destructive_action_required: false,
		});
		expect(computeProtectionScore([f('protected'), f('not_applicable')])).toBe(100);
	});
});

describe('buildProtectionReport — empty account smoke', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('returns a valid report when no KV data exists', async () => {
		const env = mockEnv();
		const report = await buildProtectionReport(env);
		expect(report.generated_at).toBeTruthy();
		expect(report.account).toBe('test-account');
		expect(report.caveats.length).toBeGreaterThan(0);
		expect(report.confidence.overall).toBeTruthy();
		// Always-present strategic findings: billing reality, budget alert (missing), worker CPU, safe-mode, etc.
		expect(findingById(report, 'billing-reality-check')).toBeDefined();
		expect(findingById(report, 'budget-alert-missing')).toBeDefined();
		expect(findingById(report, 'worker-cpu-limits-not-audited')).toBeDefined();
		expect(findingById(report, 'safe-mode-controls-deferred')).toBeDefined();
		expect(report.summary.score).toBeGreaterThanOrEqual(0);
		expect(report.summary.score).toBeLessThanOrEqual(100);
	});

	it('confidence.runtime is `unknown` with no heartbeats and `runtime_metered` with one', async () => {
		const env = mockEnv();
		const empty = await buildProtectionReport(env);
		expect(empty.confidence.runtime).toBe('unknown');

		// Seed a heartbeat
		await env.CF_MONITOR_KV.put(`${KV.WORKER_REGISTRY}svc-a:last_seen`, new Date().toISOString());
		await seedKV(env, KV.WORKER_LIST, ['svc-a']);
		const seeded = await buildProtectionReport(env);
		expect(seeded.confidence.runtime).toBe('runtime_metered');
	});
});

describe('buildProtectionReport — finding helpers', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('budget alert: registered → partially_protected with alert_only confidence', async () => {
		const env = mockEnv();
		await seedKV(env, KV.CONFIG_BUDGET_ALERT, {
			policy_id: 'pol-1', threshold: 100, alert_type: 'billing_budget_alert',
			label: 'alert_only', recipient: 'email', registered_at: '2026-05-28T00:00:00Z',
			dashboard_threshold_url: 'https://dash.cloudflare.com/',
		});
		const report = await buildProtectionReport(env);
		const f = findingById(report, 'budget-alert-registered');
		expect(f?.status).toBe('partially_protected');
		expect(f?.confidence).toBe('alert_only');
		expect(f?.recommended_actions.join(' ')).toContain('dashboard');
	});

	it('queue storm: normal backlog produces no critical findings, info-level presence finding only', async () => {
		const env = mockEnv();
		const today = new Date().toISOString().slice(0, 10);
		await seedKV(env, `${KV.USAGE_QUEUE_REALTIME}${today}`, {
			collected_at: '2026-05-28T00:00:00Z', source: 'cloudflare_rest', confidence: 'runtime_metered',
			queues: [{ id: 'q1', name: 'tasks', backlog_count: 50, backlog_bytes: 1024, oldest_message_timestamp_ms: Date.now() - 60_000 }],
			partial: false,
		});
		const report = await buildProtectionReport(env);
		expect(findingById(report, 'queue-realtime-present')).toBeDefined();
		expect(findingById(report, 'queue-backlog:q1')).toBeUndefined();
		expect(findingById(report, 'queue-age:q1')).toBeUndefined();
	});

	it('queue storm: empty queues (backlog 0 + timestamp 0) do NOT trigger age findings (regression — Platform false positive 2026-05-28)', async () => {
		const env = mockEnv();
		const today = new Date().toISOString().slice(0, 10);
		await seedKV(env, `${KV.USAGE_QUEUE_REALTIME}${today}`, {
			collected_at: '2026-05-28T00:00:00Z', source: 'cloudflare_rest', confidence: 'runtime_metered',
			queues: [
				// CF API returns oldest_message_timestamp_ms = 0 when a queue is empty. Without the
				// fix, Date.now() - 0 would bucket as critical (>6h).
				{ id: 'q-empty', name: 'platform-telemetry-dlq', backlog_count: 0, backlog_bytes: 0, oldest_message_timestamp_ms: 0 },
			],
			partial: false,
		});
		const report = await buildProtectionReport(env);
		expect(findingById(report, 'queue-age:q-empty'), 'empty queue should NOT trip queue-age').toBeUndefined();
		expect(findingById(report, 'queue-backlog:q-empty'), 'empty queue should NOT trip queue-backlog').toBeUndefined();
	});

	it('queue storm: thresholds map to correct severities', async () => {
		const env = mockEnv();
		const today = new Date().toISOString().slice(0, 10);
		await seedKV(env, `${KV.USAGE_QUEUE_REALTIME}${today}`, {
			collected_at: '2026-05-28T00:00:00Z', source: 'cloudflare_rest', confidence: 'runtime_metered',
			queues: [
				{ id: 'qm', name: 'medium', backlog_count: 2_000 },        // medium
				{ id: 'qh', name: 'high', backlog_count: 50_000 },          // high
				{ id: 'qc', name: 'critical', backlog_count: 250_000 },     // critical
				{ id: 'qa', name: 'old', backlog_count: 100, oldest_message_timestamp_ms: Date.now() - 7 * 3_600_000 }, // age > 6h
			],
			partial: false,
		});
		const report = await buildProtectionReport(env);
		expect(findingById(report, 'queue-backlog:qm')?.severity).toBe('medium');
		expect(findingById(report, 'queue-backlog:qh')?.severity).toBe('high');
		expect(findingById(report, 'queue-backlog:qc')?.severity).toBe('critical');
		expect(findingById(report, 'queue-age:qa')?.severity).toBe('critical');
	});

	it('pages: every project carries the static-vs-Functions caveat (functions_usage unknown)', async () => {
		const env = mockEnv();
		const today = new Date().toISOString().slice(0, 10);
		await seedKV(env, `${KV.USAGE_PAGES_DISCOVERY}${today}`, {
			collected_at: '2026-05-28T00:00:00Z', source: 'cloudflare_rest', confidence: 'runtime_metered',
			projects: [{ name: 'marketing', id: 'p1', functions_usage: 'unknown' }],
			partial: false,
		});
		const report = await buildProtectionReport(env);
		const f = findingById(report, 'pages-project:p1');
		expect(f?.status).toBe('unknown');
		expect(f?.evidence).toContain('static assets are free');
	});

	it('vectorize: every index gets the vector-count-not-collected caveat', async () => {
		const env = mockEnv();
		const today = new Date().toISOString().slice(0, 10);
		await seedKV(env, `${KV.USAGE_VECTORIZE_DISCOVERY}${today}`, {
			collected_at: '2026-05-28T00:00:00Z', source: 'cloudflare_rest', confidence: 'runtime_metered',
			indexes: [{ name: 'embeddings', dimensions: 1536, metric: 'cosine' }],
			partial: false,
			caveat: 'metadata only',
		});
		const report = await buildProtectionReport(env);
		const f = findingById(report, 'vectorize-index:embeddings');
		expect(f?.status).toBe('partially_protected');
		expect(f?.evidence).toContain('vector counts NOT collected');
	});

	it('billing reality: emitted regardless of state with dashboard-only framing', async () => {
		const env = mockEnv();
		const report = await buildProtectionReport(env);
		const f = findingById(report, 'billing-reality-check');
		expect(f?.status).toBe('partially_protected');
		expect(f?.evidence).toContain('/billing/usage');
		expect(report.confidence.billing).toBe('dashboard_documented_no_public_api');
	});

	it('runtime SDK coverage: discovered worker without heartbeat is partially_protected (not fully protected)', async () => {
		const env = mockEnv();
		await seedKV(env, KV.WORKER_LIST, ['svc-a', 'svc-b']);
		await env.CF_MONITOR_KV.put(`${KV.WORKER_REGISTRY}svc-a:last_seen`, new Date().toISOString());
		const report = await buildProtectionReport(env);
		expect(findingById(report, 'runtime-sdk:svc-a')?.status).toBe('protected');
		expect(findingById(report, 'runtime-sdk-missing:svc-b')?.status).toBe('partially_protected');
		// Crucial: discovery WITHOUT heartbeat is not marked "protected" — visibility ≠ enforcement.
		expect(findingById(report, 'runtime-sdk:svc-b')).toBeUndefined();
	});

	it('R2 ListBucket finding surfaces only when R2 usage is observed', async () => {
		const env = mockEnv();
		const today = new Date().toISOString().slice(0, 10);
		const reportNoR2 = await buildProtectionReport(env);
		expect(findingById(reportNoR2, 'r2-listbucket-unknown')).toBeUndefined();

		await seedKV(env, `${KV.USAGE_ACCOUNT}${today}`, {
			collected_at: '2026-05-28T00:00:00Z',
			disclaimer: '...',
			services: { r2: { classA: 100, classB: 50 } },
		});
		const reportWithR2 = await buildProtectionReport(env);
		expect(findingById(reportWithR2, 'r2-listbucket-unknown')?.confidence).toBe('unknown');
	});

	it('AI Gateway native controls: emits a high-severity unknown when AI Gateway data is present', async () => {
		const env = mockEnv();
		const today = new Date().toISOString().slice(0, 10);
		await seedKV(env, `${KV.USAGE_ACCOUNT_AI_GATEWAY}${today}`, {
			date: today, gateways: {}, totals: { requests: 0, tokens_in: 0, tokens_out: 0, cost: 0, cached: 0, errors: 0 },
			lastUpdated: Date.now(), disclaimer: '...',
		});
		const report = await buildProtectionReport(env);
		const f = findingById(report, 'ai-gateway-native-controls-unknown');
		expect(f?.severity).toBe('high');
		expect(f?.status).toBe('unknown');
	});
});
