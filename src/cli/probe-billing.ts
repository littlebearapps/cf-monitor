/**
 * Read-only probe for the Cloudflare billing endpoints discovered by the 2026-05-27 API probe.
 *
 * `/accounts/{id}/billing/profile`, `/billing/history`, and `/billing/usage` exist but require a
 * `Billing Read` token (they 403 without it). This module probes them — plus `/subscriptions` as a
 * baseline — using GET only, never mutating anything, and redacts sensitive values before the caller
 * prints or persists the result.
 *
 * Do NOT wire `/billing/usage` into production until its payload shape is verified with a Billing Read
 * token — see docs/research/billing-endpoints-follow-up.md.
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

/**
 * The four endpoints probed, as path suffixes after `/accounts/{id}`.
 *
 * `/billing/usage` carries `?time_delta=day` because the server defaults to `time_delta=minute`
 * and rejects with HTTP 400 "time delta \"minute\" doesn't exist" — discovered 2026-05-28 against
 * Platform with a Billing Read token. `day` is the smallest accepted bucket; documented in
 * `docs/research/billing-endpoints-follow-up.md`.
 */
export const BILLING_PROBE_ENDPOINTS = [
	'/billing/profile',
	'/billing/history',
	'/billing/usage?time_delta=day',
	'/subscriptions',
] as const;

export type ProbeOutcome = 'payload' | 'permission_denied' | 'no_route' | 'unknown_error';

export interface ProbeEndpointResult {
	endpoint: string;
	status: number;
	outcome: ProbeOutcome;
	body: unknown; // redacted
}

/**
 * Map an HTTP status (+ body) to a probe outcome.
 *  - 2xx                                  → payload
 *  - 403                                  → permission_denied (endpoint exists, token lacks Billing Read)
 *  - 400/404 with a "could not route" msg → no_route (endpoint does not exist)
 *  - anything else                        → unknown_error
 */
export function classifyProbeOutcome(status: number, body: unknown): ProbeOutcome {
	if (status >= 200 && status < 300) return 'payload';
	if (status === 403) return 'permission_denied';
	if (status === 400 || status === 404) {
		const text = JSON.stringify(body ?? '').toLowerCase();
		if (text.includes('could not route') || text.includes('no route') || text.includes('not found')) {
			return 'no_route';
		}
		return 'unknown_error';
	}
	return 'unknown_error';
}

// Substrings that mark a key as carrying sensitive/PII data. Matched case-insensitively against the
// key name. Values under a matching key are replaced with '<REDACTED>'; the KEY itself is preserved so
// the payload shape stays learnable. Deliberately avoids ambiguous short tokens like bare `ip`/`id`
// (which would false-match `description`, `recipient`, etc.).
const SENSITIVE_KEY_SUBSTRINGS = [
	'email', 'phone', 'tax', 'vat', 'payment', 'card', 'secret', 'token',
	'password', 'passwd', 'street', 'zip', 'postal', 'address', 'ip_address',
	'account_id', 'customer_id', 'user_id', 'name', 'customer', 'company',
	'receipt', 'invoice',
];

// Value-shape patterns for opaque account-scoped identifiers. Caught regardless of key name so we
// also redact "bare" `id` fields (billing profile id, subscription id, zone id, etc.) without
// over-redacting catalog values like `rate_plan.id = "workers_paid"`. Added 2026-05-28 after the
// first Billing Read probe leaked subscription / Stripe / zone ids through the key-only filter.
const VALUE_PATTERNS: readonly RegExp[] = [
	/^[0-9a-f]{32}$/i, // CF account / zone / billing-profile / subscription ids
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUIDs (invoice ids etc.)
	/^(sub|cus|in|ch|pi|pm|src|seti|sk_test|sk_live|pk_test|pk_live|rk)_[A-Za-z0-9]{14,}$/, // Stripe object ids
];

function isSensitiveKey(key: string): boolean {
	const k = key.toLowerCase();
	return SENSITIVE_KEY_SUBSTRINGS.some((s) => k.includes(s));
}

function isSensitiveValue(s: string): boolean {
	return VALUE_PATTERNS.some((re) => re.test(s));
}

/**
 * Recursively redact a value:
 *  - string/number/boolean under a sensitive key → '<REDACTED>'
 *  - string values that look like opaque account-scoped ids (32-hex, UUID, Stripe id) → '<REDACTED_ID>'
 *  - other string values → the literal accountId is replaced with '<ACCOUNT_ID>' (catches it in URLs / composite IDs)
 *  - numbers, booleans, ISO dates, catalog values like `workers_paid` under non-sensitive keys pass through
 * Keys are always preserved so the payload structure remains inspectable.
 */
export function redactBilling(value: unknown, accountId: string): unknown {
	const seen = new WeakSet<object>();

	function walk(v: unknown, keyHint?: string): unknown {
		const sensitive = keyHint !== undefined && isSensitiveKey(keyHint);

		if (typeof v === 'string') {
			if (sensitive) return '<REDACTED>';
			if (isSensitiveValue(v)) return '<REDACTED_ID>';
			return accountId ? v.split(accountId).join('<ACCOUNT_ID>') : v;
		}
		if (typeof v === 'number' || typeof v === 'boolean') {
			return sensitive ? '<REDACTED>' : v;
		}
		if (v === null || v === undefined) return v;
		if (Array.isArray(v)) return v.map((item) => walk(item, keyHint));
		if (typeof v === 'object') {
			if (seen.has(v as object)) return '<CIRCULAR>';
			seen.add(v as object);
			const out: Record<string, unknown> = {};
			for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
				out[k] = walk(val, k);
			}
			return out;
		}
		return v;
	}

	return walk(value);
}

/**
 * Probe the billing endpoints with GET requests only. Returns one result per endpoint with a redacted
 * body. `fetchImpl` is injectable for testing. Never issues a mutating request.
 */
export async function probeBillingEndpoints(
	token: string,
	accountId: string,
	fetchImpl: typeof fetch = fetch
): Promise<ProbeEndpointResult[]> {
	const results: ProbeEndpointResult[] = [];

	for (const endpoint of BILLING_PROBE_ENDPOINTS) {
		const url = `${CF_API}/accounts/${accountId}${endpoint}`;
		let status = 0;
		let body: unknown = null;

		try {
			const resp = await fetchImpl(url, {
				method: 'GET',
				headers: { Authorization: `Bearer ${token}` },
			});
			status = resp.status;
			const text = await resp.text();
			try {
				body = JSON.parse(text);
			} catch {
				body = text;
			}
		} catch (err) {
			body = { error: err instanceof Error ? err.message : String(err) };
			status = 0;
		}

		const outcome = status === 0 ? 'unknown_error' : classifyProbeOutcome(status, body);
		results.push({ endpoint, status, outcome, body: redactBilling(body, accountId) });
	}

	return results;
}
