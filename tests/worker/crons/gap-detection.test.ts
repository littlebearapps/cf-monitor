import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectGaps } from '../../../src/worker/crons/gap-detection.js';
import { KV } from '../../../src/constants.js';
import { createMockMonitorWorkerEnv, type MockMonitorWorkerEnv } from '../../helpers/mock-env.js';

// Mock slack alerts
vi.mock('../../../src/worker/alerts/slack.js', () => ({
	sendSlackAlert: vi.fn().mockResolvedValue(true),
}));

import { sendSlackAlert } from '../../../src/worker/alerts/slack.js';

// Mock AE client
vi.mock('../../../src/worker/ae-client.js', () => ({
	getActiveWorkers: vi.fn(),
}));

import { getActiveWorkers } from '../../../src/worker/ae-client.js';

let env: MockMonitorWorkerEnv;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	env = createMockMonitorWorkerEnv({
		SLACK_WEBHOOK_URL: 'https://hooks.slack.com/test',
		CLOUDFLARE_API_TOKEN: 'test-token',
	});
	mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
	vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function setWorkerList(workers: string[]): Promise<void> {
	await env.CF_MONITOR_KV.put(KV.WORKER_LIST, JSON.stringify(workers));
}

describe('detectGaps — AE-based (#11)', () => {
	it('does nothing when no workers discovered', async () => {
		await detectGaps(env);
		expect(sendSlackAlert).not.toHaveBeenCalled();
	});

	it('does nothing when all workers are active in AE', async () => {
		await setWorkerList(['worker-a', 'worker-b']);

		const activeMap = new Map([['worker-a', 100], ['worker-b', 50]]);
		vi.mocked(getActiveWorkers).mockResolvedValue(activeMap);

		await detectGaps(env);
		expect(sendSlackAlert).not.toHaveBeenCalled();
	});

	it('detects gaps when worker has no AE telemetry', async () => {
		await setWorkerList(['worker-a', 'worker-b']);

		// Only worker-a is active
		const activeMap = new Map([['worker-a', 100]]);
		vi.mocked(getActiveWorkers).mockResolvedValue(activeMap);

		await detectGaps(env);
		expect(sendSlackAlert).toHaveBeenCalledOnce();
	});

	it('skips cf-monitor itself', async () => {
		await setWorkerList(['cf-monitor', 'worker-a']);

		const activeMap = new Map([['worker-a', 100]]);
		vi.mocked(getActiveWorkers).mockResolvedValue(activeMap);

		await detectGaps(env);
		// cf-monitor should be skipped, worker-a is active — no gap
		expect(sendSlackAlert).not.toHaveBeenCalled();
	});

	it('falls back to KV when AE query fails', async () => {
		await setWorkerList(['worker-a']);
		// Set last_seen within the hour
		await env.CF_MONITOR_KV.put(
			`${KV.WORKER_REGISTRY}worker-a:last_seen`,
			new Date().toISOString()
		);

		vi.mocked(getActiveWorkers).mockRejectedValue(new Error('AE unavailable'));

		await detectGaps(env);
		// KV fallback finds worker-a is recent — no gap
		expect(sendSlackAlert).not.toHaveBeenCalled();
	});
});

describe('detectGaps — KV fallback', () => {
	it('uses KV when no API token configured', async () => {
		// Remove API token
		delete (env as Record<string, unknown>).CLOUDFLARE_API_TOKEN;

		await setWorkerList(['worker-a']);
		// No last_seen — should be a gap
		await detectGaps(env);

		expect(getActiveWorkers).not.toHaveBeenCalled();
		expect(sendSlackAlert).toHaveBeenCalledOnce();
	});

	it('detects gap when KV last_seen is stale (>1hr)', async () => {
		delete (env as Record<string, unknown>).CLOUDFLARE_API_TOKEN;

		await setWorkerList(['worker-a']);
		// Set last_seen 2 hours ago
		const twoHoursAgo = new Date(Date.now() - 7_200_000).toISOString();
		await env.CF_MONITOR_KV.put(
			`${KV.WORKER_REGISTRY}worker-a:last_seen`,
			twoHoursAgo
		);

		await detectGaps(env);
		expect(sendSlackAlert).toHaveBeenCalledOnce();
	});

	it('no gap when KV last_seen is fresh', async () => {
		delete (env as Record<string, unknown>).CLOUDFLARE_API_TOKEN;

		await setWorkerList(['worker-a']);
		await env.CF_MONITOR_KV.put(
			`${KV.WORKER_REGISTRY}worker-a:last_seen`,
			new Date().toISOString()
		);

		await detectGaps(env);
		expect(sendSlackAlert).not.toHaveBeenCalled();
	});
});
