import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleScheduled } from '../../src/worker/scheduled-handler.js';
import { createMockMonitorWorkerEnv } from '../helpers/mock-env.js';
import { createMockCtx, createMockScheduledController } from '../helpers/mock-request.js';

// Mock all cron modules
vi.mock('../../src/worker/crons/gap-detection.js', () => ({
	detectGaps: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/worker/crons/cost-spike.js', () => ({
	detectCostSpikes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/worker/crons/collect-metrics.js', () => ({
	collectAccountMetrics: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/worker/crons/budget-check.js', () => ({
	checkBudgets: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/worker/crons/synthetic-health.js', () => ({
	runSyntheticHealthCheck: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/worker/crons/daily-rollup.js', () => ({
	runDailyRollup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/worker/crons/worker-discovery.js', () => ({
	discoverWorkers: vi.fn().mockResolvedValue(undefined),
}));

import { detectGaps } from '../../src/worker/crons/gap-detection.js';
import { detectCostSpikes } from '../../src/worker/crons/cost-spike.js';
import { collectAccountMetrics } from '../../src/worker/crons/collect-metrics.js';
import { checkBudgets } from '../../src/worker/crons/budget-check.js';
import { runSyntheticHealthCheck } from '../../src/worker/crons/synthetic-health.js';
import { runDailyRollup } from '../../src/worker/crons/daily-rollup.js';
import { discoverWorkers } from '../../src/worker/crons/worker-discovery.js';

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
	vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('handleScheduled', () => {
	it('dispatches */15 cron to gap detection', async () => {
		const env = createMockMonitorWorkerEnv();
		const ctx = createMockCtx();

		await handleScheduled(createMockScheduledController('*/15 * * * *'), env, ctx);

		expect(detectGaps).toHaveBeenCalledWith(env);
		expect(collectAccountMetrics).not.toHaveBeenCalled();
	});

	it('dispatches hourly cron to metrics + budgets + synthetic health', async () => {
		const env = createMockMonitorWorkerEnv();
		const ctx = createMockCtx();

		await handleScheduled(createMockScheduledController('0 * * * *'), env, ctx);

		expect(collectAccountMetrics).toHaveBeenCalledWith(env);
		expect(checkBudgets).toHaveBeenCalledWith(env);
		expect(runSyntheticHealthCheck).toHaveBeenCalledWith(env);
	});

	it('dispatches midnight cron to daily rollup + worker discovery', async () => {
		const env = createMockMonitorWorkerEnv();
		const ctx = createMockCtx();

		await handleScheduled(createMockScheduledController('0 0 * * *'), env, ctx);

		expect(runDailyRollup).toHaveBeenCalledWith(env);
		expect(discoverWorkers).toHaveBeenCalledWith(env);
	});

	it('does not throw on unknown cron', async () => {
		const env = createMockMonitorWorkerEnv();
		const ctx = createMockCtx();

		// Should log warning but not throw
		await handleScheduled(createMockScheduledController('0 6 * * MON'), env, ctx);

		expect(detectGaps).not.toHaveBeenCalled();
		expect(collectAccountMetrics).not.toHaveBeenCalled();
		expect(runDailyRollup).not.toHaveBeenCalled();
	});

	it('pings Gatus heartbeat on unknown cron with success=false', async () => {
		const env = createMockMonitorWorkerEnv({
			GATUS_HEARTBEAT_URL: 'https://gatus.example.com/heartbeat',
			GATUS_TOKEN: 'token123',
		});
		const ctx = createMockCtx();

		await handleScheduled(createMockScheduledController('0 6 * * MON'), env, ctx);
		await ctx._flush();

		expect(mockFetch).toHaveBeenCalledWith(
			'https://gatus.example.com/heartbeat?success=false',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('pings Gatus heartbeat after successful hourly cron', async () => {
		const env = createMockMonitorWorkerEnv({
			GATUS_HEARTBEAT_URL: 'https://gatus.example.com/heartbeat',
			GATUS_TOKEN: 'token123',
		});
		const ctx = createMockCtx();

		await handleScheduled(createMockScheduledController('0 * * * *'), env, ctx);
		await ctx._flush();

		expect(collectAccountMetrics).toHaveBeenCalled();
		expect(mockFetch).toHaveBeenCalledWith(
			'https://gatus.example.com/heartbeat?success=true',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('pings Gatus heartbeat after successful 15-min cron', async () => {
		const env = createMockMonitorWorkerEnv({
			GATUS_HEARTBEAT_URL: 'https://gatus.example.com/heartbeat',
			GATUS_TOKEN: 'token123',
		});
		const ctx = createMockCtx();

		await handleScheduled(createMockScheduledController('*/15 * * * *'), env, ctx);
		await ctx._flush();

		expect(detectGaps).toHaveBeenCalled();
		expect(mockFetch).toHaveBeenCalledWith(
			'https://gatus.example.com/heartbeat?success=true',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('sends success=false heartbeat when cron handler rejects', async () => {
		vi.mocked(collectAccountMetrics).mockRejectedValueOnce(new Error('fail'));
		vi.mocked(checkBudgets).mockRejectedValueOnce(new Error('fail'));
		vi.mocked(runSyntheticHealthCheck).mockRejectedValueOnce(new Error('fail'));

		const env = createMockMonitorWorkerEnv({
			GATUS_HEARTBEAT_URL: 'https://gatus.example.com/heartbeat',
			GATUS_TOKEN: 'token123',
		});
		const ctx = createMockCtx();

		await handleScheduled(createMockScheduledController('0 * * * *'), env, ctx);
		await ctx._flush();

		expect(mockFetch).toHaveBeenCalledWith(
			'https://gatus.example.com/heartbeat?success=false',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('does not throw when cron handler fails', async () => {
		vi.mocked(detectGaps).mockRejectedValueOnce(new Error('gap detection failed'));

		const env = createMockMonitorWorkerEnv();
		const ctx = createMockCtx();

		// Should not throw
		await handleScheduled(createMockScheduledController('*/15 * * * *'), env, ctx);
	});
});
