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
	let msg = message;

	// JSON structured logs: extract inner "message" field for fingerprinting (#92)
	if (msg.startsWith('{')) {
		try {
			const parsed = JSON.parse(msg);
			if (typeof parsed.message === 'string' && parsed.message.length > 0) {
				msg = parsed.message;
			}
		} catch {
			// Not valid JSON (possibly truncated) — continue with original
		}
	}

	return msg
		// Strip UUIDs
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
		// Strip timestamps BEFORE numeric IDs — \d{4,} would destroy the year (#94)
		.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\dZ]*/g, '<TS>')
		// Strip hex IDs (8+ chars — catches correlationIds, not just MongoDB ObjectIds)
		.replace(/\b[0-9a-f]{8,}\b/gi, '<ID>')
		// Strip numeric IDs (4+ digits)
		.replace(/\b\d{4,}\b/g, '<N>')
		// Strip JSON-embedded small numbers (1-3 digits after colon) (#92)
		.replace(/":\s*\d{1,3}([,}\]])/g, '": <N>$1')
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
