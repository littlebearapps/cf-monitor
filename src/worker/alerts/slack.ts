import { KV } from '../../constants.js';
import type { MonitorWorkerEnv } from '../../types.js';

/**
 * Send a Slack alert with deduplication.
 *
 * @param env - Monitor worker environment
 * @param dedupKey - Unique key for deduplication (combined with KV prefix)
 * @param dedupTtl - TTL in seconds for dedup window
 * @param message - Slack message payload
 */
export async function sendSlackAlert(
	env: MonitorWorkerEnv,
	dedupKey: string,
	dedupTtl: number,
	message: SlackMessage
): Promise<boolean> {
	if (!env.SLACK_WEBHOOK_URL) return false;

	// Dedup check
	const kvKey = `${KV.BUDGET_WARN}${dedupKey}`;
	const existing = await env.CF_MONITOR_KV.get(kvKey);
	if (existing) return false;

	try {
		const response = await fetch(env.SLACK_WEBHOOK_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(message),
		});

		if (response.ok) {
			// Set dedup key
			await env.CF_MONITOR_KV.put(kvKey, '1', { expirationTtl: dedupTtl });
			return true;
		}

		console.error(`[cf-monitor:slack] Alert failed (${response.status})`);
		return false;
	} catch (err) {
		console.error(`[cf-monitor:slack] Alert error: ${err}`);
		return false;
	}
}

export interface SlackMessage {
	text?: string;
	blocks?: SlackBlock[];
}

interface SlackBlock {
	type: string;
	text?: { type: string; text: string };
	fields?: Array<{ type: string; text: string }>;
}

/**
 * Format a budget warning as a Slack message.
 */
export function formatBudgetWarning(
	accountName: string,
	featureId: string,
	metric: string,
	current: number,
	limit: number,
	pct: number
): SlackMessage {
	const emoji = pct >= 90 ? ':rotating_light:' : ':warning:';

	return {
		blocks: [
			{
				type: 'header',
				text: { type: 'plain_text', text: `${emoji} Budget Warning: ${accountName}` },
			},
			{
				type: 'section',
				fields: [
					{ type: 'mrkdwn', text: `*Feature:*\n\`${featureId}\`` },
					{ type: 'mrkdwn', text: `*Metric:*\n${metric}` },
					{ type: 'mrkdwn', text: `*Usage:*\n${current.toLocaleString()} / ${limit.toLocaleString()}` },
					{ type: 'mrkdwn', text: `*Percentage:*\n${pct.toFixed(1)}%` },
				],
			},
		],
	};
}

/**
 * Format an error alert as a Slack message.
 */
export function formatErrorAlert(
	accountName: string,
	scriptName: string,
	outcome: string,
	priority: string,
	issueUrl: string | null
): SlackMessage {
	return {
		blocks: [
			{
				type: 'header',
				text: { type: 'plain_text', text: `:fire: Error: ${scriptName} (${priority})` },
			},
			{
				type: 'section',
				fields: [
					{ type: 'mrkdwn', text: `*Account:*\n${accountName}` },
					{ type: 'mrkdwn', text: `*Outcome:*\n\`${outcome}\`` },
					{ type: 'mrkdwn', text: `*Issue:*\n${issueUrl ? `<${issueUrl}|View>` : 'N/A'}` },
				],
			},
		],
	};
}
