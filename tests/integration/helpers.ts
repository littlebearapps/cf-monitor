/**
 * Integration test helpers — deploy/teardown real CF resources.
 * All resources use 'test-' prefix to avoid collision with production.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import {
	createKVNamespace,
	deleteKVNamespace,
	writeKVValue,
	deleteKVKey,
	readKVValue,
	listKVKeys,
} from '../../src/cli/cloudflare-api.js';
import { generateWranglerConfig } from '../../src/cli/wrangler-generator.js';

// =============================================================================
// ENV
// =============================================================================

export interface TestEnv {
	accountId: string;
	apiToken: string;
}

/** Read CF credentials from env. Throws if missing. */
export function getTestEnv(): TestEnv {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = process.env.CLOUDFLARE_API_TOKEN;
	if (!accountId || !apiToken) {
		throw new Error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
	}
	return { accountId, apiToken };
}

/** Check if integration test credentials are available. */
export function hasCredentials(): boolean {
	return !!process.env.CLOUDFLARE_ACCOUNT_ID && !!process.env.CLOUDFLARE_API_TOKEN;
}

// =============================================================================
// RESOURCE MANAGEMENT
// =============================================================================

export interface TestResources {
	kvNamespaceId: string;
	monitorWorkerUrl: string;
	consumerWorkerUrl: string;
	tmpDir: string;
}

export const TEST_MONITOR_NAME = 'test-cf-monitor';
export const TEST_CONSUMER_NAME = 'test-cf-monitor-consumer';
const TEST_KV_TITLE = 'test-cf-monitor';
const TEST_AE_DATASET = 'test-cf-monitor';
export const TEST_WEBHOOK_SECRET = 'test-webhook-secret-12345';

const ENV_FILE = '/tmp/cf-monitor-integration-env.json';

/** Load test resources from global setup JSON file. */
export function loadTestResources(): { env: TestEnv; resources: TestResources } {
	if (!existsSync(ENV_FILE)) {
		throw new Error('Integration test env file not found — global setup may have failed');
	}
	const data = JSON.parse(readFileSync(ENV_FILE, 'utf-8'));
	return {
		env: { accountId: data.accountId, apiToken: data.apiToken },
		resources: {
			kvNamespaceId: data.kvNamespaceId,
			monitorWorkerUrl: data.monitorWorkerUrl,
			consumerWorkerUrl: data.consumerWorkerUrl,
			tmpDir: data.tmpDir,
		},
	};
}

/** Deploy all test resources. Returns URLs and IDs for test assertions. */
export async function setupTestResources(env: TestEnv): Promise<TestResources> {
	const tmpDir = join(tmpdir(), `cf-monitor-integration-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });

	// 1. Create KV namespace
	console.log('[integration] Creating test KV namespace...');
	const kvNamespaceId = await createKVNamespace(env.accountId, env.apiToken, TEST_KV_TITLE);
	console.log(`[integration] KV namespace: ${kvNamespaceId}`);

	// 2. Generate and deploy monitor worker
	console.log('[integration] Deploying test-cf-monitor worker...');
	const monitorDir = join(tmpDir, 'monitor');
	mkdirSync(monitorDir, { recursive: true });

	const repoRoot = join(__dirname, '..', '..');
	const monitorConfigStr = generateWranglerConfig(env.accountId, kvNamespaceId, false, {
		name: TEST_MONITOR_NAME,
		dataset: TEST_AE_DATASET,
		accountName: 'test-account',
		main: join(repoRoot, 'worker', 'index.ts'),
		noCrons: true,
	});

	// Inject additional vars for cron and webhook tests
	const monitorConfig = JSON.parse(monitorConfigStr.replace(/^\/\/.*\n/, ''));
	monitorConfig.vars.CLOUDFLARE_API_TOKEN = env.apiToken;
	monitorConfig.vars.GITHUB_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
	// Intentionally NO GITHUB_REPO, GITHUB_TOKEN, SLACK_WEBHOOK_URL
	writeFileSync(join(monitorDir, 'wrangler.jsonc'), JSON.stringify(monitorConfig, null, 2));

	deployWorker(join(monitorDir, 'wrangler.jsonc'));
	console.log('[integration] test-cf-monitor deployed');

	// 3. Generate and deploy consumer worker
	console.log('[integration] Deploying test-cf-monitor-consumer worker...');
	const consumerDir = join(tmpDir, 'consumer');
	mkdirSync(consumerDir, { recursive: true });

	const consumerSrc = join(__dirname, 'test-consumer.ts');
	const consumerConfig = generateConsumerConfig(env.accountId, kvNamespaceId, consumerSrc);
	writeFileSync(join(consumerDir, 'wrangler.jsonc'), consumerConfig);

	deployWorker(join(consumerDir, 'wrangler.jsonc'));
	console.log('[integration] test-cf-monitor-consumer deployed');

	// 4. Wait for propagation
	console.log('[integration] Waiting 5s for propagation...');
	await sleep(5000);

	const subdomain = process.env.WORKERS_DEV_SUBDOMAIN ?? await detectWorkersDevSubdomain(env);

	return {
		kvNamespaceId,
		monitorWorkerUrl: `https://${TEST_MONITOR_NAME}.${subdomain}.workers.dev`,
		consumerWorkerUrl: `https://${TEST_CONSUMER_NAME}.${subdomain}.workers.dev`,
		tmpDir,
	};
}

