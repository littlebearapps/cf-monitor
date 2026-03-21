import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkBudgets } from '../../../src/worker/crons/budget-check.js';
import { KV } from '../../../src/constants.js';
import { createMockMonitorWorkerEnv, type MockMonitorWorkerEnv } from '../../helpers/mock-env.js';

// Mock slack alerts
vi.mock('../../../src/worker/alerts/slack.js', () => ({
	sendSlackAlert: vi.fn().mockResolvedValue(true),
	formatBudgetWarning: vi.fn().mockReturnValue({ text: 'test warning' }),
}));

import { sendSlackAlert } from '../../../src/worker/alerts/slack.js';

// Mock tripFeatureCb
vi.mock('../../../src/sdk/circuit-breaker.js', () => ({
	tripFeatureCb: vi.fn().mockResolvedValue(undefined),
	checkFeatureCb: vi.fn().mockResolvedValue('GO'),
	checkAccountCb: vi.fn().mockResolvedValue(null),
	resetFeatureCb: vi.fn().mockResolvedValue(undefined),
	setAccountCbStatus: vi.fn().mockResolvedValue(undefined),
}));

import { tripFeatureCb } from '../../../src/sdk/circuit-breaker.js';

let env: MockMonitorWorkerEnv;
const today = new Date().toISOString().slice(0, 10);

beforeEach(() => {
	vi.clearAllMocks();
	env = createMockMonitorWorkerEnv({ SLACK_WEBHOOK_URL: 'https://hooks.slack.com/test' });
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function setFeatureBudget(featureId: string, config: Record<string, number>): Promise<void> {
	await env.CF_MONITOR_KV.put(`${KV.BUDGET_CONFIG}${featureId}`, JSON.stringify(config));
}

async function setFeatureUsage(featureId: string, usage: Record<string, number>): Promise<void> {
	await env.CF_MONITOR_KV.put(`${KV.BUDGET_DAILY}${featureId}:${today}`, JSON.stringify(usage));
}

describe('checkBudgets', () => {
	it('does nothing when no budget configs exist', async () => {
		await checkBudgets(env);
		expect(tripFeatureCb).not.toHaveBeenCalled();
		expect(sendSlackAlert).not.toHaveBeenCalled();
	});

	it('does nothing when usage is zero (no usage data)', async () => {
		await setFeatureBudget('my-feature', { d1_writes: 1000 });
		await checkBudgets(env);

		expect(tripFeatureCb).not.toHaveBeenCalled();
		expect(sendSlackAlert).not.toHaveBeenCalled();
	});

	it('does nothing at 60% usage', async () => {
		await setFeatureBudget('my-feature', { d1_writes: 1000 });
		await setFeatureUsage('my-feature', { d1_writes: 600 });

		await checkBudgets(env);

		expect(tripFeatureCb).not.toHaveBeenCalled();
		expect(sendSlackAlert).not.toHaveBeenCalled();
	});

	it('sends Slack warning at 70% usage', async () => {
		await setFeatureBudget('my-feature', { d1_writes: 1000 });
		await setFeatureUsage('my-feature', { d1_writes: 750 });

		await checkBudgets(env);

		expect(tripFeatureCb).not.toHaveBeenCalled();
		expect(sendSlackAlert).toHaveBeenCalledOnce();
	});

	it('sends Slack critical at 90% usage', async () => {
		await setFeatureBudget('my-feature', { d1_writes: 1000 });
		await setFeatureUsage('my-feature', { d1_writes: 920 });

		await checkBudgets(env);

		expect(tripFeatureCb).not.toHaveBeenCalled();
		expect(sendSlackAlert).toHaveBeenCalledOnce();
	});

	it('trips circuit breaker at 100% usage', async () => {
		await setFeatureBudget('my-feature', { d1_writes: 1000 });
		await setFeatureUsage('my-feature', { d1_writes: 1050 });

		await checkBudgets(env);

		expect(tripFeatureCb).toHaveBeenCalledWith(
			env.CF_MONITOR_KV,
			'my-feature',
			expect.stringContaining('budget exceeded')
		);
		expect(sendSlackAlert).toHaveBeenCalled();
	});

	it('handles multiple features independently', async () => {
		await setFeatureBudget('feature-a', { d1_writes: 1000 });
		await setFeatureBudget('feature-b', { kv_reads: 500 });
		await setFeatureUsage('feature-a', { d1_writes: 400 }); // 40% — no alert
		await setFeatureUsage('feature-b', { kv_reads: 460 });  // 92% — critical

		await checkBudgets(env);

		expect(tripFeatureCb).not.toHaveBeenCalled();
		expect(sendSlackAlert).toHaveBeenCalledOnce(); // Only feature-b
	});
});
