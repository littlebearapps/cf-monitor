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
 * Detect the account plan type.
 */
export async function getAccountPlan(accountId: string, apiToken: string): Promise<string> {
	try {
		const response = await fetch(
			`${CF_API}/accounts/${accountId}`,
			{ headers: headers(apiToken) }
		);

		if (!response.ok) return 'unknown';

		const data = await response.json() as {
			result: { settings?: { default_usage_model?: string } };
		};

		// Workers Paid plan typically shows "bundled" or similar
		return data.result?.settings?.default_usage_model ?? 'paid';
	} catch {
		return 'unknown';
	}
}
