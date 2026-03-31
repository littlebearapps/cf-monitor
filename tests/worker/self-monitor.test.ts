import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KV, CRON_HANDLER_REGISTRY } from '../../src/constants.js';
import { createMockMonitorWorkerEnv, type MockMonitorWorkerEnv } from '../helpers/mock-env.js';

// Mock the alerts module (must be at top level for vi.mock hoisting)
vi.mock('../../src/worker/alerts/slack.js', () => ({
	sendSlackAlert: vi.fn().mockResolvedValue(true),
	formatBudgetWarning: vi.fn(),
	formatErrorAlert: vi.fn(),
}));

import { sendSlackAlert } from '../../src/worker/alerts/slack.js';

let env: MockMonitorWorkerEnv;

beforeEach(() => {
	env = createMockMonitorWorkerEnv({
		SLACK_WEBHOOK_URL: 'https://hooks.slack.com/test',
	});
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// =============================================================================
// recordCronExecution
// =============================================================================

describe('recordCronExecution', () => {
	it('writes handler timestamp to per-handler KV key', async () => {
		const { recordCronExecution } = await import('../../src/worker/self-monitor.js');

		await recordCronExecution(env, 'gap-detection', 123, true);

		const raw = await env.CF_MONITOR_KV.get(`${KV.SELF_CRON_HANDLER}gap-detection`, 'json') as Record<string, unknown>;
		expect(raw).not.toBeNull();
		expect(raw).toMatchObject({
			durationMs: 123,
			success: true,
		});
		expect(raw).toHaveProperty('lastRun');
	});

	it('writes separate keys for different handlers (no race condition)', async () => {
		const { recordCronExecution } = await import('../../src/worker/self-monitor.js');

		await recordCronExecution(env, 'gap-detection', 100, true);
		await recordCronExecution(env, 'budget-check', 200, false);

		const gd = await env.CF_MONITOR_KV.get(`${KV.SELF_CRON_HANDLER}gap-detection`, 'json') as Record<string, unknown>;
		const bc = await env.CF_MONITOR_KV.get(`${KV.SELF_CRON_HANDLER}budget-check`, 'json') as Record<string, unknown>;
		expect(gd).not.toBeNull();
		expect(bc).not.toBeNull();
		expect((bc as Record<string, unknown>).success).toBe(false);
	});

	it('overwrites previous entry for same handler', async () => {
		const { recordCronExecution } = await import('../../src/worker/self-monitor.js');

		await recordCronExecution(env, 'gap-detection', 100, true);
		await recordCronExecution(env, 'gap-detection', 500, false);

		const raw = await env.CF_MONITOR_KV.get(`${KV.SELF_CRON_HANDLER}gap-detection`, 'json') as Record<string, unknown>;
		expect(raw.durationMs).toBe(500);
		expect(raw.success).toBe(false);
	});

	it('sets 48hr TTL on KV key', async () => {
		const { recordCronExecution } = await import('../../src/worker/self-monitor.js');

		const putSpy = vi.spyOn(env.CF_MONITOR_KV, 'put');
		await recordCronExecution(env, 'gap-detection', 100, true);

		expect(putSpy).toHaveBeenCalledWith(
			`${KV.SELF_CRON_HANDLER}gap-detection`,
			expect.any(String),
			{ expirationTtl: 172800 },
		);
	});

	it('fails open on KV error', async () => {
		const { recordCronExecution } = await import('../../src/worker/self-monitor.js');

		vi.spyOn(env.CF_MONITOR_KV, 'put').mockRejectedValueOnce(new Error('KV unavailable'));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		// Should not throw
		await recordCronExecution(env, 'gap-detection', 100, true);

		expect(warnSpy).toHaveBeenCalled();
	});
});

// =============================================================================
// recordHandlerError
// =============================================================================

describe('recordHandlerError', () => {
	it('increments per-handler daily error counter', async () => {
		const { recordHandlerError } = await import('../../src/worker/self-monitor.js');

		const today = new Date().toISOString().slice(0, 10);
		await recordHandlerError(env, 'budget-check', new Error('test'));

		const count = await env.CF_MONITOR_KV.get(`${KV.SELF_ERROR_COUNT}budget-check:${today}`);
		expect(count).toBe('1');
	});

	it('increments total daily error counter', async () => {
		const { recordHandlerError } = await import('../../src/worker/self-monitor.js');

		const today = new Date().toISOString().slice(0, 10);
		await recordHandlerError(env, 'budget-check', new Error('test'));

		const count = await env.CF_MONITOR_KV.get(`${KV.SELF_ERRORS_TOTAL}${today}`);
		expect(count).toBe('1');
	});

	it('accumulates error counts across calls', async () => {
		const { recordHandlerError } = await import('../../src/worker/self-monitor.js');

		const today = new Date().toISOString().slice(0, 10);
		await recordHandlerError(env, 'budget-check', new Error('err1'));
		await recordHandlerError(env, 'budget-check', new Error('err2'));
		await recordHandlerError(env, 'budget-check', new Error('err3'));

		const count = await env.CF_MONITOR_KV.get(`${KV.SELF_ERROR_COUNT}budget-check:${today}`);
		expect(count).toBe('3');

		const total = await env.CF_MONITOR_KV.get(`${KV.SELF_ERRORS_TOTAL}${today}`);
		expect(total).toBe('3');
	});

	it('sets 48hr TTL on error counter keys', async () => {
		const { recordHandlerError } = await import('../../src/worker/self-monitor.js');

		const putSpy = vi.spyOn(env.CF_MONITOR_KV, 'put');
		await recordHandlerError(env, 'budget-check', new Error('test'));

		// Both put calls should have 48hr TTL
		for (const call of putSpy.mock.calls) {
			expect(call[2]).toEqual({ expirationTtl: 172800 });
		}
	});

	it('fails open on KV error', async () => {
		const { recordHandlerError } = await import('../../src/worker/self-monitor.js');

		vi.spyOn(env.CF_MONITOR_KV, 'put').mockRejectedValueOnce(new Error('KV down'));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		await recordHandlerError(env, 'budget-check', new Error('test'));

		expect(warnSpy).toHaveBeenCalled();
	});
});

// =============================================================================
// recordSelfTelemetry
// =============================================================================

describe('recordSelfTelemetry', () => {
	it('writes AE data point with correct blob format', async () => {
		const { recordSelfTelemetry } = await import('../../src/worker/self-monitor.js');

		recordSelfTelemetry(env, 'gap-detection', 456, true);

		expect(env.CF_MONITOR_AE._dataPoints).toHaveLength(1);
		const dp = env.CF_MONITOR_AE._dataPoints[0];
		expect(dp.blobs).toEqual(['cf-monitor', 'self:456:1', 'gap-detection']);
	});

	it('writes 0 for failure in blob', async () => {
		const { recordSelfTelemetry } = await import('../../src/worker/self-monitor.js');

		recordSelfTelemetry(env, 'budget-check', 100, false);

		const dp = env.CF_MONITOR_AE._dataPoints[0];
		expect(dp.blobs[1]).toBe('self:100:0');
	});

	it('writes doubles[0] = 1 and rest zeros, 20 total', async () => {
		const { recordSelfTelemetry } = await import('../../src/worker/self-monitor.js');

		recordSelfTelemetry(env, 'gap-detection', 100, true);

		const dp = env.CF_MONITOR_AE._dataPoints[0];
		expect(dp.doubles).toHaveLength(20);
		expect(dp.doubles[0]).toBe(1);
		for (let i = 1; i < 20; i++) {
			expect(dp.doubles[i]).toBe(0);
		}
	});

	it('writes correct index', async () => {
		const { recordSelfTelemetry } = await import('../../src/worker/self-monitor.js');

		recordSelfTelemetry(env, 'daily-rollup', 300, true);

		const dp = env.CF_MONITOR_AE._dataPoints[0];
		expect(dp.indexes).toEqual(['cf-monitor:self:daily-rollup']);
	});

	it('fails open on AE error', async () => {
		const { recordSelfTelemetry } = await import('../../src/worker/self-monitor.js');

		vi.spyOn(env.CF_MONITOR_AE, 'writeDataPoint').mockImplementation(() => {
			throw new Error('AE down');
		});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		// Should not throw
		recordSelfTelemetry(env, 'gap-detection', 100, true);

		expect(warnSpy).toHaveBeenCalled();
	});
});

// =============================================================================
// getSelfHealth
// =============================================================================

describe('getSelfHealth', () => {
	it('returns healthy status when no crons are stale', async () => {
		const { getSelfHealth, recordCronExecution } = await import('../../src/worker/self-monitor.js');

		// Record recent runs for all handlers
		for (const handler of Object.keys(CRON_HANDLER_REGISTRY)) {
			await recordCronExecution(env, handler, 100, true);
		}

		const health = await getSelfHealth(env);
		expect(health.healthy).toBe(true);
		expect(health.staleCrons).toHaveLength(0);
	});

	it('reports first boot as healthy (no KV state)', async () => {
		const { getSelfHealth } = await import('../../src/worker/self-monitor.js');

		const health = await getSelfHealth(env);
		expect(health.healthy).toBe(true);
		expect(health.staleCrons).toHaveLength(0);
		// All handlers should have null lastRun
		for (const handler of Object.keys(CRON_HANDLER_REGISTRY)) {
			const cronEntry = health.crons[handler];
			expect(cronEntry.lastRun).toBeNull();
		}
	});

	it('detects stale cron handlers', async () => {
		const { getSelfHealth } = await import('../../src/worker/self-monitor.js');

		// Manually write a stale per-handler key
		const staleTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 60 mins ago (maxStale = 45)
		await env.CF_MONITOR_KV.put(
			`${KV.SELF_CRON_HANDLER}gap-detection`,
			JSON.stringify({ lastRun: staleTime, durationMs: 100, success: true }),
			{ expirationTtl: 172800 },
		);

		const health = await getSelfHealth(env);
		expect(health.staleCrons).toContain('gap-detection');
	});

	it('reports todayErrors from KV', async () => {
		const { getSelfHealth, recordHandlerError } = await import('../../src/worker/self-monitor.js');

		await recordHandlerError(env, 'budget-check', new Error('err'));
		await recordHandlerError(env, 'gap-detection', new Error('err'));

		const health = await getSelfHealth(env);
		expect(health.todayErrors).toBe(2);
	});

	it('is unhealthy when todayErrors >= 50', async () => {
		const { getSelfHealth } = await import('../../src/worker/self-monitor.js');

		// Seed 50 errors directly in KV
		const today = new Date().toISOString().slice(0, 10);
		await env.CF_MONITOR_KV.put(`${KV.SELF_ERRORS_TOTAL}${today}`, '50', { expirationTtl: 172800 });

		const health = await getSelfHealth(env);
		expect(health.healthy).toBe(false);
		expect(health.todayErrors).toBe(50);
	});

	it('is unhealthy when any cron is stale', async () => {
		const { getSelfHealth, recordCronExecution } = await import('../../src/worker/self-monitor.js');

		// Record all handlers as recent
		for (const handler of Object.keys(CRON_HANDLER_REGISTRY)) {
			await recordCronExecution(env, handler, 100, true);
		}

		// Make one stale via per-handler key
		const staleTime = new Date(Date.now() - 200 * 60 * 1000).toISOString(); // 200 mins (hourly maxStale = 150)
		await env.CF_MONITOR_KV.put(
			`${KV.SELF_CRON_HANDLER}collect-metrics`,
			JSON.stringify({ lastRun: staleTime, durationMs: 100, success: true }),
			{ expirationTtl: 172800 },
		);

		const health = await getSelfHealth(env);
		expect(health.healthy).toBe(false);
		expect(health.staleCrons).toContain('collect-metrics');
	});

	it('includes per-handler error counts', async () => {
		const { getSelfHealth, recordHandlerError } = await import('../../src/worker/self-monitor.js');

		await recordHandlerError(env, 'budget-check', new Error('err1'));
		await recordHandlerError(env, 'budget-check', new Error('err2'));

		const health = await getSelfHealth(env);
		expect(health.handlerErrors['budget-check']).toBe(2);
	});
});

// =============================================================================
// checkCronStaleness
// =============================================================================

describe('checkCronStaleness', () => {
	it('sends no alert when no crons are stale', async () => {
		const { checkCronStaleness, recordCronExecution } = await import('../../src/worker/self-monitor.js');

		for (const handler of Object.keys(CRON_HANDLER_REGISTRY)) {
			await recordCronExecution(env, handler, 100, true);
		}

		await checkCronStaleness(env);

		expect(sendSlackAlert).not.toHaveBeenCalled();
	});

	it('sends alert when crons are stale', async () => {
		const { checkCronStaleness } = await import('../../src/worker/self-monitor.js');

		// Write a stale per-handler key
		const staleTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		await env.CF_MONITOR_KV.put(
			`${KV.SELF_CRON_HANDLER}gap-detection`,
			JSON.stringify({ lastRun: staleTime, durationMs: 100, success: true }),
			{ expirationTtl: 172800 },
		);

		await checkCronStaleness(env);

		expect(sendSlackAlert).toHaveBeenCalledOnce();
		const call = (sendSlackAlert as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[0]).toBe(env);
		// Dedup key includes today's date
		const today = new Date().toISOString().slice(0, 10);
		expect(call[1]).toBe(`self:stale:${today}`);
		// Dedup TTL = 86400 (1 day)
		expect(call[2]).toBe(86400);
	});

	it('skips handlers with no record (first boot)', async () => {
		const { checkCronStaleness } = await import('../../src/worker/self-monitor.js');

		// Empty KV — first boot scenario
		await checkCronStaleness(env);

		expect(sendSlackAlert).not.toHaveBeenCalled();
	});

	it('fails open on error', async () => {
		const { checkCronStaleness } = await import('../../src/worker/self-monitor.js');

		vi.spyOn(env.CF_MONITOR_KV, 'get').mockRejectedValueOnce(new Error('KV down'));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		await checkCronStaleness(env);

		expect(warnSpy).toHaveBeenCalled();
	});

	it('includes stale handler names in alert message', async () => {
		const { checkCronStaleness } = await import('../../src/worker/self-monitor.js');

		// Make two handlers stale via per-handler keys
		const staleTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		await env.CF_MONITOR_KV.put(
			`${KV.SELF_CRON_HANDLER}gap-detection`,
			JSON.stringify({ lastRun: staleTime, durationMs: 100, success: true }),
			{ expirationTtl: 172800 },
		);
		await env.CF_MONITOR_KV.put(
			`${KV.SELF_CRON_HANDLER}cost-spike`,
			JSON.stringify({ lastRun: staleTime, durationMs: 100, success: true }),
			{ expirationTtl: 172800 },
		);

		await checkCronStaleness(env);

		expect(sendSlackAlert).toHaveBeenCalledOnce();
		const message = (sendSlackAlert as ReturnType<typeof vi.fn>).mock.calls[0][3];
		expect(message.text).toContain('gap-detection');
		expect(message.text).toContain('cost-spike');
	});
});
