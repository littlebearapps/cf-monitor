import { describe, it, expect } from 'vitest';
import { parseYamlConfig } from '../../src/cli/yaml-parser.js';

describe('parseYamlConfig', () => {
	it('parses minimal config (account only)', () => {
		const yaml = `
account:
  name: scout
  cloudflare_account_id: "abc123"
`;
		const result = JSON.parse(parseYamlConfig(yaml));
		expect(result.account.name).toBe('scout');
		expect(result.account.cloudflare_account_id).toBe('abc123');
	});

	it('parses full config with all sections', () => {
		const yaml = `
account:
  name: platform
  cloudflare_account_id: "55a0bf6d"

github:
  repo: "littlebearapps/platform"
  token: $GITHUB_TOKEN
  webhook_secret: $GITHUB_WEBHOOK_SECRET

alerts:
  slack_webhook_url: $SLACK_WEBHOOK_URL

monitoring:
  heartbeat_url: $GATUS_HEARTBEAT_URL
  heartbeat_token: $GATUS_TOKEN
  gap_detection_minutes: 15

ai:
  enabled: false
  pattern_discovery: true
`;
		const result = JSON.parse(parseYamlConfig(yaml));
		expect(result.account.name).toBe('platform');
		expect(result.github.repo).toBe('littlebearapps/platform');
		expect(result.github.token).toBe('$GITHUB_TOKEN');
		expect(result.alerts.slack_webhook_url).toBe('$SLACK_WEBHOOK_URL');
		expect(result.monitoring.gap_detection_minutes).toBe(15);
		expect(result.ai.enabled).toBe(false);
		expect(result.ai.pattern_discovery).toBe(true);
	});

	it('preserves $ENV_VAR references as-is', () => {
		const yaml = `
github:
  token: $GITHUB_TOKEN
  repo: "owner/repo"
`;
		const result = JSON.parse(parseYamlConfig(yaml));
		expect(result.github.token).toBe('$GITHUB_TOKEN');
		expect(result.github.repo).toBe('owner/repo');
	});

	it('handles comments and blank lines', () => {
		const yaml = `
# This is a comment
account:
  name: test  # inline comment

# github:
#   repo: "commented-out"

alerts:
  slack_webhook_url: $SLACK_WEBHOOK_URL
`;
		const result = JSON.parse(parseYamlConfig(yaml));
		expect(result.account.name).toBe('test');
		expect(result.github).toBeUndefined();
		expect(result.alerts.slack_webhook_url).toBe('$SLACK_WEBHOOK_URL');
	});

	it('parses budgets with nested daily/monthly', () => {
		const yaml = `
budgets:
  daily:
    d1_writes: 50000
    kv_writes: 10_000
  monthly:
    d1_writes: 1_000_000
`;
		const result = JSON.parse(parseYamlConfig(yaml));
		expect(result.budgets.daily.d1_writes).toBe(50000);
		expect(result.budgets.daily.kv_writes).toBe(10000);
		expect(result.budgets.monthly.d1_writes).toBe(1000000);
	});

	it('parses numbers and booleans correctly', () => {
		const yaml = `
monitoring:
  gap_detection_minutes: 15
  spike_threshold: 2.5

ai:
  enabled: true
  pattern_discovery: false
`;
		const result = JSON.parse(parseYamlConfig(yaml));
		expect(result.monitoring.gap_detection_minutes).toBe(15);
		expect(result.monitoring.spike_threshold).toBe(2.5);
		expect(result.ai.enabled).toBe(true);
		expect(result.ai.pattern_discovery).toBe(false);
	});
});
