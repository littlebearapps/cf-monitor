/**
 * Integration: Circuit breaker enforcement.
 * Tests: feature CB trip/reset via worker admin endpoints, account CB.
 *
 * Uses POST /admin/cb/* endpoints on the MONITOR worker to trip/reset CBs.
 * Worker-side KV writes propagate instantly to the consumer (same edge),
 * avoiding the 30-60s KV REST API eventual consistency delay.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
	hasCredentials,
	loadTestResources,
	fetchWorkerPost,
	waitForConsumerStatus,
	sleep,
	type TestEnv,
	type TestResources,
} from './helpers.js';

const SKIP = !hasCredentials();
let env: TestEnv;
let resources: TestResources;

const TEST_FEATURE = 'test-cf-monitor-consumer:fetch:GET:api-test';

beforeAll(() => {
	if (SKIP) return;
	const loaded = loadTestResources();
	env = loaded.env;
	resources = loaded.resources;
});

// Clean up ALL CB state after this file completes
afterAll(async () => {
	if (SKIP) return;
	try {
		await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cb/reset', { featureId: TEST_FEATURE });
		await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cb/account', { status: 'clear' });
	} catch {
		// Best effort
	}
});

describe.skipIf(SKIP)('circuit breaker: feature-level', () => {
	it('trip (STOP) returns 503 from consumer', async () => {
		// Trip CB via monitor worker admin endpoint (worker-side KV write)
		const tripResp = await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cb/trip', {
			featureId: TEST_FEATURE,
			reason: 'integration-test',
			ttlSeconds: 300,
		});
		expect(tripResp.status).toBe(200);

		// Worker-side write should propagate within seconds
		await sleep(2000);

		const resp = await waitForConsumerStatus(
			resources.consumerWorkerUrl, '/api/test', 503, 30_000
		);
		expect(resp.status).toBe(503);

		const body = await resp.json() as Record<string, unknown>;
		expect(body.error).toBe('Feature temporarily unavailable');
	}, 45_000);

	it('reset (GO) restores consumer to 200', async () => {
		// Reset CB via monitor worker admin endpoint
		const resetResp = await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cb/reset', {
			featureId: TEST_FEATURE,
		});
		expect(resetResp.status).toBe(200);

		await sleep(2000);

		const resp = await waitForConsumerStatus(
			resources.consumerWorkerUrl, '/api/test', 200, 30_000
		);
		expect(resp.status).toBe(200);

		const body = await resp.json() as Record<string, unknown>;
		expect(body.ok).toBe(true);
	}, 45_000);
});

describe.skipIf(SKIP)('circuit breaker: account-level', () => {
	// Ensure clean state before account tests
	beforeAll(async () => {
		await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cb/reset', { featureId: TEST_FEATURE });
		await sleep(2000);
		await waitForConsumerStatus(resources.consumerWorkerUrl, '/api/test', 200, 20_000);
	}, 30_000);

	it('account paused returns 503', async () => {
		const pauseResp = await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cb/account', {
			status: 'paused',
			ttlSeconds: 300,
		});
		expect(pauseResp.status).toBe(200);

		await sleep(2000);

		const resp = await waitForConsumerStatus(
			resources.consumerWorkerUrl, '/api/test', 503, 30_000
		);
		expect(resp.status).toBe(503);
	}, 45_000);

	it('account CB cleared restores service', async () => {
		const clearResp = await fetchWorkerPost(resources.monitorWorkerUrl, '/admin/cb/account', {
			status: 'clear',
		});
		expect(clearResp.status).toBe(200);

		await sleep(2000);

		const resp = await waitForConsumerStatus(
			resources.consumerWorkerUrl, '/api/test', 200, 30_000
		);
		expect(resp.status).toBe(200);
	}, 45_000);
});
