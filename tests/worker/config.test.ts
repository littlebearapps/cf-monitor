import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../src/worker/config.js';
import { createMockMonitorWorkerEnv } from '../helpers/mock-env.js';

describe('parseConfig (#21)', () => {
	it('returns null when no config embedded', () => {
		const env = createMockMonitorWorkerEnv();
		expect(parseConfig(env)).toBeNull();
	});

	it('parses simple JSON config', () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).CF_MONITOR_CONFIG = JSON.stringify({
			github: { repo: 'owner/repo' },
		});

		const config = parseConfig(env);
		expect(config).not.toBeNull();
		expect(config?.github?.repo).toBe('owner/repo');
	});

	it('resolves $ENV_VAR references from env', () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).CF_MONITOR_CONFIG = JSON.stringify({
			github: { token: '$GITHUB_TOKEN', repo: 'owner/repo' },
			alerts: { slack_webhook_url: '$SLACK_WEBHOOK_URL' },
		});
		(env as Record<string, unknown>).GITHUB_TOKEN = 'ghp_test123';
		(env as Record<string, unknown>).SLACK_WEBHOOK_URL = 'https://hooks.slack.com/abc';

		const config = parseConfig(env);
		expect(config?.github?.token).toBe('ghp_test123');
		expect(config?.alerts?.slack_webhook_url).toBe('https://hooks.slack.com/abc');
	});

	it('leaves $REF unchanged when env var not found', () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).CF_MONITOR_CONFIG = JSON.stringify({
			github: { token: '$MISSING_VAR' },
		});

		const config = parseConfig(env);
		expect(config?.github?.token).toBe('$MISSING_VAR');
	});

	it('resolves nested objects recursively', () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).CF_MONITOR_CONFIG = JSON.stringify({
			monitoring: { exclude: ['worker-a', 'worker-b'] },
			budgets: { daily: { d1_writes: 1000 } },
		});

		const config = parseConfig(env);
		expect(config?.monitoring?.exclude).toEqual(['worker-a', 'worker-b']);
		expect(config?.budgets?.daily?.d1_writes).toBe(1000);
	});

	it('handles malformed JSON gracefully', () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).CF_MONITOR_CONFIG = 'not json';

		const config = parseConfig(env);
		expect(config).toBeNull();
	});

	it('preserves non-string values (numbers, booleans)', () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).CF_MONITOR_CONFIG = JSON.stringify({
			ai: { enabled: true, pattern_discovery: false },
			monitoring: { gap_detection_minutes: 15 },
		});

		const config = parseConfig(env);
		expect(config?.ai?.enabled).toBe(true);
		expect(config?.ai?.pattern_discovery).toBe(false);
		expect(config?.monitoring?.gap_detection_minutes).toBe(15);
	});
});
