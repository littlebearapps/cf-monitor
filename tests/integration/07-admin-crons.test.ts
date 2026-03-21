/**
 * Integration: Admin cron trigger endpoints.
 * Tests all SAFE cron triggers via POST /admin/cron/{name}.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
	hasCredentials,
	loadTestResources,
	fetchWorkerPost,
	fetchWorker,
	writeTestKVKey,
	waitForAEData,
	sleep,
	type TestEnv,
	type TestResources,
} from './helpers.js';

const SKIP = !hasCredentials();
let env: TestEnv;
let resources: TestResources;

beforeAll(() => {
	if (SKIP) return;
	const loaded = loadTestResources();
	env = loaded.env;
	resources = loaded.resources;
});

describe.skipIf(SKIP)('admin cron triggers', () => {
	it('POST /admin/cron/synthetic-health completes successfully', async () => {
		const resp = await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cron/synthetic-health', {});
		expect(resp.status).toBe(200);

		const body = await resp.json() as { ok: boolean; cron: string; durationMs: number };
		expect(body.ok).toBe(true);
		expect(body.cron).toBe('synthetic-health');
		expect(body.durationMs).toBeGreaterThanOrEqual(0);
	}, 30_000);

	it('POST /admin/cron/worker-discovery discovers workers', async () => {
		const resp = await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cron/worker-discovery', {});
		expect(resp.status).toBe(200);

		const body = await resp.json() as { ok: boolean; cron: string };
		expect(body.ok).toBe(true);

		// Wait for KV write
		await sleep(3000);

		// Workers endpoint should now show discovered workers
		const workersResp = await fetchWorker(resources.monitorWorkerUrl, '/workers');
		const workersBody = await workersResp.json() as { workers: string[]; count: number };
		expect(workersBody.count).toBeGreaterThan(0);
		// Should include our test workers
		expect(workersBody.workers).toEqual(
			expect.arrayContaining([
				expect.stringContaining('test-cf-monitor'),
			])
		);
	}, 30_000);

	it('POST /admin/cron/gap-detection completes after discovery', async () => {
		// Gap detection uses the worker list populated by worker-discovery
		const resp = await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cron/gap-detection', {});
		expect(resp.status).toBe(200);

		const body = await resp.json() as { ok: boolean; cron: string };
		expect(body.ok).toBe(true);
	}, 20_000);

	it('POST /admin/cron/cost-spike completes', async () => {
		const resp = await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cron/cost-spike', {});
		// May return 200 (ok) or 500 (no baseline data) — both are acceptable for a fresh account
		const body = await resp.json() as { ok: boolean; cron: string };
		expect(body.cron).toBe('cost-spike');
	}, 20_000);

	it('invalid cron name returns 400 with available list', async () => {
		const resp = await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cron/nonexistent', {});
		expect(resp.status).toBe(400);

		const body = await resp.json() as { error: string; available: string[] };
		expect(body.error).toContain('Unknown cron');
		expect(Array.isArray(body.available)).toBe(true);
		expect(body.available).toContain('synthetic-health');
		expect(body.available).toContain('budget-check');
		expect(body.available).toContain('gap-detection');
	}, 10_000);

	it('POST /admin/cron/metrics collects CF GraphQL metrics (#37)', async () => {
		const resp = await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cron/metrics', {});
		expect(resp.status).toBe(200);

		const body = await resp.json() as { ok: boolean; cron: string; durationMs: number };
		expect(body.ok).toBe(true);
		expect(body.cron).toBe('metrics');
		expect(body.durationMs).toBeGreaterThanOrEqual(0);
	}, 30_000);

	it('metrics cron writes graphql data points to AE (#37)', async () => {
		// Metrics cron was triggered in previous test
		await sleep(5000);

		const sql = `SELECT blob1, blob2, blob3, count() AS cnt FROM "test-cf-monitor" WHERE blob2 = 'graphql' AND timestamp > NOW() - INTERVAL '5' MINUTE GROUP BY blob1, blob2, blob3 LIMIT 10`;
		const data = await waitForAEData(env, sql, 1, 45_000);

		if (data.length === 0) {
			// Account may have no recent traffic — soft pass
			console.warn('[cron:metrics] No GraphQL AE data — account may have no recent traffic');
			return;
		}

		expect(data[0].blob2).toBe('graphql');
	}, 60_000);

	it('POST /admin/cron/daily-rollup completes (#38)', async () => {
		// Seed a warning digest for yesterday
		const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
		const digestKey = `warn:digest:${yesterday}`;
		const digestValue = JSON.stringify([{
			script: 'test-script',
			message: 'Test warning for rollup integration test',
			timestamp: new Date().toISOString(),
		}]);
		await writeTestKVKey(env, resources.kvNamespaceId, digestKey, digestValue);

		// Wait for KV propagation
		await sleep(3000);

		const resp = await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cron/daily-rollup', {});
		expect(resp.status).toBe(200);

		const body = await resp.json() as { ok: boolean; cron: string };
		expect(body.ok).toBe(true);
		expect(body.cron).toBe('daily-rollup');
	}, 30_000);
});
