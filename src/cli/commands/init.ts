import pc from 'picocolors';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createKVNamespace, getAccountPlan, listWorkers } from '../cloudflare-api.js';
import { generateWranglerConfig } from '../wrangler-generator.js';

interface InitOptions {
	accountId?: string;
	apiToken?: string;
	githubRepo?: string;
	slackWebhook?: string;
	accountName?: string;
}

export async function initCommand(options: InitOptions): Promise<void> {
	console.log(pc.bold('\ncf-monitor init\n'));

	const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;

	if (!accountId) {
		console.error(pc.red('Missing --account-id or CLOUDFLARE_ACCOUNT_ID environment variable'));
		process.exit(1);
	}
	if (!apiToken) {
		console.error(pc.red('Missing --api-token or CLOUDFLARE_API_TOKEN environment variable'));
		process.exit(1);
	}

	// Detect plan
	console.log(`  Verifying API token... ${pc.green('OK')}`);
	const plan = await getAccountPlan(accountId, apiToken);
	console.log(`  Detecting account plan... ${pc.cyan(plan)}`);

	// Create KV namespace
	console.log('\n  Creating resources:');
	const kvId = await createKVNamespace(accountId, apiToken, 'cf-monitor');
	console.log(`    KV namespace (cf-monitor)... ${pc.green(kvId.slice(0, 8))}`);

	// AE datasets are auto-created on first deploy — no API provisioning needed
	console.log(`    Analytics Engine (cf-monitor)... ${pc.green('OK')} (auto-created on deploy)`);

	// Discover workers
	console.log('\n  Discovering workers:');
	const workers = await listWorkers(accountId, apiToken);
	console.log(`    Found ${pc.bold(String(workers.length))} workers on account`);
	for (const w of workers) {
		console.log(`    ${pc.green('✓')} ${w}`);
	}

	// Generate config
	const configYaml = generateConfigYaml(accountId, options.githubRepo, options.slackWebhook, options.accountName);
	writeFileSync('cf-monitor.yaml', configYaml);
	console.log(`\n  ${pc.green('Generated:')} cf-monitor.yaml`);

	// Build config JSON from init options (same data as YAML, no parsing needed)
	const configObj: Record<string, unknown> = {
		account: { name: options.accountName ?? 'my-account', cloudflare_account_id: accountId },
	};
	if (options.githubRepo) {
		configObj.github = { repo: options.githubRepo, token: '$GITHUB_TOKEN' };
	}
	if (options.slackWebhook) {
		configObj.alerts = { slack_webhook_url: options.slackWebhook };
	}

	// Generate wrangler config
	const cfMonitorDir = '.cf-monitor';
	if (!existsSync(cfMonitorDir)) mkdirSync(cfMonitorDir);
	const wranglerConfig = generateWranglerConfig(accountId, kvId, plan === 'free', {
		githubRepo: options.githubRepo,
		accountName: options.accountName,
		configJson: JSON.stringify(configObj),
	});
	writeFileSync(join(cfMonitorDir, 'wrangler.jsonc'), wranglerConfig);
	console.log(`  ${pc.green('Generated:')} .cf-monitor/wrangler.jsonc`);

	console.log(pc.bold('\n  Next steps:'));
	console.log('    1. Edit cf-monitor.yaml to add your Slack webhook URL');
	console.log(`    2. ${pc.cyan('npx cf-monitor deploy')}     # Deploy the monitor worker`);
	console.log(`    3. ${pc.cyan('npx cf-monitor wire')}       # Auto-wire tail_consumers on all workers`);
	console.log(`    4. ${pc.cyan('npm install @littlebearapps/cf-monitor')}  # Add SDK to your worker projects`);
	console.log('');
}

function generateConfigYaml(accountId: string, githubRepo?: string, slackWebhook?: string, accountName?: string): string {
	return `# cf-monitor configuration
# Docs: https://github.com/littlebearapps/cf-monitor

account:
  name: ${accountName ?? 'my-account'}  # Human-readable name for this account
  cloudflare_account_id: "${accountId}"

${githubRepo ? `github:
  repo: "${githubRepo}"
  token: $GITHUB_TOKEN  # Set via: npx cf-monitor deploy (prompts for secrets)` : `# github:
#   repo: "owner/repo"
#   token: $GITHUB_TOKEN`}

alerts:
  slack_webhook: ${slackWebhook ? `"${slackWebhook}"` : '$SLACK_WEBHOOK_URL'}

# monitoring:
#   gatus_heartbeat_url: $GATUS_HEARTBEAT_URL
#   gatus_token: $GATUS_TOKEN

# budgets:
#   daily:
#     d1_writes: 50000
#     kv_writes: 10000
#   monthly:
#     d1_writes: 1000000

# ai:
#   enabled: false
#   pattern_discovery: false
#   health_reports: false

# exclude:
#   - "test-*"
#   - "dev-*"
`;
}
