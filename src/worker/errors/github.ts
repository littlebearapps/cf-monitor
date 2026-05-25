import type { MonitorWorkerEnv, TailOutcome } from '../../types.js';

export interface LogEntry {
	level: string;
	message: string;
	timestamp: number;
}

export interface ErrorIssueParams {
	scriptName: string;
	outcome: TailOutcome;
	priority: string;
	fingerprint: string;
	errorMessage: string;
	errorName: string;
	isTransient: boolean;
	accountName: string;
	/** Override the issue body (e.g. for digest issues). */
	bodyOverride?: string;

	// Enriched context from TraceItem
	cpuTimeMs?: number;
	wallTimeMs?: number;
	eventTimestamp?: number;
	executionModel?: string;
	truncated?: boolean;
	stackTrace?: string;
	eventType?: string;
	requestUrl?: string;
	requestMethod?: string;
	responseStatus?: number;
	cronExpression?: string;
	queueName?: string;
	queueBatchSize?: number;
	durableObjectId?: string;
	logHistory?: LogEntry[];
	cfAccountId?: string;
}

/**
 * Create a GitHub issue for a captured error.
 * Uses a Personal Access Token (simpler than GitHub App).
 *
 * @returns The issue URL, or null if creation failed.
 */
export async function createGitHubIssue(
	env: MonitorWorkerEnv,
	params: ErrorIssueParams
): Promise<string | null> {
	if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return null;

	const labels = [
		`cf:error:${params.outcome}`,
		`cf:priority:${params.priority.toLowerCase()}`,
	];
	if (params.isTransient) labels.push('cf:transient');
	if (params.bodyOverride) labels.push('cf:digest');

	const title = `[${params.priority}] ${params.scriptName}: ${params.outcome}`;
	const body = params.bodyOverride ?? formatIssueBody(params);

	try {
		const response = await fetch(
			`https://api.github.com/repos/${env.GITHUB_REPO}/issues`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${env.GITHUB_TOKEN}`,
					Accept: 'application/vnd.github+json',
					'Content-Type': 'application/json',
					'User-Agent': 'cf-monitor',
					'X-GitHub-Api-Version': '2022-11-28',
				},
				body: JSON.stringify({ title, body, labels }),
			}
		);

		if (!response.ok) {
			const text = await response.text();
			console.error(`[cf-monitor:github] Issue creation failed (${response.status}): ${text}`);
			return null;
		}

		const issue = await response.json() as { html_url: string };
		return issue.html_url;
	} catch (err) {
		console.error(`[cf-monitor:github] Issue creation error: ${err}`);
		return null;
	}
}

/** Escape markdown-active characters for safe interpolation in table cells. */
function escapeMd(s: string): string {
	return s.replace(/[|`\[\]()!*_~<>\\]/g, '\\$&');
}

