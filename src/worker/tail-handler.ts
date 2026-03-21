import { CAPTURABLE_OUTCOMES, KV, MAX_ISSUES_PER_SCRIPT_PER_HOUR, PRIORITY_MAP } from '../constants.js';
import type { MonitorWorkerEnv, TailOutcome } from '../types.js';
import { computeFingerprint } from './errors/fingerprint.js';
import { matchTransientPattern } from './errors/patterns.js';
import { createGitHubIssue } from './errors/github.js';

/**
 * Process tail events from all tailed workers on this account.
 * Captures errors, fingerprints them, and creates GitHub issues.
 */
export async function handleTailEvents(
	events: TraceItem[],
	env: MonitorWorkerEnv,
	_ctx: ExecutionContext
): Promise<void> {
	for (const event of events) {
		try {
			await processEvent(event, env);
		} catch (err) {
			// Never let one event failure break the batch
			console.error(`[cf-monitor:tail] Error processing event from ${event.scriptName}: ${err}`);
		}
	}
}

async function processEvent(event: TraceItem, env: MonitorWorkerEnv): Promise<void> {
	const scriptName = event.scriptName ?? 'unknown';
	const outcome = event.outcome as string;

	// For ok outcomes, scan logs for soft errors and warnings (#14)
	if (outcome === 'ok') {
		await processSoftErrors(event, env, scriptName);
		return;
	}

	// Only capture error outcomes
	if (!CAPTURABLE_OUTCOMES.has(outcome)) return;

	// Extract error details
	const errorInfo = extractErrorInfo(event);
	const priority = PRIORITY_MAP[outcome] ?? 'P3';
	const fingerprint = computeFingerprint(scriptName, outcome, errorInfo.message);

	// Check if this is a transient pattern (rate-limited, timeout, etc.)
	const isTransient = matchTransientPattern(errorInfo.message, outcome);

	// Dedup: check if we already have a GitHub issue for this fingerprint
	const existingIssueUrl = await env.CF_MONITOR_KV.get(`${KV.ERR_FINGERPRINT}${fingerprint}`);
	if (existingIssueUrl) return; // Already tracked

	// Rate limit: max N issues per script per hour
	const rateLimitKey = `${KV.ERR_RATE}${scriptName}:${currentHour()}`;
	const currentRate = parseInt(await env.CF_MONITOR_KV.get(rateLimitKey) ?? '0', 10);
	if (currentRate >= MAX_ISSUES_PER_SCRIPT_PER_HOUR) return;

	// Transient dedup: one issue per category per day
	if (isTransient) {
		const transientKey = `${KV.ERR_TRANSIENT}${scriptName}:${outcome}:${currentDate()}`;
		const existing = await env.CF_MONITOR_KV.get(transientKey);
		if (existing) return;
		await env.CF_MONITOR_KV.put(transientKey, '1', { expirationTtl: 90000 }); // 25hr
	}

	// Lock to prevent duplicate issue creation
	const lockKey = `${KV.ERR_LOCK}${fingerprint}`;
	const lock = await env.CF_MONITOR_KV.get(lockKey);
	if (lock) return;
	await env.CF_MONITOR_KV.put(lockKey, '1', { expirationTtl: 60 }); // 60s

	// Create GitHub issue if configured
	if (env.GITHUB_REPO && env.GITHUB_TOKEN) {
		try {
			const issueUrl = await createGitHubIssue(env, {
				scriptName,
				outcome: outcome as TailOutcome,
				priority,
				fingerprint,
				errorMessage: errorInfo.message,
				errorName: errorInfo.name,
				isTransient,
				accountName: env.ACCOUNT_NAME,
			});

			if (issueUrl) {
				// Store fingerprint → issue URL mapping (90 day TTL)
				await env.CF_MONITOR_KV.put(`${KV.ERR_FINGERPRINT}${fingerprint}`, issueUrl, {
					expirationTtl: 7_776_000, // 90 days
				});
			}
		} catch (err) {
			console.error(`[cf-monitor:tail] Failed to create GitHub issue: ${err}`);
		}
	}

	// Increment rate counter
	await env.CF_MONITOR_KV.put(rateLimitKey, String(currentRate + 1), { expirationTtl: 7200 }); // 2hr

	// Write to AE for error tracking metrics
	try {
		env.CF_MONITOR_AE.writeDataPoint({
			blobs: [scriptName, 'error', outcome],
			doubles: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			indexes: [`${scriptName}:error:${outcome}`],
		});
	} catch {
		// AE write is best-effort
	}
}

// =============================================================================
// HELPERS
// =============================================================================

interface ErrorInfo {
	name: string;
	message: string;
}

