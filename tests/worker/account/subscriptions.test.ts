import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectPlan, getBillingPeriod, getBillingPeriodKey, getPlanOrCached, getBillingPeriodOrCached } from '../../../src/worker/account/subscriptions.js';
import type { MonitorWorkerEnv } from '../../../src/types.js';
import { KV } from '../../../src/constants.js';

// =============================================================================
// FIXTURES
// =============================================================================

function paidSubscription(periodStart = '2026-03-02T00:00:00Z', periodEnd = '2026-04-02T00:00:00Z') {
	return {
		rate_plan: { id: 'workers_paid', public_name: 'Workers Paid', scope: 'account' },
		current_period_start: periodStart,
		current_period_end: periodEnd,
	};
}

function freeSubscription() {
	return {
		rate_plan: { id: 'workers_free', public_name: 'Workers Free', scope: 'account' },
		current_period_start: '2026-03-01T00:00:00Z',
		current_period_end: '2026-04-01T00:00:00Z',
	};
}

function nonWorkersSub() {
	return {
		rate_plan: { id: 'pro_plus', public_name: 'Pro Plus', scope: 'zone' },
		current_period_start: '2026-03-01T00:00:00Z',
		current_period_end: '2026-04-01T00:00:00Z',
	};
}

function mockKv() {
	const store = new Map<string, string>();
	return {
		get: vi.fn(async (key: string) => store.get(key) ?? null),
		put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
		delete: vi.fn(async (key: string) => { store.delete(key); }),
		list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
		getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
		_store: store,
	} as unknown as KVNamespace;
}

function mockEnv(overrides?: Partial<MonitorWorkerEnv>): MonitorWorkerEnv {
	return {
		CF_MONITOR_KV: mockKv(),
		CF_MONITOR_AE: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
		CF_ACCOUNT_ID: 'test-account-id',
		ACCOUNT_NAME: 'test-account',
		CLOUDFLARE_API_TOKEN: 'test-token',
		...overrides,
	};
}

// =============================================================================
// detectPlan()
// =============================================================================

describe('detectPlan', () => {
	it('returns "paid" for workers_paid subscription', () => {
		expect(detectPlan([paidSubscription()])).toBe('paid');
	});

	it('returns "free" for workers_free subscription', () => {
		expect(detectPlan([freeSubscription()])).toBe('free');
	});

	it('returns "free" when no subscriptions', () => {
		expect(detectPlan([])).toBe('free');
	});

	it('returns "free" for non-workers subscriptions only', () => {
		expect(detectPlan([nonWorkersSub()])).toBe('free');
	});

	it('returns "paid" when mixed subscriptions include workers_paid', () => {
		expect(detectPlan([nonWorkersSub(), paidSubscription()])).toBe('paid');
	});
});

// =============================================================================
// getBillingPeriod()
// =============================================================================

describe('getBillingPeriod', () => {
	it('extracts billing period from account-scoped subscription', () => {
		const result = getBillingPeriod([paidSubscription('2026-03-02T00:00:00Z', '2026-04-02T00:00:00Z')]);
		expect(result).toEqual({
			start: '2026-03-02T00:00:00Z',
			end: '2026-04-02T00:00:00Z',
			dayOfMonth: 2,
		});
	});

	it('returns null when no account-scoped subscription', () => {
		expect(getBillingPeriod([])).toBeNull();
	});

	it('ignores zone-scoped subscriptions', () => {
		// nonWorkersSub is zone-scoped but has dates — should still be picked up
		// because it has scope: 'zone', not 'account'
		const zoneSub = { ...nonWorkersSub() };
		// Actually nonWorkersSub has scope: 'zone' so it shouldn't match
		expect(getBillingPeriod([zoneSub])).toBeNull();
	});

	it('calculates dayOfMonth correctly for different dates', () => {
		const result = getBillingPeriod([paidSubscription('2026-01-15T00:00:00Z', '2026-02-15T00:00:00Z')]);
		expect(result?.dayOfMonth).toBe(15);
	});
});

// =============================================================================
// getBillingPeriodKey()
// =============================================================================

describe('getBillingPeriodKey', () => {
	it('returns YYYY-MM-DD from billing period start', () => {
		expect(getBillingPeriodKey({
			start: '2026-03-02T00:00:00Z',
			end: '2026-04-02T00:00:00Z',
			dayOfMonth: 2,
		})).toBe('2026-03-02');
	});

	it('returns null when period is null', () => {
		expect(getBillingPeriodKey(null)).toBeNull();
	});
});

// =============================================================================
// getPlanOrCached()
// =============================================================================

describe('getPlanOrCached', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('returns cached plan from KV', async () => {
		const env = mockEnv();
		(env.CF_MONITOR_KV.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce('free');
		const result = await getPlanOrCached(env);
		expect(result).toBe('free');
	});

	it('defaults to "paid" when no API token', async () => {
		const env = mockEnv({ CLOUDFLARE_API_TOKEN: undefined });
		const result = await getPlanOrCached(env);
		expect(result).toBe('paid');
	});

	it('defaults to "paid" when API returns 403', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response('Forbidden', { status: 403 })
		);
		const result = await getPlanOrCached(env);
		expect(result).toBe('paid');
	});

	it('caches detected plan in KV', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			Response.json({ success: true, result: [paidSubscription()] })
		);
		const result = await getPlanOrCached(env);
		expect(result).toBe('paid');
		expect(env.CF_MONITOR_KV.put).toHaveBeenCalledWith(
			KV.CONFIG_PLAN,
			'paid',
			expect.objectContaining({ expirationTtl: 86400 })
		);
	});
});

// =============================================================================
// getBillingPeriodOrCached()
// =============================================================================

describe('getBillingPeriodOrCached', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('returns cached billing period from KV', async () => {
		const env = mockEnv();
		const period = { start: '2026-03-02T00:00:00Z', end: '2026-04-02T00:00:00Z', dayOfMonth: 2 };
		(env.CF_MONITOR_KV.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(JSON.stringify(period));
		const result = await getBillingPeriodOrCached(env);
		expect(result).toEqual(period);
	});

	it('returns null when no API token', async () => {
		const env = mockEnv({ CLOUDFLARE_API_TOKEN: undefined });
		const result = await getBillingPeriodOrCached(env);
		expect(result).toBeNull();
	});

	it('fetches and caches billing period', async () => {
		const env = mockEnv();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			Response.json({ success: true, result: [paidSubscription('2026-03-02T00:00:00Z', '2026-04-02T00:00:00Z')] })
		);
		const result = await getBillingPeriodOrCached(env);
		expect(result).toEqual({
			start: '2026-03-02T00:00:00Z',
			end: '2026-04-02T00:00:00Z',
			dayOfMonth: 2,
		});
		expect(env.CF_MONITOR_KV.put).toHaveBeenCalledWith(
			KV.CONFIG_BILLING_PERIOD,
			expect.any(String),
			expect.objectContaining({ expirationTtl: 2_764_800 })
		);
	});
});
