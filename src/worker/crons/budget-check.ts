import { KV } from '../../constants.js';
import type { MonitorWorkerEnv } from '../../types.js';
import { tripFeatureCb } from '../../sdk/circuit-breaker.js';
import { sendSlackAlert, formatBudgetWarning } from '../alerts/slack.js';
import { getPlanOrCached, getBillingPeriodOrCached, getBillingPeriodKey } from '../account/subscriptions.js';
import { getDailyBudgetsForPlan } from '../account/plan-allowances.js';

/** Budget config prefix for monthly limits. */
const BUDGET_CONFIG_MONTHLY = 'budget:config:monthly:';

/** Auto-seed flag key — prevents re-seeding every hour. */
const SEED_FLAG = 'budget:config:__seeded__';

/**
 * Hourly: Check feature budgets against configured limits.
 * Reads accumulated usage from KV, compares to budget config.
 * Trips circuit breakers and sends Slack alerts at 70%/90%/100%.
 */
export async function checkBudgets(env: MonitorWorkerEnv): Promise<void> {
	await checkDailyBudgets(env);
	await checkMonthlyBudgets(env);
}

// =============================================================================
// DAILY BUDGETS
// =============================================================================

async function checkDailyBudgets(env: MonitorWorkerEnv): Promise<void> {
	const configList = await env.CF_MONITOR_KV.list({ prefix: KV.BUDGET_CONFIG, limit: 200 });
	const today = new Date().toISOString().slice(0, 10);

	// Filter to only actual daily config keys (not monthly, not seed flag)
	let dailyConfigs = configList.keys.filter(
		(k) => !k.name.startsWith(BUDGET_CONFIG_MONTHLY) && k.name !== SEED_FLAG
	);

	// Auto-seed if no daily budget configs exist
	if (dailyConfigs.length === 0) {
		await autoSeedBudgets(env);
		// Re-read after seeding
		const reloaded = await env.CF_MONITOR_KV.list({ prefix: KV.BUDGET_CONFIG, limit: 200 });
		dailyConfigs = reloaded.keys.filter(
			(k) => !k.name.startsWith(BUDGET_CONFIG_MONTHLY) && k.name !== SEED_FLAG
		);
	}

	for (const key of dailyConfigs) {
		const featureId = key.name.replace(KV.BUDGET_CONFIG, '');
		try {
			await checkFeatureBudget(env, featureId, today);
		} catch (err) {
			console.error(`[cf-monitor:budget] Daily check failed for ${featureId}: ${err}`);
		}
	}
}

/** Auto-seed default budget configs when none exist (safety net). */
async function autoSeedBudgets(env: MonitorWorkerEnv): Promise<void> {
	// Check if we already seeded recently (avoid redundant KV writes)
	const seeded = await env.CF_MONITOR_KV.get(SEED_FLAG);
	if (seeded) return;

	// Detect plan to select correct budget defaults (#53)
	const plan = await getPlanOrCached(env);
	const budgetDefaults = getDailyBudgetsForPlan(plan);

	console.log(`[cf-monitor:budget] No budget configs found. Auto-seeding ${plan} plan defaults.`);

	const defaults = JSON.stringify(budgetDefaults);

	// Discover active features from usage keys
	const usageList = await env.CF_MONITOR_KV.list({ prefix: KV.BUDGET_DAILY, limit: 200 });
	const features = new Set<string>();
	for (const key of usageList.keys) {
		// Key format: budget:usage:daily:{featureId}:{date}
		const suffix = key.name.replace(KV.BUDGET_DAILY, '');
		// Strip the date suffix (last 11 chars: colon + YYYY-MM-DD)
		const dateIdx = suffix.lastIndexOf(':');
		if (dateIdx > 0) {
			features.add(suffix.slice(0, dateIdx));
		}
	}

	// Write per-feature budget config using paid plan defaults
	const writes: Promise<void>[] = [];
	for (const featureId of features) {
		writes.push(
			env.CF_MONITOR_KV.put(
				`${KV.BUDGET_CONFIG}${featureId}`,
				defaults,
				{ expirationTtl: 90000 } // 25hr TTL — auto-seed re-runs if config-sync never runs
			)
		);
	}

	// Account-wide fallback (always created)
	writes.push(
		env.CF_MONITOR_KV.put(
			`${KV.BUDGET_CONFIG}__account__`,
			defaults,
			{ expirationTtl: 90000 }
		)
	);

	// Set seed flag (24hr TTL) to avoid re-seeding every hour
	writes.push(
		env.CF_MONITOR_KV.put(SEED_FLAG, new Date().toISOString(), { expirationTtl: 86400 })
	);

	await Promise.all(writes);
	console.log(`[cf-monitor:budget] Auto-seeded ${features.size + 1} budget config(s).`);
}