function extractErrorInfo(event: TraceItem): ErrorInfo {
	// Look for exception in logs
	for (const log of event.logs ?? []) {
		if (log.level === 'error' && log.message.length > 0) {
			const msg = log.message.map(String).join(' ');
			return { name: 'Error', message: msg.slice(0, 500) };
		}
	}

	// Look for exceptions array
	for (const exc of event.exceptions ?? []) {
		return {
			name: exc.name ?? 'Error',
			message: (exc.message ?? 'Unknown error').slice(0, 500),
		};
	}

	return { name: event.outcome ?? 'Error', message: `Worker ${event.outcome}` };
}

/**
 * Process soft errors (console.error) and warnings (console.warn) from ok-outcome events.
 * Soft errors (P2) create individual GitHub issues.
 * Warnings (P4) are batched into a daily digest via KV.
 */
async function processSoftErrors(
	event: TraceItem,
	env: MonitorWorkerEnv,
	scriptName: string
): Promise<void> {
	const logs = event.logs ?? [];

	for (const log of logs) {
		if (log.level === 'error') {
			const msg = log.message.map(String).join(' ').slice(0, 500);
			await processLogEntry(env, scriptName, 'soft_error', msg);
		} else if (log.level === 'warn') {
			const msg = log.message.map(String).join(' ').slice(0, 500);
			await storeWarningForDigest(env, scriptName, msg);
		}
	}
}

/** Process a soft error log entry — creates a GitHub issue like hard errors. */
async function processLogEntry(
	env: MonitorWorkerEnv,
	scriptName: string,
	outcome: string,
	message: string
): Promise<void> {
	const priority = PRIORITY_MAP[outcome] ?? 'P3';
	const fingerprint = computeFingerprint(scriptName, outcome, message);
	const isTransient = matchTransientPattern(message, outcome);

	// Dedup: check existing fingerprint
	const existingUrl = await env.CF_MONITOR_KV.get(`${KV.ERR_FINGERPRINT}${fingerprint}`);
	if (existingUrl) return;

	// Rate limit
	const rateLimitKey = `${KV.ERR_RATE}${scriptName}:${currentHour()}`;
	const currentRate = parseInt(await env.CF_MONITOR_KV.get(rateLimitKey) ?? '0', 10);
	if (currentRate >= MAX_ISSUES_PER_SCRIPT_PER_HOUR) return;

	// Lock
	const lockKey = `${KV.ERR_LOCK}${fingerprint}`;
	const lock = await env.CF_MONITOR_KV.get(lockKey);
	if (lock) return;
	await env.CF_MONITOR_KV.put(lockKey, '1', { expirationTtl: 60 });

	// Create GitHub issue
	if (env.GITHUB_REPO && env.GITHUB_TOKEN) {
		try {
			const issueUrl = await createGitHubIssue(env, {
				scriptName,
				outcome: outcome as TailOutcome,
				priority,
				fingerprint,
				errorMessage: message,
				errorName: 'SoftError',
				isTransient,
				accountName: env.ACCOUNT_NAME,
			});

			if (issueUrl) {
				await env.CF_MONITOR_KV.put(`${KV.ERR_FINGERPRINT}${fingerprint}`, issueUrl, {
					expirationTtl: 7_776_000,
				});
			}
		} catch (err) {
			console.error(`[cf-monitor:tail] Failed to create soft error issue: ${err}`);
		}
	}

	await env.CF_MONITOR_KV.put(rateLimitKey, String(currentRate + 1), { expirationTtl: 7200 });

	// AE metric
	try {
		env.CF_MONITOR_AE.writeDataPoint({
			blobs: [scriptName, 'error', outcome],
			doubles: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			indexes: [`${scriptName}:error:${outcome}`],
		});
	} catch {
		// Best-effort
	}
}

/** Store a P4 warning in KV for the daily digest. */
async function storeWarningForDigest(
	env: MonitorWorkerEnv,
	scriptName: string,
	message: string
): Promise<void> {
	const today = currentDate();
	const digestKey = `${KV.WARN_DIGEST}${today}`;

	try {
		const rawDigest = await env.CF_MONITOR_KV.get(digestKey);
		const digest: WarningDigestEntry[] = rawDigest ? JSON.parse(rawDigest) : [];

		// Limit digest to 100 entries per day
		if (digest.length >= 100) return;

		// Dedup by script + message prefix within the digest
		const dedupKey = `${scriptName}:${message.slice(0, 100)}`;
		if (digest.some(e => `${e.script}:${e.message.slice(0, 100)}` === dedupKey)) return;

		digest.push({
			script: scriptName,
			message: message.slice(0, 200),
			timestamp: new Date().toISOString(),
		});

		await env.CF_MONITOR_KV.put(digestKey, JSON.stringify(digest), { expirationTtl: 172800 }); // 48hr TTL
	} catch {
		// Best-effort
	}
}

export interface WarningDigestEntry {
	script: string;
	message: string;
	timestamp: string;
}

function currentHour(): string {
	return new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

function currentDate(): string {
	return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}