/** Tear down all test resources. Best-effort — logs errors but doesn't throw. */
export async function teardownTestResources(env: TestEnv, resources: TestResources): Promise<void> {
	console.log('[integration] Tearing down test resources...');

	try {
		deleteWorkerByName(TEST_MONITOR_NAME, env.accountId);
		console.log('[integration] Deleted test-cf-monitor worker');
	} catch (err) {
		console.warn(`[integration] Failed to delete monitor worker: ${err}`);
	}

	try {
		deleteWorkerByName(TEST_CONSUMER_NAME, env.accountId);
		console.log('[integration] Deleted test-cf-monitor-consumer worker');
	} catch (err) {
		console.warn(`[integration] Failed to delete consumer worker: ${err}`);
	}

	try {
		await deleteKVNamespace(env.accountId, env.apiToken, resources.kvNamespaceId);
		console.log('[integration] Deleted test KV namespace');
	} catch (err) {
		console.warn(`[integration] Failed to delete KV namespace: ${err}`);
	}

	try {
		rmSync(resources.tmpDir, { recursive: true, force: true });
	} catch {
		// Ignore
	}
}

// =============================================================================
// KV OPERATIONS (via CF REST API)
// =============================================================================

export async function writeTestKVKey(
	env: TestEnv,
	namespaceId: string,
	key: string,
	value: string
): Promise<void> {
	await writeKVValue(env.accountId, env.apiToken, namespaceId, key, value);
}

export async function readTestKVKey(
	env: TestEnv,
	namespaceId: string,
	key: string
): Promise<string | null> {
	return readKVValue(env.accountId, env.apiToken, namespaceId, key);
}

export async function listTestKVKeys(
	env: TestEnv,
	namespaceId: string,
	prefix: string
): Promise<Array<{ name: string }>> {
	return listKVKeys(env.accountId, env.apiToken, namespaceId, { prefix });
}

export async function deleteTestKVKey(
	env: TestEnv,
	namespaceId: string,
	key: string
): Promise<void> {
	await deleteKVKey(env.accountId, env.apiToken, namespaceId, key);
}

// =============================================================================
// KV PROPAGATION POLLING
// =============================================================================

/**
 * Poll the consumer worker until it returns the expected status code.
 * More efficient than fixed sleep — returns as soon as propagation completes.
 */
export async function waitForConsumerStatus(
	consumerUrl: string,
	path: string,
	expectedStatus: number,
	maxWaitMs: number = 40_000,
	pollIntervalMs: number = 3000
): Promise<Response> {
	const start = Date.now();
	let lastResponse: Response | undefined;

	while (Date.now() - start < maxWaitMs) {
		try {
			lastResponse = await fetch(`${consumerUrl}${path}`);
			if (lastResponse.status === expectedStatus) return lastResponse;
		} catch {
			// Network error — retry
		}
		await sleep(pollIntervalMs);
	}

	if (lastResponse) return lastResponse;
	throw new Error(`Timed out waiting for ${expectedStatus} at ${consumerUrl}${path}`);
}

// =============================================================================
// WORKERS.DEV SUBDOMAIN DETECTION
// =============================================================================

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

async function detectWorkersDevSubdomain(env: TestEnv): Promise<string> {
	const response = await fetch(
		`${CF_API_BASE}/accounts/${env.accountId}/workers/subdomain`,
		{ headers: { Authorization: `Bearer ${env.apiToken}` } }
	);

	if (response.ok) {
		const data = await response.json() as { result: { subdomain: string } };
		return data.result.subdomain;
	}

	throw new Error(`Failed to detect workers.dev subdomain: ${response.status}. Set WORKERS_DEV_SUBDOMAIN env var.`);
}

// =============================================================================
// WRANGLER OPERATIONS
// =============================================================================

