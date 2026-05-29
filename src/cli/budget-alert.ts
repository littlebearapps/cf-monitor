/**
 * Cloudflare Notifications API integration — Budget Alert opt-in registration.
 *
 * What this does:
 *  - POSTs a notification policy to `/accounts/{id}/alerting/v3/policies` with
 *    `alert_type: 'billing_budget_alert'` (alert type confirmed live via the 2026-05-27
 *    probe of `/alerting/v3/available_alerts`).
 *  - Routes the alert to an email recipient (CF accepts email mechanisms inline — no
 *    destination object needed) or a user-supplied webhook destination URL.
 *  - Dedups by a deterministic policy name (`cf-monitor:budget-alert`): if a policy with
 *    that name already exists, this updates it in place (PUT) rather than creating dupes.
 *
 * IMPORTANT — what this does NOT do:
 *  The dollar `$threshold` is NOT set via this API. Cloudflare's Budget Alert threshold
 *  is configured in the dashboard (Manage Account > Billing > Billable Usage > Add a
 *  Budget Alert). This API only subscribes a notification policy to the `billing_budget_alert`
 *  event type. The CLI records the user-stated threshold in the policy description + a KV
 *  blob for our own tracking, and prints a clear dashboard-step instruction.
 *
 * Alert type is `billing_budget_alert` per the 2026-05-27 probe. CF's public docs at
 * `developers.cloudflare.com/api/resources/alerting/...` document `billing_usage_alert`
 * (the older D1-rows-style usage alert) but not yet the newer `billing_budget_alert`;
 * the probe is the source of truth here.
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

/** Deterministic policy name so re-running the flag dedups instead of creating dupes. */
export const POLICY_NAME = 'cf-monitor:budget-alert';
export const ALERT_TYPE = 'billing_budget_alert';

export interface BudgetAlertConfig {
	/** Monthly dollar threshold the user expects. Recorded for our own tracking — the
	 *  actual threshold MUST be set in the Cloudflare dashboard. */
	threshold: number;
	/** If set, an email recipient. */
	recipientEmail?: string;
	/** If set, an existing webhook destination URL (we list-and-reuse, or create). */
	webhookUrl?: string;
}

export interface BudgetAlertStatus {
	policy_id: string;
	threshold: number;
	alert_type: typeof ALERT_TYPE;
	label: 'alert_only';
	recipient: 'email' | 'webhook';
	registered_at: string;
	dashboard_threshold_url: string;
}

interface CfPolicy {
	id: string;
	name?: string;
	alert_type?: string;
}

interface CfWebhookDestination {
	id: string;
	url?: string;
	name?: string;
}

const DASHBOARD_BUDGET_URL =
	'https://dash.cloudflare.com/?to=/:account/billing/billable-usage';

/**
 * Build the policy POST/PUT body. Pure — easy to test.
 *
 * Required: `name`, `alert_type`, `enabled`.
 * `mechanisms`: at least one of email/webhooks/pagerduty per CF docs.
 * `filters` left empty: `billing_budget_alert` reads its threshold from the dashboard,
 *  not the policy filters.
 */
export function buildPolicyBody(
	cfg: BudgetAlertConfig,
	mechanism: { type: 'email'; id: string } | { type: 'webhooks'; id: string },
): Record<string, unknown> {
	return {
		name: POLICY_NAME,
		alert_type: ALERT_TYPE,
		enabled: true,
		description:
			`cf-monitor-managed Budget Alert notification subscription. ` +
			`User-stated threshold: $${cfg.threshold}/mo. ` +
			`NOTE: the actual threshold MUST be set in the Cloudflare dashboard at ` +
			`Manage Account > Billing > Billable Usage. This API only routes the alert; ` +
			`it does not set the threshold. alert_only — not enforcement.`,
		mechanisms: { [mechanism.type]: [{ id: mechanism.id }] },
		filters: {},
	};
}

/**
 * List existing policies and return the cf-monitor-managed one if present.
 * Returns null if none exists. Throws on auth/network errors so the caller can
 * surface them clearly.
 */
