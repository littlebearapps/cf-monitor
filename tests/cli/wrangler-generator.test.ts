import { describe, it, expect } from 'vitest';
import { generateWranglerConfig } from '../../src/cli/wrangler-generator.js';

function parseConfig(raw: string): Record<string, unknown> {
	const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
	return JSON.parse(stripped);
}

describe('generateWranglerConfig', () => {
	it('generates valid JSONC with required fields', () => {
		const parsed = parseConfig(generateWranglerConfig('acc123', 'kv456', false));

		expect(parsed.name).toBe('cf-monitor');
		expect(parsed.account_id).toBe('acc123');
		expect((parsed.observability as Record<string, unknown>)?.enabled).toBe(true);
	});

	it('includes KV namespace binding with provided ID', () => {
		const parsed = parseConfig(generateWranglerConfig('acc', 'kv-id-123', false));

		const kvBindings = parsed.kv_namespaces as Array<{ binding: string; id: string }>;
		const kvBinding = kvBindings?.find((ns) => ns.binding === 'CF_MONITOR_KV');
		expect(kvBinding).toBeDefined();
		expect(kvBinding!.id).toBe('kv-id-123');
	});

	it('includes AE dataset binding', () => {
		const parsed = parseConfig(generateWranglerConfig('acc', 'kv', false));
		expect(parsed.analytics_engine_datasets).toBeDefined();
	});

	it('includes 3 cron triggers', () => {
		const parsed = parseConfig(generateWranglerConfig('acc', 'kv', false));

		const crons = (parsed.triggers as Record<string, unknown>)?.crons as string[];
		expect(crons.length).toBe(3);
		expect(crons).toContain('*/15 * * * *');
		expect(crons).toContain('0 * * * *');
		expect(crons).toContain('0 0 * * *');
	});

	it('sets CF_ACCOUNT_ID in vars', () => {
		const parsed = parseConfig(generateWranglerConfig('acc123', 'kv', false));
		expect((parsed.vars as Record<string, unknown>)?.CF_ACCOUNT_ID).toBe('acc123');
	});

	it('includes GITHUB_REPO in vars when githubRepo option provided', () => {
		const parsed = parseConfig(generateWranglerConfig('acc', 'kv', false, {
			githubRepo: 'owner/repo',
		}));
		expect((parsed.vars as Record<string, unknown>)?.GITHUB_REPO).toBe('owner/repo');
	});

	it('omits GITHUB_REPO from vars when githubRepo option not provided', () => {
		const parsed = parseConfig(generateWranglerConfig('acc', 'kv', false));
		expect((parsed.vars as Record<string, unknown>)?.GITHUB_REPO).toBeUndefined();
	});

	it('sets custom ACCOUNT_NAME when accountName option provided', () => {
		const parsed = parseConfig(generateWranglerConfig('acc', 'kv', false, {
			accountName: 'scout',
		}));
		expect((parsed.vars as Record<string, unknown>)?.ACCOUNT_NAME).toBe('scout');
	});

	it('defaults ACCOUNT_NAME to my-account when not provided', () => {
		const parsed = parseConfig(generateWranglerConfig('acc', 'kv', false));
		expect((parsed.vars as Record<string, unknown>)?.ACCOUNT_NAME).toBe('my-account');
	});

	it('includes CF_MONITOR_CONFIG in vars when configJson option provided', () => {
		const configJson = JSON.stringify({ github: { repo: 'owner/repo' } });
		const parsed = parseConfig(generateWranglerConfig('acc', 'kv', false, {
			configJson,
		}));
		expect((parsed.vars as Record<string, unknown>)?.CF_MONITOR_CONFIG).toBe(configJson);
	});

	it('omits CF_MONITOR_CONFIG from vars when configJson not provided', () => {
		const parsed = parseConfig(generateWranglerConfig('acc', 'kv', false));
		expect((parsed.vars as Record<string, unknown>)?.CF_MONITOR_CONFIG).toBeUndefined();
	});
});
