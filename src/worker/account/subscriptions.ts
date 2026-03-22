import { KV } from '../../constants.js';
import type { AccountPlan, BillingPeriod, MonitorWorkerEnv } from '../../types.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

// =============================================================================
// RAW API
// =============================================================================

interface SubscriptionResponse {
	result: Array<{
		rate_plan: {
			id: string;
			public_name: string;
			scope: string;
		};
		current_period_start: string;
		current_period_end: string;
		component_values?: Array<{
			name: string;
			value: number;
		}>;
	}>;
	success: boolean;
	errors: Array<{ message: string }>;
}

/** Fetch raw subscriptions from CF API. Returns null if token lacks #billing:read. */
export async function fetchSubscriptions(
	apiToken: string,
	accountId: string
): Promise<SubscriptionResponse['result'] | null> {
	const response = await fetch(
		`${CF_API}/accounts/${accountId}/subscriptions`,
		{
			headers: {
				Authorization: `Bearer ${apiToken}`,
				'Content-Type': 'application/json',
			},
		}
	);

	if (response.status === 403) {
		// Token lacks #billing:read permission
		return null;
	}

	if (!response.ok) {
		const text = await response.text();
		console.warn(`[cf-monitor:account] Subscriptions API error (${response.status}): ${text.slice(0, 200)}`);
		return null;
	}

	const data = await response.json() as SubscriptionResponse;
	if (!data.success) {
		console.warn(`[cf-monitor:account] Subscriptions API returned errors: ${data.errors?.[0]?.message}`);
		return null;
	}

	return data.result ?? [];
}

// =============================================================================
// PLAN DETECTION
// =============================================================================

/** Detect whether the account is on Workers Free or Workers Paid plan. */
export function detectPlan(subscriptions: SubscriptionResponse['result']): AccountPlan {
	for (const sub of subscriptions) {
		if (sub.rate_plan.id === 'workers_paid' && sub.rate_plan.scope === 'account') {
			return 'paid';
		}
	}
	return 'free';
}

// =============================================================================
// BILLING PERIOD
// =============================================================================

/** Extract billing period from subscriptions. */
export function getBillingPeriod(subscriptions: SubscriptionResponse['result']): BillingPeriod | null {
	for (const sub of subscriptions) {
		if (sub.rate_plan.scope === 'account' && sub.current_period_start && sub.current_period_end) {
			const start = sub.current_period_start;
			const end = sub.current_period_end;
			const dayOfMonth = new Date(start).getUTCDate();
			return { start, end, dayOfMonth };
		}
	}
	return null;
}

// =============================================================================
// KV-CACHED WRAPPERS
// =============================================================================

/**
 * Get the account plan, using KV cache (24hr TTL).
 * Falls back to 'paid' (conservative) if API unavailable.
 */
export async function getPlanOrCached(env: MonitorWorkerEnv): Promise<AccountPlan> {
	// Check KV cache first
	const cached = await env.CF_MONITOR_KV.get(KV.CONFIG_PLAN);
	if (cached === 'free' || cached === 'paid') return cached;

	if (!env.CLOUDFLARE_API_TOKEN || !env.CF_ACCOUNT_ID) {
		console.warn('[cf-monitor:account] No API token or account ID — defaulting to paid plan');
		return 'paid';
	}

	const subs = await fetchSubscriptions(env.CLOUDFLARE_API_TOKEN, env.CF_ACCOUNT_ID);
	if (!subs) {
		console.warn('[cf-monitor:account] Cannot detect plan — defaulting to paid');
		return 'paid';
	}

	const plan = detectPlan(subs);

	// Cache result (24hr TTL)
	await env.CF_MONITOR_KV.put(KV.CONFIG_PLAN, plan, { expirationTtl: 86400 });

	// Also cache billing period if available
	const period = getBillingPeriod(subs);
	if (period) {
		await env.CF_MONITOR_KV.put(
			KV.CONFIG_BILLING_PERIOD,
			JSON.stringify(period),
			{ expirationTtl: 2_764_800 } // 32 days
		);
	}

	return plan;
}

/**
 * Get the billing period, using KV cache (32d TTL).
 * Returns null if unavailable — callers should fall back to calendar month.
 */
export async function getBillingPeriodOrCached(env: MonitorWorkerEnv): Promise<BillingPeriod | null> {
	const cached = await env.CF_MONITOR_KV.get(KV.CONFIG_BILLING_PERIOD);
	if (cached) {
		try {
			return JSON.parse(cached) as BillingPeriod;
		} catch {
			// Corrupted cache — re-fetch
		}
	}

	if (!env.CLOUDFLARE_API_TOKEN || !env.CF_ACCOUNT_ID) return null;

	const subs = await fetchSubscriptions(env.CLOUDFLARE_API_TOKEN, env.CF_ACCOUNT_ID);
	if (!subs) return null;

	const period = getBillingPeriod(subs);
	if (period) {
		await env.CF_MONITOR_KV.put(
			KV.CONFIG_BILLING_PERIOD,
			JSON.stringify(period),
			{ expirationTtl: 2_764_800 }
		);
	}

	// Also cache plan while we have the data
	const plan = detectPlan(subs);
	await env.CF_MONITOR_KV.put(KV.CONFIG_PLAN, plan, { expirationTtl: 86400 });

	return period;
}

/**
 * Get billing period start date as a key suffix (YYYY-MM-DD).
 * Returns null if billing period is unknown — caller should fall back to YYYY-MM.
 */
export function getBillingPeriodKey(period: BillingPeriod | null): string | null {
	if (!period?.start) return null;
	return period.start.slice(0, 10); // "2026-03-02T00:00:00Z" → "2026-03-02"
}
