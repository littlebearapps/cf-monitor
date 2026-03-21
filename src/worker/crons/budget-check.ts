import { KV } from '../../constants.js';
import type { MonitorWorkerEnv } from '../../types.js';
import { tripFeatureCb } from '../../sdk/circuit-breaker.js';
import { sendSlackAlert, formatBudgetWarning } from '../alerts/slack.js';

/**
 * Hourly: Check feature budgets against configured limits.
 * Reads accumulated usage from KV, compares to budget config.
 * Trips circuit breakers and sends Slack alerts at 70%/90%/100%.
 */
export async function checkBudgets(env: MonitorWorkerEnv): Promise<void> {
	// List all budget configs
	const configList = await env.CF_MONITOR_KV.list({ prefix: KV.BUDGET_CONFIG, limit: 200 });
	const today = new Date().toISOString().slice(0, 10);

	for (const key of configList.keys) {
		const featureId = key.name.replace(KV.BUDGET_CONFIG, '');
		try {
			await checkFeatureBudget(env, featureId, today);
		} catch (err) {
			console.error(`[cf-monitor:budget] Check failed for ${featureId}: ${err}`);
		}
	}
}

async function checkFeatureBudget(
	env: MonitorWorkerEnv,
	featureId: string,
	today: string
): Promise<void> {
	const [configRaw, usageRaw] = await Promise.all([
		env.CF_MONITOR_KV.get(`${KV.BUDGET_CONFIG}${featureId}`),
		env.CF_MONITOR_KV.get(`${KV.BUDGET_DAILY}${featureId}:${today}`),
	]);

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
