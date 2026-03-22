/**
 * Cloudflare API client for CLI resource provisioning.
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

function headers(apiToken: string): Record<string, string> {
	return {
		Authorization: `Bearer ${apiToken}`,
		'Content-Type': 'application/json',
	};
}

/**
 * Create a KV namespace. Returns the namespace ID.
 */
export async function createKVNamespace(
	accountId: string,
	apiToken: string,
	title: string
): Promise<string> {
	// Check if it already exists
	const listResponse = await fetch(
		`${CF_API}/accounts/${accountId}/storage/kv/namespaces?per_page=100`,
		{ headers: headers(apiToken) }
	);

	if (listResponse.ok) {
		const listData = await listResponse.json() as {
			result: Array<{ id: string; title: string }>;
		};
		const existing = listData.result?.find((ns) => ns.title === title);
		if (existing) return existing.id;
	}

	// Create new
	const response = await fetch(
		`${CF_API}/accounts/${accountId}/storage/kv/namespaces`,
		{
			method: 'POST',
			headers: headers(apiToken),
			body: JSON.stringify({ title }),
		}
	);

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Failed to create KV namespace: ${response.status} ${text}`);
	}

	const data = await response.json() as { result: { id: string } };
	return data.result.id;
}

/**
 * List all workers on the account. Returns worker names.
 */
export async function listWorkers(accountId: string, apiToken: string): Promise<string[]> {
	const response = await fetch(
		`${CF_API}/accounts/${accountId}/workers/scripts`,
		{ headers: headers(apiToken) }
	);

	if (!response.ok) {
		throw new Error(`Failed to list workers: ${response.status}`);
	}

	const data = await response.json() as {
		result: Array<{ id: string }>;
	};

	return data.result?.map((w) => w.id) ?? [];
}

/**
 * Delete a KV namespace.
 */
export async function deleteKVNamespace(
	accountId: string,
	apiToken: string,
	namespaceId: string
): Promise<void> {
	const response = await fetch(
		`${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`,
		{ method: 'DELETE', headers: headers(apiToken) }
	);

	if (!response.ok && response.status !== 404) {
		const text = await response.text();
		throw new Error(`Failed to delete KV namespace: ${response.status} ${text}`);
	}
}

/**
 * Write a value to a KV namespace key.
 */
export async function writeKVValue(
	accountId: string,
	apiToken: string,
	namespaceId: string,
	key: string,
	value: string
): Promise<void> {
	const response = await fetch(
		`${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
		{
			method: 'PUT',
			headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'text/plain' },
			body: value,
		}
	);

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Failed to write KV key: ${response.status} ${text}`);
	}
}

/**
 * Delete a KV namespace key.
 */
export async function deleteKVKey(
	accountId: string,
	apiToken: string,
	namespaceId: string,
	key: string
): Promise<void> {
	const response = await fetch(
		`${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
		{ method: 'DELETE', headers: headers(apiToken) }
	);

	if (!response.ok && response.status !== 404) {
		const text = await response.text();
		throw new Error(`Failed to delete KV key: ${response.status} ${text}`);
	}
}

/**
 * Read a value from a KV namespace key. Returns null if not found.
 */
export async function readKVValue(
	accountId: string,
	apiToken: string,
	namespaceId: string,
	key: string
): Promise<string | null> {
	const response = await fetch(
		`${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
		{ headers: { Authorization: `Bearer ${apiToken}` } }
	);

	if (response.status === 404) return null;
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Failed to read KV key: ${response.status} ${text}`);
	}

	return response.text();
}

/**
 * List keys in a KV namespace with optional prefix filter.
 */
export async function listKVKeys(
	accountId: string,
	apiToken: string,
	namespaceId: string,
	options?: { prefix?: string; limit?: number }
): Promise<Array<{ name: string }>> {
	const params = new URLSearchParams();
	if (options?.prefix) params.set('prefix', options.prefix);
	if (options?.limit) params.set('limit', String(options.limit));

	const response = await fetch(
		`${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/keys?${params}`,
		{ headers: headers(apiToken) }
	);

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Failed to list KV keys: ${response.status} ${text}`);
	}

	const data = await response.json() as { result: Array<{ name: string }> };
	return data.result ?? [];
}

/**
 * Detect the account plan type via Subscriptions API (#53).
 * Returns 'paid', 'free', or 'unknown' if API unavailable.
 */
export async function getAccountPlan(accountId: string, apiToken: string): Promise<string> {
	try {
		const subs = await getAccountSubscriptions(accountId, apiToken);
		if (!subs) return 'unknown';
		for (const sub of subs) {
			if (sub.rate_plan?.id === 'workers_paid' && sub.rate_plan?.scope === 'account') {
				return 'paid';
			}
		}
		return 'free';
	} catch {
		return 'unknown';
	}
}

interface SubscriptionResult {
	rate_plan: { id: string; public_name: string; scope: string };
	current_period_start: string;
	current_period_end: string;
}

/**
 * Fetch account subscriptions from CF API.
 * Returns null if token lacks #billing:read permission.
 */
export async function getAccountSubscriptions(
	accountId: string,
	apiToken: string
): Promise<SubscriptionResult[] | null> {
	const response = await fetch(
		`${CF_API}/accounts/${accountId}/subscriptions`,
		{ headers: headers(apiToken) }
	);

	if (response.status === 403) return null;
	if (!response.ok) return null;

	const data = await response.json() as { result: SubscriptionResult[]; success: boolean };
	return data.success ? data.result ?? [] : null;
}