function formatIssueBody(params: ErrorIssueParams): string {
	const sections: string[] = [];

	// Error section — try to present JSON messages readably
	const displayMessage = tryFormatJsonMessage(params.errorMessage);
	sections.push(`### Error\n\n\`\`\`\n${params.errorName}: ${displayMessage}\n\`\`\``);

	// Stack trace (if available, capped at 2000 chars)
	if (params.stackTrace) {
		const stack = params.stackTrace.slice(0, 2000);
		const truncNote = params.stackTrace.length > 2000 ? '\n... (truncated)' : '';
		sections.push(`### Stack Trace\n\n\`\`\`\n${stack}${truncNote}\n\`\`\``);
	}

	// Details table
	const rows: Array<[string, string]> = [
		['**Worker**', `\`${escapeMd(params.scriptName)}\``],
	];

	if (params.eventType) {
		rows.push(['**Event**', formatEventType(params)]);
	}

	rows.push(['**Outcome**', escapeMd(params.outcome)]);
	rows.push(['**Priority**', escapeMd(params.priority)]);

	if (params.cpuTimeMs !== undefined || params.wallTimeMs !== undefined) {
		const cpu = params.cpuTimeMs !== undefined ? `${params.cpuTimeMs}ms` : '—';
		const wall = params.wallTimeMs !== undefined ? `${params.wallTimeMs}ms` : '—';
		rows.push(['**CPU / Wall**', `${cpu} / ${wall}`]);
	}

	if (params.executionModel) {
		rows.push(['**Execution**', escapeMd(params.executionModel)]);
	}

	rows.push(['**Account**', escapeMd(params.accountName)]);
	rows.push(['**Fingerprint**', `\`${escapeMd(params.fingerprint)}\``]);

	const eventTime = params.eventTimestamp
		? new Date(params.eventTimestamp).toISOString()
		: new Date().toISOString();
	rows.push(['**Event Time**', eventTime]);
	rows.push(['**Transient**', params.isTransient ? 'Yes' : 'No']);

	if (params.requestUrl) {
		rows.push(['**Request**', `\`${escapeMd(params.requestMethod ?? 'GET')} ${escapeMd(params.requestUrl)}\``]);
	}
	if (params.responseStatus !== undefined) {
		rows.push(['**Response**', `HTTP ${params.responseStatus}`]);
	}
	if (params.durableObjectId) {
		rows.push(['**DO ID**', `\`${escapeMd(params.durableObjectId)}\``]);
	}

	const table = rows.map(([field, value]) => `| ${field} | ${value} |`).join('\n');
	sections.push(`### Details\n\n| Field | Value |\n|-------|-------|\n${table}`);

	// Log history table (last N entries)
	if (params.logHistory && params.logHistory.length > 0) {
		sections.push(formatLogTable(params.logHistory, params.eventTimestamp));
	}

	// Truncation warning
	if (params.truncated) {
		sections.push('> **Warning**: Logs were truncated by Cloudflare (exceeded 256KB limit). Some context may be missing.');
	}

	// Transient note
	if (params.isTransient) {
		sections.push('> This error matches a transient pattern. It may resolve on its own.');
	}

	// Investigation links
	if (params.cfAccountId) {
		sections.push(formatDashboardLinks(params.cfAccountId, params.scriptName));
	}

	sections.push('---\n*Generated by [cf-monitor](https://github.com/littlebearapps/cf-monitor)*');

	return sections.join('\n\n');
}

function formatEventType(params: ErrorIssueParams): string {
	switch (params.eventType) {
		case 'fetch':
			return 'Fetch';
		case 'scheduled':
			return params.cronExpression ? `Scheduled (\`${params.cronExpression}\`)` : 'Scheduled';
		case 'queue':
			return params.queueName
				? `Queue (\`${escapeMd(params.queueName)}\`${params.queueBatchSize ? `, batch: ${params.queueBatchSize}` : ''})`
				: 'Queue';
		case 'alarm':
			return 'DO Alarm';
		case 'rpc':
			return 'RPC';
		case 'websocket':
			return 'WebSocket';
		case 'email':
			return 'Email';
		default:
			return escapeMd(params.eventType ?? 'unknown');
	}
}

function formatLogTable(logs: LogEntry[], eventTimestamp?: number): string {
	const baseTime = eventTimestamp ?? logs[0]?.timestamp ?? Date.now();
	const header = '### Logs\n\n| Time | Level | Message |\n|------|-------|---------|\n';
	const rows = logs.map((log) => {
		const relativeMs = log.timestamp - baseTime;
		const sign = relativeMs >= 0 ? '+' : '';
		const timeStr = `${sign}${relativeMs}ms`;
		const level = log.level;
		const msg = escapeMd(log.message.slice(0, 300));
		return `| ${timeStr} | ${level} | ${msg} |`;
	});
	return header + rows.join('\n');
}

function formatDashboardLinks(accountId: string, scriptName: string): string {
	const base = `https://dash.cloudflare.com/${accountId}`;
	return `### Investigation\n\n- [Worker Dashboard](${base}/workers/services/view/${scriptName}/production)\n- [Workers Observability](${base}/workers/observability)`;
}

function tryFormatJsonMessage(message: string): string {
	if (!message.startsWith('{')) return message;
	try {
		const parsed = JSON.parse(message);
		// Extract the most useful fields from structured logs
		const parts: string[] = [];
		if (parsed.message) parts.push(parsed.message);
		if (parsed.error?.message) parts.push(parsed.error.message);
		if (parsed.context) parts.push(`Context: ${JSON.stringify(parsed.context)}`);
		if (parsed.status) parts.push(`Status: ${parsed.status}`);
		if (parts.length > 0) return parts.join('\n');
	} catch {
		// Not valid JSON
	}
	return message;
}
