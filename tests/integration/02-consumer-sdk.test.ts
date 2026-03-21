/**
 * Integration: Consumer SDK features.
 * Tests: health endpoint, multi-route, POST method, 404, last_seen KV.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
	hasCredentials,
	loadTestResources,
	fetchWorker,
	readTestKVKey,
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

describe.skipIf(SKIP)('consumer SDK features', () => {
	it('SDK health endpoint at /_monitor/health', async () => {
		const resp = await fetchWorker(resources.consumerWorkerUrl, '/_monitor/health', { retries: 5 });
		expect(resp.status).toBe(200);

		const body = await resp.json() as Record<string, unknown>;
		expect(body.healthy).toBe(true);
		expect(body.worker).toBe('test-cf-monitor-consumer');
		expect(body.bindings).toBe(true);
	}, 30_000);

	it('GET /api/test returns 200', async () => {
		// Use retries — stale CB state from previous run may briefly cause 503
		const resp = await fetchWorker(resources.consumerWorkerUrl, '/api/test', {
			retries: 5, delayMs: 3000, expectStatus: 200,
		});
		expect(resp.status).toBe(200);

		const body = await resp.json() as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.timestamp).toBeGreaterThan(0);
	}, 30_000);

	it('GET /api/users/123 normalises path (strips numeric segment)', async () => {
		const resp = await fetchWorker(resources.consumerWorkerUrl, '/api/users/123');
		expect(resp.status).toBe(200);

		const body = await resp.json() as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.route).toBe('users');
	}, 15_000);

	it('POST /api/submit returns 200 with method', async () => {
		const resp = await fetch(`${resources.consumerWorkerUrl}/api/submit`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ data: 'test' }),
		});
		expect(resp.status).toBe(200);

		const body = await resp.json() as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.method).toBe('POST');
	}, 15_000);

	it('Unknown route returns 404', async () => {
		const resp = await fetchWorker(resources.consumerWorkerUrl, '/nonexistent');
		expect(resp.status).toBe(404);
	}, 10_000);

	it('SDK writes last_seen to KV after request', async () => {
		// Make a request to trigger telemetry flush
		await fetchWorker(resources.consumerWorkerUrl, '/api/test');
		await sleep(5000);

		// Read last_seen via KV REST API
		const lastSeen = await readTestKVKey(
			env,
			resources.kvNamespaceId,
			'workers:test-cf-monitor-consumer:last_seen'
		);

		expect(lastSeen).not.toBeNull();
		const ts = new Date(lastSeen!);
		expect(ts.getTime()).not.toBeNaN();
		// Should be within last 60 seconds
		expect(Date.now() - ts.getTime()).toBeLessThan(60_000);
	}, 20_000);
});
