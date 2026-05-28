import pc from 'picocolors';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createKVNamespace, getAccountPlan, listWorkers, writeKVValue } from '../cloudflare-api.js';
import { generateWranglerConfig } from '../wrangler-generator.js';
import { registerBudgetAlert, BudgetAlertError, type BudgetAlertConfig } from '../budget-alert.js';

interface InitOptions {
	accountId?: string;
	apiToken?: string;
	githubRepo?: string;
	slackWebhook?: string;
	accountName?: string;
	/** Optional opt-in: register a CF Budget Alert subscription at this user-stated $ threshold.
	 *  The actual threshold must also be set in the Cloudflare dashboard. */
	registerBudgetAlert?: string | number;
	alertEmail?: string;
	alertWebhook?: string;
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

	// Opt-in CF Budget Alert registration (Tier 2 Part F). Only fires when the flag is supplied.
	if (options.registerBudgetAlert !== undefined) {
		await maybeRegisterBudgetAlert(accountId, apiToken, kvId, options);
	}

	console.log(pc.bold('\n  Next steps:'));
	console.log('    1. Edit cf-monitor.yaml to add your Slack webhook URL');
	console.log(`    2. ${pc.cyan('npx cf-monitor deploy')}     # Deploy the monitor worker`);
	console.log(`    3. ${pc.cyan('npx cf-monitor wire')}       # Auto-wire tail_consumers on all workers`);
	console.log(`    4. ${pc.cyan('npm install @littlebearapps/cf-monitor')}  # Add SDK to your worker projects`);
	console.log('');
}

/**
 * Opt-in CF Budget Alert subscription. Only fires when `--register-budget-alert <threshold>` is set.
 * Mutation, gated. Exits 1 on any failure — no partial state persisted.
 */
async function maybeRegisterBudgetAlert(
	accountId: string,
	apiToken: string,
	kvId: string,
	options: InitOptions,
): Promise<void> {
	const raw = options.registerBudgetAlert;
	const threshold = typeof raw === 'string' ? Number(raw) : raw;
	if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) {
		console.error(pc.red('  --register-budget-alert: threshold must be a positive number (dollars/month).'));
		process.exit(1);
	}

	console.log(pc.bold('\n  Budget Alert subscription (opt-in):'));

	// Resolve recipient: webhook > email override > auto-discovered billing email.
	let recipientEmail = options.alertEmail;
	if (!options.alertWebhook && !recipientEmail) {
		recipientEmail = await fetchBillingEmail(accountId, apiToken);
		if (!recipientEmail) {
			console.error(pc.red('    Unable to auto-discover billing email — pass --alert-email <addr> or --alert-webhook <url>.'));
			process.exit(1);
		}
		console.log(`    Recipient (auto): ${pc.cyan(recipientEmail)} (from /billing/profile)`);
	} else if (options.alertWebhook) {
		console.log(`    Recipient: webhook ${pc.cyan(options.alertWebhook)}`);
	} else {
		console.log(`    Recipient: email ${pc.cyan(recipientEmail!)}`);
	}

	const cfg: BudgetAlertConfig = {
		threshold,
		recipientEmail,
		webhookUrl: options.alertWebhook,
	};

	let status;
	try {
		status = await registerBudgetAlert(accountId, apiToken, cfg);
	} catch (err) {
		if (err instanceof BudgetAlertError && err.code === 'forbidden') {
			console.error(pc.red(`    ${err.message}`));
			console.error(pc.dim('    Re-run with a token that includes Notifications Write.'));
		} else if (err instanceof BudgetAlertError) {
			console.error(pc.red(`    ${err.message}`));
		} else {
			console.error(pc.red(`    Unexpected error: ${err instanceof Error ? err.message : String(err)}`));
		}
		process.exit(1);
	}

	// Persist status blob to the worker's KV so /usage can surface it.
	try {
		await writeKVValue(accountId, apiToken, kvId, 'config:budget_alert', JSON.stringify(status));
	} catch (err) {
		console.warn(pc.yellow(`    Policy created (id=${status.policy_id}) but KV status write failed: ${err instanceof Error ? err.message : String(err)}`));
		// Don't exit 1 — the policy is real and useful; just warn.
	}

	console.log(`    ${pc.green('Subscription created.')} policy_id=${pc.dim(status.policy_id)}`);
	console.log(pc.yellow(
		`    IMPORTANT: This API only routes the alert. You MUST also set the $${threshold}/mo threshold\n` +
		`    in the Cloudflare dashboard at:\n` +
		`      ${pc.cyan(status.dashboard_threshold_url)}\n` +
		`    Cloudflare Budget Alerts are alert-only — they do not stop spend.`,
	));
}

/** Read `/billing/profile.result.billing_email` directly. Returns null on 403 or any failure. */
async function fetchBillingEmail(accountId: string, apiToken: string): Promise<string | undefined> {
	try {
		const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/billing/profile`, {
			headers: { Authorization: `Bearer ${apiToken}` },
		});
		if (!resp.ok) return undefined;
		const body = (await resp.json()) as { result?: { billing_email?: string } };
		const email = body.result?.billing_email;
		return typeof email === 'string' && email.length > 0 ? email : undefined;
	} catch {
		return undefined;
	}
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
