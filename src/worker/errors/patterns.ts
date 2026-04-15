/**
 * Transient error patterns — static + custom from cf-monitor.yaml.
 *
 * These patterns identify errors that are expected to be temporary
 * (rate limits, timeouts, quotas) and should be deduplicated
 * to one issue per category per day.
 */

import type { CustomTransientPattern } from '../../types.js';

interface TransientPattern {
	/** Pattern name for dedup key */
	name: string;
	/** Test function */
	test: (message: string, outcome: string) => boolean;
}

const TRANSIENT_PATTERNS: TransientPattern[] = [
	{
		name: 'rate-limited',
		test: (msg) =>
			/rate.?limit/i.test(msg) ||
			/429/i.test(msg) ||
			/too many requests/i.test(msg),
	},
	{
		name: 'timeout',
		test: (msg) =>
			/timeout/i.test(msg) ||
			/timed out/i.test(msg) ||
			/ETIMEDOUT/i.test(msg),
	},
	{
		name: 'quota-exhausted',
		test: (msg) =>
			/quota/i.test(msg) ||
			/exceeded.*limit/i.test(msg) ||
			/billing/i.test(msg),
	},
	{
		name: 'connection-refused',
		test: (msg) =>
			/ECONNREFUSED/i.test(msg) ||
			/connection.*refused/i.test(msg),
	},
	{
		name: 'dns-failure',
		test: (msg) =>
			/ENOTFOUND/i.test(msg) ||
			/DNS.*failed/i.test(msg) ||
			/getaddrinfo/i.test(msg),
	},
	{
		name: 'service-unavailable',
		test: (msg, outcome) =>
			outcome === 'canceled' ||
			outcome === 'responseStreamDisconnected' ||
			/503/i.test(msg) ||
			/502/i.test(msg) ||
			/service.*unavailable/i.test(msg),
	},
	{
		name: 'cf-internal',
		test: (msg) =>
			/internal error/i.test(msg) &&
			/cloudflare/i.test(msg),
	},
	{
		name: 'billing-exhausted',
		test: (msg) =>
			/insufficient.*balance/i.test(msg) ||
			/402\b/.test(msg) ||
			/payment.*required/i.test(msg),
	},
];

/**
 * Check if an error message matches a known transient pattern.
 * Returns true if the error should be rate-limited to one issue per day.
 * Accepts optional custom patterns from cf-monitor.yaml (#92).
 */
export function matchTransientPattern(
	message: string,
	outcome: string,
	customPatterns?: CustomTransientPattern[]
): boolean {
	if (TRANSIENT_PATTERNS.some((p) => p.test(message, outcome))) return true;
	if (customPatterns?.some((p) => new RegExp(p.match, 'i').test(message))) return true;
	return false;
}

/**
 * Get the transient pattern name for an error (for dedup keys).
 * Returns null if not transient.
 * Accepts optional custom patterns from cf-monitor.yaml (#92).
 */
export function getTransientPatternName(
	message: string,
	outcome: string,
	customPatterns?: CustomTransientPattern[]
): string | null {
	const builtIn = TRANSIENT_PATTERNS.find((p) => p.test(message, outcome));
	if (builtIn) return builtIn.name;
	const custom = customPatterns?.find((p) => new RegExp(p.match, 'i').test(message));
	return custom?.name ?? null;
}