async function checkFeatureBudget(
	env: MonitorWorkerEnv,
	featureId: string,
	today: string
): Promise<void> {
	let [configRaw, usageRaw] = await Promise.all([
		env.CF_MONITOR_KV.get(`${KV.BUDGET_CONFIG}${featureId}`),
		env.CF_MONITOR_KV.get(`${KV.BUDGET_DAILY}${featureId}:${today}`),
	]);

	// Fallback to account-wide budget config
	if (!configRaw && featureId !== '__account__') {
		configRaw = await env.CF_MONITOR_KV.get(`${KV.BUDGET_CONFIG}__account__`);
	}

	if (!configRaw) return;

	const config = JSON.parse(configRaw) as Record<string, number>;
	const usage = usageRaw ? JSON.parse(usageRaw) as Record<string, number> : {};

	for (const [metric, limit] of Object.entries(config)) {
		if (limit <= 0) continue;

		const current = usage[metric] ?? 0;
		const pct = (current / limit) * 100;

		// Trip circuit breaker at 100%
		if (pct >= 100) {
			await tripFeatureCb(env.CF_MONITOR_KV, featureId, `${metric} budget exceeded (${current}/${limit})`);
			await sendSlackAlert(
				env,
				`cb:${featureId}:${today}`,
				3600,
				formatBudgetWarning(env.ACCOUNT_NAME, featureId, metric, current, limit, pct)
			);
			continue;
		}

		// Warning at 90%
		if (pct >= 90) {
			await sendSlackAlert(
				env,
				`critical:${featureId}:${metric}:${today}`,
				3600,
				formatBudgetWarning(env.ACCOUNT_NAME, featureId, metric, current, limit, pct)
			);
			continue;
		}

		// Warning at 70%
		if (pct >= 70) {
			await sendSlackAlert(
				env,
				`warning:${featureId}:${metric}:${today}`,
				3600,
				formatBudgetWarning(env.ACCOUNT_NAME, featureId, metric, current, limit, pct)
			);
		}
	}
}

// =============================================================================
// MONTHLY BUDGETS (#13)
// =============================================================================

async function checkMonthlyBudgets(env: MonitorWorkerEnv): Promise<void> {
	const [configList, billingPeriod] = await Promise.all([
		env.CF_MONITOR_KV.list({ prefix: BUDGET_CONFIG_MONTHLY, limit: 200 }),
		getBillingPeriodOrCached(env),
	]);

	const periodKey = getBillingPeriodKey(billingPeriod); // e.g. "2026-03-02" or null
	const calendarMonth = new Date().toISOString().slice(0, 7); // e.g. "2026-03"

	for (const key of configList.keys) {
		const featureId = key.name.replace(BUDGET_CONFIG_MONTHLY, '');
		try {
			await checkMonthlyFeatureBudget(env, featureId, periodKey, calendarMonth);
		} catch (err) {
			console.error(`[cf-monitor:budget] Monthly check failed for ${featureId}: ${err}`);
		}
	}
}

async function checkMonthlyFeatureBudget(
	env: MonitorWorkerEnv,
	featureId: string,
	periodKey: string | null,
	calendarMonth: string
): Promise<void> {
	// Fetch config + usage from both key formats (transition safety for #54)
	const fetches: Promise<string | null>[] = [
		env.CF_MONITOR_KV.get(`${BUDGET_CONFIG_MONTHLY}${featureId}`),
	];

	// Primary key: billing-period-aware if available, else calendar month
	const primaryKey = periodKey
		? `${KV.BUDGET_MONTHLY}${featureId}:${periodKey}`
		: `${KV.BUDGET_MONTHLY}${featureId}:${calendarMonth}`;
	fetches.push(env.CF_MONITOR_KV.get(primaryKey));

	// Also check the other format during transition
	if (periodKey) {
		fetches.push(env.CF_MONITOR_KV.get(`${KV.BUDGET_MONTHLY}${featureId}:${calendarMonth}`));
	}

	const results = await Promise.all(fetches);
	const configRaw = results[0];
	const primaryUsageRaw = results[1];
	const fallbackUsageRaw = results[2] ?? null;

	if (!configRaw) return;

	const config = JSON.parse(configRaw) as Record<string, number>;

	// Merge usage from both key formats during billing period transition
	const primaryUsage = primaryUsageRaw ? JSON.parse(primaryUsageRaw) as Record<string, number> : {};
	const fallbackUsage = fallbackUsageRaw ? JSON.parse(fallbackUsageRaw) as Record<string, number> : {};
	const usage: Record<string, number> = { ...primaryUsage };
	for (const [k, v] of Object.entries(fallbackUsage)) {
		usage[k] = (usage[k] ?? 0) + v;
	}

	// Dedup key uses billing period or calendar month
	const dedupSuffix = periodKey ?? calendarMonth;

	for (const [metric, limit] of Object.entries(config)) {
		if (limit <= 0) continue;

		const current = usage[metric] ?? 0;
		const pct = (current / limit) * 100;

		if (pct >= 100) {
			await tripFeatureCb(env.CF_MONITOR_KV, featureId, `monthly ${metric} budget exceeded (${current}/${limit})`);
			await sendSlackAlert(
				env,
				`monthly:cb:${featureId}:${dedupSuffix}`,
				86400,
				formatBudgetWarning(env.ACCOUNT_NAME, featureId, `${metric} (monthly)`, current, limit, pct)
			);
			continue;
		}

		if (pct >= 90) {
			await sendSlackAlert(
				env,
				`monthly:critical:${featureId}:${metric}:${dedupSuffix}`,
				86400,
				formatBudgetWarning(env.ACCOUNT_NAME, featureId, `${metric} (monthly)`, current, limit, pct)
			);
			continue;
		}

		if (pct >= 70) {
			await sendSlackAlert(
				env,
				`monthly:warning:${featureId}:${metric}:${dedupSuffix}`,
				86400,
				formatBudgetWarning(env.ACCOUNT_NAME, featureId, `${metric} (monthly)`, current, limit, pct)
			);
		}
	}
}
