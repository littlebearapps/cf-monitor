/**
 * Read-only probe for the Cloudflare Notifications/Alerting endpoints.
 *
 * Symmetric to `probe-billing.ts` — GET-only, never mutates. Used to inspect existing
 * notification policies and webhook destinations on an account, and to enumerate
 * available alert types (where the `billing_budget_alert` value was confirmed
 * during the 2026-05-27 live probe).
 *
 * Reuses `classifyProbeOutcome` and `redactBilling` from `probe-billing.ts` so opaque
 * ids (32-hex, UUID, Stripe ids) are scrubbed consistently before the snapshot is saved.
 */

import {
	classifyProbeOutcome,
	redactBilling,
	type ProbeEndpointResult,
} from './probe-billing.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

export const ALERTING_PROBE_ENDPOINTS = [
	'/alerting/v3/available_alerts',
	'/alerting/v3/policies',
	'/alerting/v3/destinations/webhooks',
] as const;

/**
 * Probe the alerting endpoints with GET only. Returns one redacted result per endpoint.
 * `fetchImpl` is injectable for testing. Never issues a mutating request.
 */
export async function probeAlertingEndpoints(
	token: string,
	accountId: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ProbeEndpointResult[]> {
	const results: ProbeEndpointResult[] = [];

	for (const endpoint of ALERTING_PROBE_ENDPOINTS) {
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
