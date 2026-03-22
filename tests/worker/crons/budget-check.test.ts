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

const month = new Date().toISOString().slice(0, 7);

async function setMonthlyBudget(featureId: string, config: Record<string, number>): Promise<void> {
	await env.CF_MONITOR_KV.put(`budget:config:monthly:${featureId}`, JSON.stringify(config));
}

async function setMonthlyUsage(featureId: string, usage: Record<string, number>): Promise<void> {
	await env.CF_MONITOR_KV.put(`${KV.BUDGET_MONTHLY}${featureId}:${month}`, JSON.stringify(usage));
}

describe('checkBudgets — daily', () => {
	it('auto-seeds __account__ fallback when no budget configs exist', async () => {
		await checkBudgets(env);

		// Should have auto-seeded __account__ config with paid plan defaults
		const config = await env.CF_MONITOR_KV.get('budget:config:__account__');
		expect(config).not.toBeNull();
		const parsed = JSON.parse(config!);
		expect(parsed.d1_writes).toBe(1_333_333);
		expect(parsed.kv_writes).toBe(26_667);

		// No CB trips (no usage data)
		expect(tripFeatureCb).not.toHaveBeenCalled();
		expect(sendSlackAlert).not.toHaveBeenCalled();
	});

	it('auto-seeds per-feature configs from discovered usage keys', async () => {
		// Set usage data without any budget config
		await env.CF_MONITOR_KV.put(
			`${KV.BUDGET_DAILY}my-api:fetch:GET:data:${today}`,
			JSON.stringify({ d1_writes: 5000 })
		);

		await checkBudgets(env);

		// Should have seeded a config for the discovered feature
		const config = await env.CF_MONITOR_KV.get(`${KV.BUDGET_CONFIG}my-api:fetch:GET:data`);
		expect(config).not.toBeNull();
		const parsed = JSON.parse(config!);
		expect(parsed.d1_writes).toBe(1_333_333);
	});

	it('does not re-seed if seed flag exists', async () => {
		// Set seed flag
		await env.CF_MONITOR_KV.put('budget:config:__seeded__', 'true');

		// Set usage but no budget config
		await env.CF_MONITOR_KV.put(
			`${KV.BUDGET_DAILY}my-api:${today}`,
			JSON.stringify({ d1_writes: 5000 })
		);

		await checkBudgets(env);

		// __account__ config should NOT be created (seed flag prevents it)
		const config = await env.CF_MONITOR_KV.get('budget:config:__account__');
		expect(config).toBeNull();
	});

	it('__account__ fallback applies when per-feature get() returns null', async () => {
		// Simulate: per-feature config key exists in list but get returns null (edge cache).
		// __account__ config exists as fallback.
		await env.CF_MONITOR_KV.put(
			`${KV.BUDGET_CONFIG}__account__`,
			JSON.stringify({ d1_writes: 100 })
		);
		// Create a per-feature config key that will return null on get()
		await env.CF_MONITOR_KV.put(`${KV.BUDGET_CONFIG}flaky-feature`, 'placeholder');
		await env.CF_MONITOR_KV.put(
			`${KV.BUDGET_DAILY}flaky-feature:${today}`,
			JSON.stringify({ d1_writes: 150 })
		);

		// Override get to return null for the per-feature config (simulating edge cache miss)
		const originalGet = env.CF_MONITOR_KV.get.bind(env.CF_MONITOR_KV);
		vi.spyOn(env.CF_MONITOR_KV, 'get').mockImplementation(async (key: string, ...args: unknown[]) => {
			if (key === `${KV.BUDGET_CONFIG}flaky-feature`) return null;
			return (originalGet as Function)(key, ...args);
		});

		await checkBudgets(env);

		// Should trip using __account__ fallback config (limit: 100, usage: 150)
		expect(tripFeatureCb).toHaveBeenCalledWith(
			env.CF_MONITOR_KV,
			'flaky-feature',
			expect.stringContaining('budget exceeded')
		);
	});

	it('per-feature config takes priority over __account__ fallback', async () => {
		// Set per-feature config with low limit
		await setFeatureBudget('my-feature', { d1_writes: 100 });
		// Set account-wide config with high limit
		await env.CF_MONITOR_KV.put(
			`${KV.BUDGET_CONFIG}__account__`,
			JSON.stringify({ d1_writes: 10_000 })
		);
		// Set usage that exceeds per-feature but not account-wide
		await setFeatureUsage('my-feature', { d1_writes: 150 });

		await checkBudgets(env);

		// Should trip based on per-feature config (100), not account-wide (10000)
		expect(tripFeatureCb).toHaveBeenCalledWith(
			env.CF_MONITOR_KV,
			'my-feature',
			expect.stringContaining('budget exceeded')
		);
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

describe('checkBudgets — monthly (#13)', () => {
	it('does nothing when no monthly configs exist', async () => {
		await checkBudgets(env);
		expect(tripFeatureCb).not.toHaveBeenCalled();
	});

	it('does nothing at 60% monthly usage', async () => {
		await setMonthlyBudget('my-feature', { d1_writes: 1_000_000 });
		await setMonthlyUsage('my-feature', { d1_writes: 600_000 });

		await checkBudgets(env);

		expect(tripFeatureCb).not.toHaveBeenCalled();
		expect(sendSlackAlert).not.toHaveBeenCalled();
	});

	it('sends Slack warning at 70% monthly usage', async () => {
		await setMonthlyBudget('my-feature', { d1_writes: 1_000_000 });
		await setMonthlyUsage('my-feature', { d1_writes: 750_000 });

		await checkBudgets(env);

		expect(sendSlackAlert).toHaveBeenCalledOnce();
	});

	it('trips CB at 100% monthly usage', async () => {
		await setMonthlyBudget('my-feature', { d1_writes: 1_000_000 });
		await setMonthlyUsage('my-feature', { d1_writes: 1_050_000 });

		await checkBudgets(env);

		expect(tripFeatureCb).toHaveBeenCalledWith(
			env.CF_MONITOR_KV,
			'my-feature',
			expect.stringContaining('monthly')
		);
		expect(sendSlackAlert).toHaveBeenCalled();
	});

	it('daily and monthly budgets are checked independently', async () => {
		// Daily: fine
		await setFeatureBudget('my-feature', { d1_writes: 100_000 });
		await setFeatureUsage('my-feature', { d1_writes: 50_000 }); // 50%

		// Monthly: over budget
		await setMonthlyBudget('my-feature', { d1_writes: 1_000_000 });
		await setMonthlyUsage('my-feature', { d1_writes: 1_100_000 }); // 110%

		await checkBudgets(env);

		// CB tripped for monthly, not daily
		expect(tripFeatureCb).toHaveBeenCalledOnce();
		expect(tripFeatureCb).toHaveBeenCalledWith(
			env.CF_MONITOR_KV,
			'my-feature',
			expect.stringContaining('monthly')
		);
	});
});