export async function findExistingCfMonitorPolicy(
	accountId: string,
	apiToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<CfPolicy | null> {
	const resp = await fetchImpl(`${CF_API}/accounts/${accountId}/alerting/v3/policies`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${apiToken}` },
	});
	if (resp.status === 403) {
		throw new BudgetAlertError('forbidden', 'Notifications Read is required to list existing policies.');
	}
	if (!resp.ok) {
		throw new BudgetAlertError('list_failed', `Listing policies failed: HTTP ${resp.status}`);
	}
	const body = (await resp.json()) as { result?: CfPolicy[] };
	for (const p of body.result ?? []) {
		if (p.name === POLICY_NAME) return p;
	}
	return null;
}

/**
 * Reuse-or-create a webhook destination. Lists existing destinations and matches by URL.
 * If no match, creates one. Returns the destination id.
 */
export async function findOrCreateWebhookDestination(
	accountId: string,
	apiToken: string,
	webhookUrl: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const listResp = await fetchImpl(
		`${CF_API}/accounts/${accountId}/alerting/v3/destinations/webhooks`,
		{ method: 'GET', headers: { Authorization: `Bearer ${apiToken}` } },
	);
	if (listResp.status === 403) {
		throw new BudgetAlertError('forbidden', 'Notifications Write required to manage webhook destinations.');
	}
	if (listResp.ok) {
		const body = (await listResp.json()) as { result?: CfWebhookDestination[] };
		for (const d of body.result ?? []) {
			if (d.url === webhookUrl) return d.id;
		}
	}

	// Create
	const createResp = await fetchImpl(
		`${CF_API}/accounts/${accountId}/alerting/v3/destinations/webhooks`,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'cf-monitor:budget-alert-webhook', url: webhookUrl }),
		},
	);
	if (createResp.status === 403) {
		throw new BudgetAlertError('forbidden', 'Notifications Write required to create webhook destinations.');
	}
	if (!createResp.ok) {
		const text = await createResp.text().catch(() => '');
		throw new BudgetAlertError('create_failed', `Failed to create webhook destination: HTTP ${createResp.status} ${text.slice(0, 200)}`);
	}
	const created = (await createResp.json()) as { result?: { id?: string } };
	const id = created.result?.id;
	if (!id) throw new BudgetAlertError('create_failed', 'Webhook destination create succeeded but returned no id.');
	return id;
}

/**
 * Register (or update) the cf-monitor Budget Alert policy.
 *
 * Returns the captured status. Throws `BudgetAlertError` on a 403 or any explicit failure
 * so the caller can surface a clear message; no partial state is written.
 */
export async function registerBudgetAlert(
	accountId: string,
	apiToken: string,
	cfg: BudgetAlertConfig,
	fetchImpl: typeof fetch = fetch,
): Promise<BudgetAlertStatus> {
	if (!cfg.recipientEmail && !cfg.webhookUrl) {
		throw new BudgetAlertError(
			'no_recipient',
			'Either an email recipient or a webhook URL is required. The CLI auto-discovers the billing email from /billing/profile when neither flag is supplied.',
		);
	}

	const mechanism: { type: 'email'; id: string } | { type: 'webhooks'; id: string } = cfg.webhookUrl
		? { type: 'webhooks', id: await findOrCreateWebhookDestination(accountId, apiToken, cfg.webhookUrl, fetchImpl) }
		: { type: 'email', id: cfg.recipientEmail! };

	const existing = await findExistingCfMonitorPolicy(accountId, apiToken, fetchImpl);
	const body = buildPolicyBody(cfg, mechanism);

	let policyId: string;
	if (existing) {
		// Update in place — PUT to /policies/{id}.
		const resp = await fetchImpl(
			`${CF_API}/accounts/${accountId}/alerting/v3/policies/${existing.id}`,
			{
				method: 'PUT',
				headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			},
		);
		if (resp.status === 403) {
			throw new BudgetAlertError('forbidden', 'Notifications Write required to update the policy.');
		}
		if (!resp.ok) {
			const text = await resp.text().catch(() => '');
			throw new BudgetAlertError('update_failed', `Failed to update policy: HTTP ${resp.status} ${text.slice(0, 200)}`);
		}
		policyId = existing.id;
	} else {
		const resp = await fetchImpl(
			`${CF_API}/accounts/${accountId}/alerting/v3/policies`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			},
		);
		if (resp.status === 403) {
			throw new BudgetAlertError('forbidden', 'Notifications Write required to create the policy.');
		}
		if (!resp.ok) {
			const text = await resp.text().catch(() => '');
			throw new BudgetAlertError('create_failed', `Failed to create policy: HTTP ${resp.status} ${text.slice(0, 200)}`);
		}
		const created = (await resp.json()) as { result?: { id?: string } };
		const id = created.result?.id;
		if (!id) throw new BudgetAlertError('create_failed', 'Policy create succeeded but returned no id.');
		policyId = id;
	}

	return {
		policy_id: policyId,
		threshold: cfg.threshold,
		alert_type: ALERT_TYPE,
		label: 'alert_only',
		recipient: mechanism.type === 'email' ? 'email' : 'webhook',
		registered_at: new Date().toISOString(),
		dashboard_threshold_url: DASHBOARD_BUDGET_URL,
	};
}

/** Typed error so the CLI wrapper can surface clear messages without leaking stack traces. */
export class BudgetAlertError extends Error {
	constructor(public readonly code: string, message: string) {
		super(message);
		this.name = 'BudgetAlertError';
	}
}