function deployWorker(configPath: string): void {
	execSync(`npx wrangler deploy -c "${configPath}"`, {
		encoding: 'utf-8',
		stdio: ['inherit', 'pipe', 'pipe'],
		timeout: 60_000,
	});
}

function deleteWorkerByName(name: string, accountId: string): void {
	execSync(`npx wrangler delete --name "${name}" --force`, {
		encoding: 'utf-8',
		stdio: ['inherit', 'pipe', 'pipe'],
		timeout: 30_000,
		env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
	});
}

// =============================================================================
// CONSUMER CONFIG
// =============================================================================

function generateConsumerConfig(accountId: string, kvNamespaceId: string, mainPath: string): string {
	const config = {
		$schema: 'node_modules/wrangler/config-schema.json',
		name: TEST_CONSUMER_NAME,
		main: mainPath,
		compatibility_date: '2026-03-01',
		compatibility_flags: ['nodejs_compat_v2'],
		account_id: accountId,
		kv_namespaces: [
			{ binding: 'CF_MONITOR_KV', id: kvNamespaceId },
			{ binding: 'TEST_KV', id: kvNamespaceId }, // Second binding for proxy tracking tests
		],
		analytics_engine_datasets: [
			{ binding: 'CF_MONITOR_AE', dataset: TEST_AE_DATASET },
		],
		tail_consumers: [
			{ service: TEST_MONITOR_NAME },
		],
		vars: {
			WORKER_NAME: TEST_CONSUMER_NAME,
		},
	};

	return JSON.stringify(config, null, 2);
}

// =============================================================================
// HTTP HELPERS
// =============================================================================

/** Fetch a worker URL with retries (handles propagation delays). */
export async function fetchWorker(
	baseUrl: string,
	path: string,
	options?: { retries?: number; delayMs?: number; expectStatus?: number }
): Promise<Response> {
	const retries = options?.retries ?? 3;
	const delayMs = options?.delayMs ?? 2000;
	const expectStatus = options?.expectStatus;

	let lastResponse: Response | undefined;
	let lastError: Error | undefined;

	for (let i = 0; i <= retries; i++) {
		try {
			lastResponse = await fetch(`${baseUrl}${path}`);
			if (expectStatus === undefined || lastResponse.status === expectStatus) {
				return lastResponse;
			}
		} catch (err) {
			lastError = err as Error;
		}
		if (i < retries) await sleep(delayMs);
	}

	if (lastResponse) return lastResponse;
	throw lastError ?? new Error(`Failed to fetch ${baseUrl}${path} after ${retries} retries`);
}

/** POST to a worker URL with JSON body. */
export async function fetchWorkerPost(
	baseUrl: string,
	path: string,
	body: unknown,
	headers?: Record<string, string>
): Promise<Response> {
	return fetch(`${baseUrl}${path}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...headers,
		},
		body: JSON.stringify(body),
	});
}

// =============================================================================
// GITHUB WEBHOOK HELPERS
// =============================================================================

/** Sign a webhook payload with HMAC-SHA256 (matching GitHub format). */
export function signWebhookPayload(body: string, secret: string): string {
	const signature = createHmac('sha256', secret).update(body).digest('hex');
	return `sha256=${signature}`;
}

// =============================================================================
// ANALYTICS ENGINE SQL (via CF REST API)
// =============================================================================

/** Query the Analytics Engine SQL API. */
export async function queryTestAE(
	env: TestEnv,
	sql: string
): Promise<{ data: Record<string, unknown>[]; rows: number }> {
	const response = await fetch(
		`${CF_API_BASE}/accounts/${env.accountId}/analytics_engine/sql`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.apiToken}`,
				'Content-Type': 'text/plain',
			},
			body: sql,
		}
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`AE SQL query failed (${response.status}): ${text.slice(0, 200)}`);
	}
	return response.json() as Promise<{ data: Record<string, unknown>[]; rows: number }>;
}

/**
 * Poll AE SQL API until minRows data rows appear or timeout.
 * AE writes have ~30-90s propagation delay.
 */
export async function waitForAEData(
	env: TestEnv,
	sql: string,
	minRows: number = 1,
	maxWaitMs: number = 60_000,
	pollIntervalMs: number = 5000
): Promise<Record<string, unknown>[]> {
	const start = Date.now();
	while (Date.now() - start < maxWaitMs) {
		try {
			const result = await queryTestAE(env, sql);
			if (result.data && result.data.length >= minRows) return result.data;
		} catch {
			// AE may not be ready yet — retry
		}
		await sleep(pollIntervalMs);
	}
	return [];
}

// =============================================================================
// UTILS
// =============================================================================

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
