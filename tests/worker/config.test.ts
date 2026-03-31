import { describe, it, expect } from 'vitest';
import { parseConfig, enrichEnv } from '../../src/worker/config.js';
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

describe('enrichEnv (#87)', () => {
	it('returns env unchanged when no CF_MONITOR_CONFIG', () => {
		const env = createMockMonitorWorkerEnv();
		const result = enrichEnv(env);
		expect(result).toBe(env); // Same reference — no config to enrich
	});

	it('sets GITHUB_REPO from config when env.GITHUB_REPO is undefined', () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).CF_MONITOR_CONFIG = JSON.stringify({
			github: { repo: 'owner/repo' },
		});

		const result = enrichEnv(env);
		expect(result.GITHUB_REPO).toBe('owner/repo');
	});

	it('does not override existing env.GITHUB_REPO', () => {
		const env = createMockMonitorWorkerEnv();
		env.GITHUB_REPO = 'existing/repo';
		(env as Record<string, unknown>).CF_MONITOR_CONFIG = JSON.stringify({
			github: { repo: 'config/repo' },
		});

		const result = enrichEnv(env);
		expect(result.GITHUB_REPO).toBe('existing/repo');
	});

	it('skips unresolved $REFERENCES', () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).CF_MONITOR_CONFIG = JSON.stringify({
			github: { token: '$GITHUB_TOKEN', repo: 'owner/repo' },
		});
		// GITHUB_TOKEN is NOT set in env

		const result = enrichEnv(env);
		expect(result.GITHUB_REPO).toBe('owner/repo');
		expect(result.GITHUB_TOKEN).toBeUndefined(); // $GITHUB_TOKEN not written
	});

	it('resolves $GITHUB_TOKEN when secret is available', () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).GITHUB_TOKEN = 'ghp_actual_secret';
		(env as Record<string, unknown>).CF_MONITOR_CONFIG = JSON.stringify({
			github: { token: '$GITHUB_TOKEN', repo: 'owner/repo' },
		});

		const result = enrichEnv(env);
		// GITHUB_TOKEN was already set in env, so env value wins
		expect(result.GITHUB_TOKEN).toBe('ghp_actual_secret');
	});

	it('maps all config fields correctly', () => {
		const env = createMockMonitorWorkerEnv();
		// Clear ACCOUNT_NAME so config can fill it
		(env as Record<string, unknown>).ACCOUNT_NAME = undefined;
		(env as Record<string, unknown>).CF_MONITOR_CONFIG = JSON.stringify({
			account: { name: 'scout' },
			github: { repo: 'owner/repo', webhook_secret: 'whsec_123' },
			alerts: { slack_webhook_url: 'https://hooks.slack.com/abc' },
			monitoring: { heartbeat_url: 'https://gatus.example.com', heartbeat_token: 'tok_123' },
		});

		const result = enrichEnv(env);
		expect(result.ACCOUNT_NAME).toBe('scout');
		expect(result.GITHUB_REPO).toBe('owner/repo');
		expect(result.GITHUB_WEBHOOK_SECRET).toBe('whsec_123');
		expect(result.SLACK_WEBHOOK_URL).toBe('https://hooks.slack.com/abc');
		expect(result.GATUS_HEARTBEAT_URL).toBe('https://gatus.example.com');
		expect(result.GATUS_TOKEN).toBe('tok_123');
	});

	it('preserves CF_MONITOR_KV binding reference', () => {
		const env = createMockMonitorWorkerEnv();
		const kvRef = env.CF_MONITOR_KV;
		(env as Record<string, unknown>).CF_MONITOR_CONFIG = JSON.stringify({
			github: { repo: 'owner/repo' },
		});

		const result = enrichEnv(env);
		expect(result.CF_MONITOR_KV).toBe(kvRef); // Same reference
	});

	it('does not set empty string values', () => {
		const env = createMockMonitorWorkerEnv();
		(env as Record<string, unknown>).CF_MONITOR_CONFIG = JSON.stringify({
			github: { repo: '', token: '' },
		});

		const result = enrichEnv(env);
		expect(result.GITHUB_REPO).toBeUndefined();
		expect(result.GITHUB_TOKEN).toBeUndefined();
	});
});
