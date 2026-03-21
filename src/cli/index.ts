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

const program = new Command();

program
	.name('cf-monitor')
	.description('Self-contained Cloudflare account monitoring')
	.version('0.1.0');

program
	.command('init')
	.description('Provision resources and generate configuration')
	.option('--account-id <id>', 'Cloudflare account ID')
	.option('--api-token <token>', 'Cloudflare API token')
	.option('--github-repo <repo>', 'GitHub repo for error issues (owner/repo)')
	.option('--slack-webhook <url>', 'Slack webhook URL for alerts')
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

program.parse();
