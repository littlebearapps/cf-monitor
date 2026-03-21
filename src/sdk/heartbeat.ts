/**
 * Gatus external endpoint heartbeat helper.
 *
 * Sends POST {url}?success=true|false with Bearer token.
 * Fails silently — never blocks the caller.
 */
export function pingHeartbeat(
	ctx: ExecutionContext,
	url: string | undefined,
	token: string | undefined,
	success: boolean
): void {
	if (!url || !token) return;
	ctx.waitUntil(
		fetch(`${url}?success=${success}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
		}).catch(() => {})
	);
}
