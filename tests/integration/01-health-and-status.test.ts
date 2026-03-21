/**
 * Integration: Monitor worker API endpoints.
 * Tests all GET routes: /_health, /status, /errors, /budgets, /workers
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { hasCredentials, loadTestResources, fetchWorker, type TestResources } from './helpers.js';

const SKIP = !hasCredentials();
let monitorUrl: string;

beforeAll(() => {
	if (SKIP) return;
	const { resources } = loadTestResources();
	monitorUrl = resources.monitorWorkerUrl;
});

describe.skipIf(SKIP)('monitor worker: API endpoints', () => {
	it('GET /_health returns healthy', async () => {
		const resp = await fetchWorker(monitorUrl, '/_health', { retries: 5 });
		expect(resp.status).toBe(200);

		const body = await resp.json() as Record<string, unknown>;
		expect(body.healthy).toBe(true);
		expect(body.account).toBe('test-account');
		expect(body.timestamp).toBeGreaterThan(0);
	}, 30_000);

	it('GET /status returns full status object', async () => {
		const resp = await fetchWorker(monitorUrl, '/status');
		expect(resp.status).toBe(200);

		const body = await resp.json() as Record<string, unknown>;
		expect(body).toHaveProperty('account');
		expect(body).toHaveProperty('accountId');
		expect(body).toHaveProperty('healthy');
		expect(body).toHaveProperty('circuitBreaker');
		expect(body).toHaveProperty('workers');
		expect(body).toHaveProperty('github');
		expect(body).toHaveProperty('slack');
		expect(body).toHaveProperty('timestamp');
		expect(body.timestamp).toBeGreaterThan(0);
	}, 15_000);

	it('GET /errors returns errors array', async () => {
		const resp = await fetchWorker(monitorUrl, '/errors');
		expect(resp.status).toBe(200);

		const body = await resp.json() as Record<string, unknown>;
		expect(body.account).toBe('test-account');
		expect(Array.isArray(body.errors)).toBe(true);
		expect(typeof body.count).toBe('number');
	}, 15_000);

	it('GET /budgets returns circuit breakers array', async () => {
		const resp = await fetchWorker(monitorUrl, '/budgets');
		expect(resp.status).toBe(200);

		const body = await resp.json() as Record<string, unknown>;
		expect(body.account).toBe('test-account');
		expect(Array.isArray(body.circuitBreakers)).toBe(true);
		expect(typeof body.count).toBe('number');
	}, 15_000);

	it('GET /workers returns workers array', async () => {
		const resp = await fetchWorker(monitorUrl, '/workers');
		expect(resp.status).toBe(200);

		const body = await resp.json() as Record<string, unknown>;
		expect(body.account).toBe('test-account');
		expect(Array.isArray(body.workers)).toBe(true);
		expect(typeof body.count).toBe('number');
	}, 15_000);
});
