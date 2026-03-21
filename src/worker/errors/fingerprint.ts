/**
 * Error fingerprinting — stable hash for deduplication.
 *
 * Normalises error messages to strip variable content (timestamps, IDs, etc.)
 * so that the same logical error always produces the same fingerprint.
 */

/**
 * Compute a stable fingerprint for an error.
 * Same logical error → same fingerprint → same GitHub issue.
 */
export function computeFingerprint(scriptName: string, outcome: string, message: string): string {
	const normalised = normaliseMessage(message);
	const input = `${scriptName}:${outcome}:${normalised}`;
	return hashString(input);
}

/**
 * Normalise an error message by stripping variable content.
 */
function normaliseMessage(message: string): string {
	return message
		// Strip UUIDs
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
		// Strip hex IDs (24+ chars)
		.replace(/\b[0-9a-f]{24,}\b/gi, '<ID>')
		// Strip numeric IDs
		.replace(/\b\d{4,}\b/g, '<N>')
		// Strip timestamps
		.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\dZ]*/g, '<TS>')
		// Strip IP addresses
		.replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, '<IP>')
		// Collapse whitespace
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200);
}

/**
 * Simple hash function for fingerprinting.
 * Not cryptographic — just for dedup. Fast and deterministic.
 */
function hashString(input: string): string {
	let hash = 0x811c9dc5; // FNV offset basis
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = (hash * 0x01000193) >>> 0; // FNV prime, unsigned 32-bit
	}
	return hash.toString(16).padStart(8, '0');
}
