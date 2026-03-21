/**
 * Vitest global setup/teardown for integration tests.
 * Deploys test workers ONCE, shares resources via temp JSON file.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import {
	hasCredentials,
	getTestEnv,
	setupTestResources,
	teardownTestResources,
	type TestResources,
} from './helpers.js';

const ENV_FILE = '/tmp/cf-monitor-integration-env.json';

export async function setup(): Promise<void> {
	if (!hasCredentials()) {
		console.log('[integration:setup] No credentials — skipping deployment');
		return;
	}

	console.log('[integration:setup] Deploying test workers...');
	const env = getTestEnv();
	const resources = await setupTestResources(env);

	// Write shared state for test files
	writeFileSync(ENV_FILE, JSON.stringify({
		...resources,
		accountId: env.accountId,
		apiToken: env.apiToken,
	}));

	// Clear any stale CB state from previous runs (KV namespace may be reused)
	try {
		console.log('[integration:setup] Clearing stale CB state...');
		await fetch(`${resources.monitorWorkerUrl}/admin/cb/reset`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ featureId: 'test-cf-monitor-consumer:fetch:GET:api-test' }),
		});
		await fetch(`${resources.monitorWorkerUrl}/admin/cb/account`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'clear' }),
		});
	} catch {
		// Best effort
	}

	// Warm up tail_consumers pipeline — fire an error to activate the binding.
	try {
		console.log('[integration:setup] Warming up tail pipeline...');
		await fetch(`${resources.consumerWorkerUrl}/api/error`).catch(() => {});
		await fetch(`${resources.consumerWorkerUrl}/api/error-type-a`).catch(() => {});
		await fetch(`${resources.consumerWorkerUrl}/api/error-type-b`).catch(() => {});
		await fetch(`${resources.consumerWorkerUrl}/api/test`).catch(() => {});
	} catch {
		// Best effort
	}

	console.log('[integration:setup] Ready');
}

export async function teardown(): Promise<void> {
	if (!existsSync(ENV_FILE)) return;

	try {
		const data = JSON.parse(readFileSync(ENV_FILE, 'utf-8'));
		const env = { accountId: data.accountId, apiToken: data.apiToken };
		const resources: TestResources = {
			kvNamespaceId: data.kvNamespaceId,
			monitorWorkerUrl: data.monitorWorkerUrl,
			consumerWorkerUrl: data.consumerWorkerUrl,
			tmpDir: data.tmpDir,
		};

		await teardownTestResources(env, resources);
	} catch (err) {
		console.warn(`[integration:teardown] Error: ${err}`);
	}
}
