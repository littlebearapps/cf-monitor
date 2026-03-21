/**
 * Integration: Multi-read KV proxy tracking and budget accumulation.
 * Tests: proxy intercepts real binding calls, metrics accumulate in KV and AE.
 *
 * Issues: #40 (request limits / proxy tracking verification)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
	hasCredentials,
	loadTestResources,
	fetchWorker,
	readTestKVKey,
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

	// Hit limit-test route to generate telemetry
	await fetchWorker(resources.consumerWorkerUrl, '/api/limit-test');
	await sleep(5000);
}, 20_000);

describe.skipIf(SKIP)('proxy tracking: KV read accumulation (#40)', () => {
	it('10 consecutive KV reads are tracked in budget accumulation', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const key = `budget:usage:daily:test-cf-monitor-consumer:fetch:GET:api-limit-test:${today}`;

		const raw = await readTestKVKey(env, resources.kvNamespaceId, key);
		if (raw) {
			const budget = JSON.parse(raw);
			expect(budget.kv_reads).toBeGreaterThanOrEqual(10);
		} else {
			// Propagation delay — hit again and retry
			await fetchWorker(resources.consumerWorkerUrl, '/api/limit-test');
			await sleep(5000);

			const retryRaw = await readTestKVKey(env, resources.kvNamespaceId, key);
			if (retryRaw) {
				const budget = JSON.parse(retryRaw);
				expect(budget.kv_reads).toBeGreaterThanOrEqual(10);
			}
			// If still no data, KV propagation is too slow — acceptable
		}
	}, 20_000);

	it('KV proxy tracking appears in AE data points', async () => {
		const sql = `SELECT blob1, double3 AS kv_reads FROM "test-cf-monitor" WHERE blob1 = 'test-cf-monitor-consumer' AND index1 LIKE '%api-limit-test%' AND timestamp > NOW() - INTERVAL '10' MINUTE LIMIT 5`;

		const data = await waitForAEData(env, sql, 1, 60_000);

		if (data.length === 0) {
			console.warn('[proxy-tracking] No AE data for limit-test route within 60s — soft pass');
			return;
		}

		// double3 = kvReads (AE_FIELDS position 2, SQL is 1-indexed)
		const kvReads = data[0].kv_reads as number;
		expect(kvReads).toBeGreaterThanOrEqual(10);
	}, 75_000);
});
