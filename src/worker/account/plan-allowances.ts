import type { AccountPlan, PlanAllowances } from '../../types.js';

// =============================================================================
// MONTHLY PLAN ALLOWANCES (from CF pricing page)
// =============================================================================

/** Workers Paid plan monthly included allowances. */
export const PAID_PLAN_MONTHLY_ALLOWANCES: PlanAllowances = {
	workers: { requests: 10_000_000, cpuMs: 30_000_000 },
	d1: { rowsRead: 5_000_000_000, rowsWritten: 50_000_000, storageMb: 5_000 },
	kv: { reads: 10_000_000, writes: 1_000_000, deletes: 1_000_000, lists: 1_000_000 },
	r2: { classA: 1_000_000, classB: 10_000_000, storageMb: 10_000 },
	ai: { neurons: 10_000_000, requests: Infinity },
	aiGateway: { requests: Infinity },
	durableObjects: { requests: 1_000_000, storedBytes: 1_000_000_000 },
	vectorize: { queries: 30_000_000 },
	queues: { produced: 1_000_000, consumed: 1_000_000 },
};

/** Workers Free plan monthly included allowances. */
export const FREE_PLAN_MONTHLY_ALLOWANCES: PlanAllowances = {
	workers: { requests: 100_000, cpuMs: 10_000_000 },
	d1: { rowsRead: 5_000_000, rowsWritten: 100_000, storageMb: 5_000 },
	kv: { reads: 100_000, writes: 1_000, deletes: 1_000, lists: 1_000 },
	r2: { classA: 1_000_000, classB: 10_000_000, storageMb: 10_000 },
	ai: { neurons: 10_000, requests: Infinity },
	aiGateway: { requests: Infinity },
	durableObjects: { requests: 0, storedBytes: 0 },
	vectorize: { queries: 30_000_000 },
	queues: { produced: 0, consumed: 0 },
};

// =============================================================================
// DAILY BUDGET DEFAULTS (derived from monthly / 30 * safety margin)
// =============================================================================

/** Default daily budgets for CF Workers Paid plan. */
export const PAID_PLAN_DAILY_BUDGETS = {
	d1_writes: 1_333_333, // 50M/month / 30 * 0.8
	d1_reads: 16_666_667, // 5B/month / 30 * 0.1 (conservative)
	kv_writes: 26_667, // 1M/month / 30 * 0.8
	kv_reads: 333_333, // 10M/month / 30 * 0.1
	ai_neurons: 333_333, // 10M/month / 30
	r2_class_a: 33_333, // 1M/month / 30
	r2_class_b: 333_333, // 10M/month / 30
} as const;

/** Default daily budgets for CF Workers Free plan. */
export const FREE_PLAN_DAILY_BUDGETS = {
	d1_writes: 10_000,
	d1_reads: 166_667,
	kv_writes: 1_000,
	kv_reads: 33_333,
	ai_neurons: 33_333,
	r2_class_a: 3_333,
	r2_class_b: 33_333,
} as const;

// =============================================================================
// HELPERS
// =============================================================================

/** Get monthly allowances for a given plan type. */
export function getAllowancesForPlan(plan: AccountPlan): PlanAllowances {
	return plan === 'paid' ? PAID_PLAN_MONTHLY_ALLOWANCES : FREE_PLAN_MONTHLY_ALLOWANCES;
}

/** Get daily budget defaults for a given plan type. */
export function getDailyBudgetsForPlan(plan: AccountPlan): Record<string, number> {
	return plan === 'paid'
		? { ...PAID_PLAN_DAILY_BUDGETS }
		: { ...FREE_PLAN_DAILY_BUDGETS };
}
