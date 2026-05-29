#!/usr/bin/env node

/**
 * cf-monitor CLI
 *
 * Commands:
 *   init      - Provision KV + AE, generate config + wrangler.jsonc
 *   deploy    - Deploy the cf-monitor worker
 *   wire      - Auto-add tail_consumers + bindings to worker configs
 *   status    - Query deployed worker for health
 *   coverage  - Show which workers are/aren't monitored
 *   upgrade   - npm update + re-deploy
 *   config    - Validate or sync configuration
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { deployCommand } from './commands/deploy.js';
import { wireCommand } from './commands/wire.js';
import { statusCommand } from './commands/status.js';
import { coverageCommand } from './commands/coverage.js';
import { secretSetCommand } from './commands/secret.js';
import { configSyncCommand } from './commands/config-sync.js';
import { upgradeCommand } from './commands/upgrade.js';
import { migrateCommand } from './commands/migrate.js';
import { usageCommand } from './commands/usage.js';
import { probeBillingCommand } from './commands/probe-billing.js';
import { probeAlertingCommand } from './commands/probe-alerting.js';
import { protectionCommand } from './commands/protection.js';

const program = new Command();

program
	.name('cf-monitor')
	.description('Self-contained Cloudflare account monitoring')
	.version('0.3.1');

program
	.command('init')
	.description('Provision resources and generate configuration')
	.option('--account-id <id>', 'Cloudflare account ID')
	.option('--api-token <token>', 'Cloudflare API token')
	.option('--github-repo <repo>', 'GitHub repo for error issues (owner/repo)')
	.option('--slack-webhook <url>', 'Slack webhook URL for alerts')
	.option('--account-name <name>', 'Human-readable account name')
	.option('--register-budget-alert <threshold>', 'Opt-in: subscribe to CF Budget Alert at $threshold/mo (alert-only)')
	.option('--alert-email <addr>', 'Recipient email for the Budget Alert (defaults to billing email)')
	.option('--alert-webhook <url>', 'Reuse-or-create webhook destination for the Budget Alert')
	.action(initCommand);

program
	.command('deploy')
	.description('Deploy the cf-monitor worker')
	.option('--dry-run', 'Show what would be deployed without deploying')
	.action(deployCommand);

program
	.command('wire')
	.description('Auto-wire tail_consumers and bindings to worker configs')
	.option('--apply', 'Apply changes (default: dry-run)')
	.option('--dir <path>', 'Directory to scan for wrangler configs', '.')
	.action(wireCommand);

program
	.command('status')
	.description('Show monitor health and account status')
	.option('--json', 'Output as JSON')
	.action(statusCommand);

program
	.command('coverage')
	.description('Show monitoring coverage for account workers')
	.option('--json', 'Output as JSON')
	.action(coverageCommand);

program
	.command('secret')
	.description('Set a secret on the cf-monitor worker')
	.argument('[name]', 'Secret name (e.g. GITHUB_TOKEN)')
	.action(secretSetCommand);

const configCmd = program
	.command('config')
	.description('Configuration management');

configCmd
	.command('sync')
	.description('Push budgets from cf-monitor.yaml to KV')
	.action(() => configSyncCommand({}));

configCmd
	.command('validate')
	.description('Validate cf-monitor.yaml against schema')
	.action(() => configSyncCommand({ validate: true }));

program
	.command('usage')
	.description('Show account-wide CF service usage vs plan allowances')
	.option('--json', 'Output as JSON')
	.option('--detail', 'Include per-gateway/provider/model AI Gateway breakdown')
	.option('--admin-token <token>', 'Admin token if the worker has CF_MONITOR_REQUIRE_AUTH_FOR_READS=true (default: $CF_MONITOR_ADMIN_TOKEN)')
	.action(usageCommand);

program
	.command('protection')
	.description('Show the protection coverage report (audit-only — heuristic score 0-100)')
	.option('--json', 'Output as JSON')
	.option('--admin-token <token>', 'Admin token (default: $CF_MONITOR_ADMIN_TOKEN). /protection is always auth-required.')
	.action(protectionCommand);

const probeCmd = program
	.command('probe')
	.description('Read-only diagnostic probes against the Cloudflare API');

probeCmd
	.command('billing')
	.description('Probe the billing endpoints (read-only; saves redacted output)')
	.option('--account-id <id>', 'Cloudflare account ID (default: $CLOUDFLARE_ACCOUNT_ID)')
	.option('--token <token>', 'Cloudflare API token (default: $CLOUDFLARE_API_TOKEN)')
	.option('--out <dir>', 'Output directory for the redacted probe JSON', 'docs/research/probes')
	.action(probeBillingCommand);

probeCmd
	.command('alerting')
	.description('Probe the Notifications/Alerting endpoints (read-only; saves redacted output)')
	.option('--account-id <id>', 'Cloudflare account ID (default: $CLOUDFLARE_ACCOUNT_ID)')
	.option('--token <token>', 'Cloudflare API token (default: $CLOUDFLARE_API_TOKEN)')
	.option('--out <dir>', 'Output directory for the redacted probe JSON', 'docs/research/probes')
	.action(probeAlertingCommand);

program
	.command('upgrade')
	.description('Update cf-monitor and re-deploy')
	.option('--dry-run', 'Show what would change without upgrading')
	.action(upgradeCommand);

program
	.command('migrate')
	.description('Migrate from platform-consumer-sdk')
	.option('--from <source>', 'Migration source', 'platform-sdk')
	.action(migrateCommand);

program.parse();
