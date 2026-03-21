/**
 * Static transient error patterns.
 *
 * These patterns identify errors that are expected to be temporary
 * (rate limits, timeouts, quotas) and should be deduplicated
 * to one issue per category per day.
 */

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
];

/**
 * Check if an error message matches a known transient pattern.
 * Returns true if the error should be rate-limited to one issue per day.
 */
export function matchTransientPattern(message: string, outcome: string): boolean {
	return TRANSIENT_PATTERNS.some((p) => p.test(message, outcome));
}

/**
 * Get the transient pattern name for an error (for dedup keys).
 * Returns null if not transient.
 */
export function getTransientPatternName(message: string, outcome: string): string | null {
	const match = TRANSIENT_PATTERNS.find((p) => p.test(message, outcome));
	return match?.name ?? null;
}
