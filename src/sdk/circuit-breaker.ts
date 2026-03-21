import { KV } from '../constants.js';

// =============================================================================
// CIRCUIT BREAKER STATUS
// =============================================================================

export type CbStatus = 'GO' | 'STOP';
export type AccountCbStatus = 'active' | 'warning' | 'paused';

/**
 * Check feature-level circuit breaker.
 * Returns 'GO' (proceed) or 'STOP' (blocked).
 */
export async function checkFeatureCb(
	kv: KVNamespace,
	featureId: string
): Promise<CbStatus> {
	try {
		const status = await kv.get(`${KV.CB_FEATURE}${featureId}`);
		return status === 'STOP' ? 'STOP' : 'GO';
	} catch {
		return 'GO'; // Fail open
	}
}

/**
 * Check account-level circuit breaker.
 * Returns null (proceed) or a 503 Response (blocked).
 */
export async function checkAccountCb(kv: KVNamespace): Promise<Response | null> {
	try {
		const [globalStop, accountStatus] = await Promise.all([
			kv.get(KV.CB_GLOBAL),
			kv.get(KV.CB_ACCOUNT),
		]);

		if (globalStop === 'true') {
			return createCbResponse('Global circuit breaker active', 3600);
		}

		if (accountStatus === 'paused') {
			return createCbResponse('Account paused due to resource limits', 1800);
		}

		return null;
	} catch {
		return null; // Fail open
	}
}

/**
 * Trip a feature circuit breaker.
 */
export async function tripFeatureCb(
	kv: KVNamespace,
	featureId: string,
	reason: string,
	ttlSeconds: number = 3600
): Promise<void> {
	await kv.put(`${KV.CB_FEATURE}${featureId}`, 'STOP', { expirationTtl: ttlSeconds });
	// Store reason for debugging
	await kv.put(`${KV.CB_FEATURE}${featureId}:reason`, reason, { expirationTtl: ttlSeconds });
}

/**
 * Reset a feature circuit breaker.
 * Writes 'GO' with short TTL instead of deleting — forces cache invalidation
 * across KV edge replicas, avoiding the ~10s eventual consistency delay that
 * kv.delete() exhibits. The 60s TTL ensures the key self-cleans.
 */
export async function resetFeatureCb(
	kv: KVNamespace,
	featureId: string
): Promise<void> {
	await Promise.all([
		kv.put(`${KV.CB_FEATURE}${featureId}`, 'GO', { expirationTtl: 60 }),
		kv.delete(`${KV.CB_FEATURE}${featureId}:reason`),
	]);
}

/**
 * Set account-level circuit breaker status.
 */
export async function setAccountCbStatus(
	kv: KVNamespace,
	status: AccountCbStatus,
	ttlSeconds: number = 86400
): Promise<void> {
	await kv.put(KV.CB_ACCOUNT, status, { expirationTtl: ttlSeconds });
}

// =============================================================================
// HELPERS
// =============================================================================

function createCbResponse(message: string, retryAfterSeconds: number): Response {
	return new Response(
		JSON.stringify({
			success: false,
			error: message,
			code: 'CIRCUIT_BREAKER',
			retryAfterSeconds,
		}),
		{
			status: 503,
			headers: {
				'Content-Type': 'application/json',
				'Retry-After': String(retryAfterSeconds),
				'X-Circuit-Breaker': 'active',
			},
		}
	);
}
