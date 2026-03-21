/**
 * Integration: Budget enforcement pipeline.
 * Tests: seed budget config → seed exceeded usage → trigger budget-check cron → CB trips.
 * Safety: No SLACK_WEBHOOK_URL on test worker → no Slack spam. Test KV namespace → no production impact.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
	hasCredentials,
	loadTestResources,
	writeTestKVKey,
	readTestKVKey,
	deleteTestKVKey,
	fetchWorkerPost,
	sleep,
	type TestEnv,
	type TestResources,
} from './helpers.js';

const SKIP = !hasCredentials();
let env: TestEnv;
let resources: TestResources;

const TEST_FEATURE = 'test-budget-feature:fetch:GET:test';
const BUDGET_CONFIG_KEY = `budget:config:${TEST_FEATURE}`;
const CB_KEY = `cb:v1:feature:${TEST_FEATURE}`;

beforeAll(() => {
	if (SKIP) return;
	const loaded = loadTestResources();
	env = loaded.env;
	resources = loaded.resources;
});

// Always clean up budget test data
afterAll(async () => {
	if (SKIP) return;
	try {
		const today = new Date().toISOString().slice(0, 10);
		await Promise.all([
			deleteTestKVKey(env, resources.kvNamespaceId, BUDGET_CONFIG_KEY),
			deleteTestKVKey(env, resources.kvNamespaceId, `budget:usage:daily:${TEST_FEATURE}:${today}`),
			deleteTestKVKey(env, resources.kvNamespaceId, CB_KEY),
			deleteTestKVKey(env, resources.kvNamespaceId, `${CB_KEY}:reason`),
		]);
	} catch {
		// Best effort cleanup
	}
});

describe.skipIf(SKIP)('budget enforcement: seed → cron → CB trip', () => {
	it('seed budget config and exceeded usage in KV', async () => {
		const today = new Date().toISOString().slice(0, 10);

		// Set a very low budget limit
		await writeTestKVKey(env, resources.kvNamespaceId, BUDGET_CONFIG_KEY, JSON.stringify({
			kv_reads: 5,
		}));

		// Set usage that exceeds the limit
		await writeTestKVKey(env, resources.kvNamespaceId,
			`budget:usage:daily:${TEST_FEATURE}:${today}`,
			JSON.stringify({ kv_reads: 10 })
		);

		// Wait for KV propagation
		await sleep(5000);

		// Verify seeds are readable
		const config = await readTestKVKey(env, resources.kvNamespaceId, BUDGET_CONFIG_KEY);
		expect(config).not.toBeNull();
	}, 20_000);

	it('budget-check cron trips CB for exceeded feature', async () => {
		// Trigger the budget-check cron via admin endpoint
		const resp = await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cron/budget-check', {});
		expect(resp.status).toBe(200);

		const body = await resp.json() as { ok: boolean; cron: string };
		expect(body.ok).toBe(true);
		expect(body.cron).toBe('budget-check');

		// Wait for KV writes from the cron
		await sleep(5000);

		// Verify CB was tripped
		const cbValue = await readTestKVKey(env, resources.kvNamespaceId, CB_KEY);
		expect(cbValue).toBe('STOP');
	}, 30_000);

	it('cleanup: reset CB via worker admin endpoint', async () => {
		// Use worker-side reset (instant propagation) instead of REST API write
		const resp = await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cb/reset', {
			featureId: TEST_FEATURE,
		});
		expect(resp.status).toBe(200);

		const body = await resp.json() as { ok: boolean; action: string };
		expect(body.ok).toBe(true);
		expect(body.action).toBe('reset');
	}, 15_000);
});
