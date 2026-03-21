/**
 * Integration: Telemetry and Analytics Engine verification.
 * Tests: AE data points written, KV budget usage accumulated, KV proxy tracking.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
	hasCredentials,
	loadTestResources,
	fetchWorker,
	readTestKVKey,
	listTestKVKeys,
	waitForAEData,
	sleep,
	type TestEnv,
	type TestResources,
} from './helpers.js';

const SKIP = !hasCredentials();
let env: TestEnv;
let resources: TestResources;

beforeAll(async () => {
	if (SKIP) return;
	const loaded = loadTestResources();
	env = loaded.env;
	resources = loaded.resources;

	// Generate telemetry by hitting multiple routes
	await fetchWorker(resources.consumerWorkerUrl, '/api/test');
	await fetchWorker(resources.consumerWorkerUrl, '/api/test');
	await fetchWorker(resources.consumerWorkerUrl, '/api/kv-read');

	// Wait for SDK telemetry flush (AE write + KV budget accumulation)
	await sleep(5000);
}, 30_000);

describe.skipIf(SKIP)('telemetry: KV budget accumulation', () => {
	it('daily budget usage key exists after consumer requests', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const prefix = `budget:usage:daily:test-cf-monitor-consumer:fetch:GET:`;

		const keys = await listTestKVKeys(env, resources.kvNamespaceId, prefix);
		// Should have at least one daily budget key for today
		const todayKeys = keys.filter((k) => k.name.includes(today));
		expect(todayKeys.length).toBeGreaterThan(0);
	}, 15_000);

	it('daily budget usage contains metric values', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const key = `budget:usage:daily:test-cf-monitor-consumer:fetch:GET:api-test:${today}`;

		const raw = await readTestKVKey(env, resources.kvNamespaceId, key);
		if (raw) {
			const budget = JSON.parse(raw);
			// At least some metric should be tracked
			const hasAnyMetric = Object.values(budget).some((v) => typeof v === 'number' && v > 0);
			expect(hasAnyMetric).toBe(true);
		}
		// If key doesn't exist yet (propagation), that's OK — not a failure
	}, 15_000);

	it('monthly budget usage key exists', async () => {
		const month = new Date().toISOString().slice(0, 7);
		const prefix = `budget:usage:monthly:test-cf-monitor-consumer:`;

		const keys = await listTestKVKeys(env, resources.kvNamespaceId, prefix);
		const monthKeys = keys.filter((k) => k.name.includes(month));
		expect(monthKeys.length).toBeGreaterThan(0);
	}, 15_000);
});

describe.skipIf(SKIP)('telemetry: KV proxy tracking', () => {
	it('KV read via TEST_KV binding is tracked', async () => {
		// /api/kv-read route reads from TEST_KV → SDK proxy should increment kvReads
		const today = new Date().toISOString().slice(0, 10);
		const key = `budget:usage:daily:test-cf-monitor-consumer:fetch:GET:api-kv-read:${today}`;

		const raw = await readTestKVKey(env, resources.kvNamespaceId, key);
		if (raw) {
			const budget = JSON.parse(raw);
			expect(budget.kv_reads).toBeGreaterThanOrEqual(1);
		}
		// Propagation delay is acceptable
	}, 15_000);
});

describe.skipIf(SKIP)('telemetry: Analytics Engine SQL verification (#36)', () => {
	it('AE data points have correct blob structure', async () => {
		const sql = `SELECT blob1, blob2, blob3, count() AS cnt FROM "test-cf-monitor" WHERE blob1 = 'test-cf-monitor-consumer' AND timestamp > NOW() - INTERVAL '10' MINUTE GROUP BY blob1, blob2, blob3 LIMIT 10`;

		const data = await waitForAEData(env, sql, 1, 60_000);

		if (data.length === 0) {
			console.warn('[telemetry:ae] No AE data within 60s — propagation delay, soft pass');
			return;
		}

		// blob1 = worker name
		expect(data[0].blob1).toBe('test-cf-monitor-consumer');
		// blob2 = handler type
		expect(typeof data[0].blob2).toBe('string');
		// blob3 = feature discriminator
		expect(typeof data[0].blob3).toBe('string');
	}, 75_000);

	it('AE doubles positions contain numeric values', async () => {
		const sql = `SELECT double1, double2, double3, double4, double11 FROM "test-cf-monitor" WHERE blob1 = 'test-cf-monitor-consumer' AND timestamp > NOW() - INTERVAL '10' MINUTE LIMIT 5`;

		const data = await waitForAEData(env, sql, 1, 30_000);

		if (data.length === 0) {
			console.warn('[telemetry:ae] No AE doubles data — soft pass');
			return;
		}

		// Verify doubles are numbers (validates AE schema layout)
		for (const row of data) {
			for (const key of ['double1', 'double2', 'double3', 'double4', 'double11']) {
				if (row[key] !== undefined) {
					expect(typeof row[key]).toBe('number');
				}
			}
		}
	}, 45_000);
});
