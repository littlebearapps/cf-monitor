import pc from 'picocolors';
import { readFileSync, existsSync } from 'node:fs';

interface StatusOptions {
	json?: boolean;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
	const workerUrl = resolveWorkerUrl();
	if (!workerUrl) {
		console.log(pc.bold('\ncf-monitor status\n'));
		console.log(pc.yellow('  Cannot determine worker URL.'));
		console.log(`  Ensure ${pc.cyan('.cf-monitor/wrangler.jsonc')} exists (run ${pc.cyan('npx cf-monitor init')} first).`);
		return;
	}

	try {
		const response = await fetch(`${workerUrl}/status`);
		if (!response.ok) {
			console.error(pc.red(`  Worker returned ${response.status}: ${response.statusText}`));
			return;
		}

		const status = await response.json() as StatusResponse;

		if (options.json) {
			console.log(JSON.stringify(status, null, 2));
			return;
		}

		// Formatted output
		console.log(pc.bold('\ncf-monitor status\n'));

		const healthIcon = status.healthy ? pc.green('healthy') : pc.red('unhealthy');
		console.log(`  Account: ${pc.cyan(status.account)} (${healthIcon})`);
		console.log(`  Account ID: ${status.accountId}`);
		if (status.plan) {
			const planLabel = status.plan === 'paid' ? pc.green('Workers Paid') : pc.yellow('Workers Free');
			console.log(`  Plan: ${planLabel}`);
		}
		if (status.billingPeriod) {
			const start = status.billingPeriod.start.slice(0, 10);
			const end = status.billingPeriod.end.slice(0, 10);
			const daysLeft = Math.max(0, Math.ceil((new Date(status.billingPeriod.end).getTime() - Date.now()) / 86_400_000));
			console.log(`  Billing period: ${start} to ${end} (${daysLeft} days remaining)`);
		}
		console.log('');

		// Circuit breakers
		const cbGlobal = status.circuitBreaker?.global === 'active' ? pc.red('ACTIVE') : pc.green('inactive');
		const cbAccount = status.circuitBreaker?.account === 'paused' ? pc.red('PAUSED') : pc.green('active');
		console.log(`  Circuit breakers:`);
		console.log(`    Global: ${cbGlobal}`);
		console.log(`    Account: ${cbAccount}`);
		console.log('');

		// Workers
		const workerCount = status.workers?.count ?? 0;
		console.log(`  Workers: ${workerCount} monitored`);
		if (status.workers?.names?.length) {
			for (const name of status.workers.names) {
				console.log(`    - ${name}`);
			}
		}
		console.log('');

		// Integrations
		const ghStatus = status.github?.configured ? pc.green('configured') : pc.dim('not configured');
		const slackStatus = status.slack?.configured ? pc.green('configured') : pc.dim('not configured');
		console.log(`  GitHub: ${ghStatus}${status.github?.repo ? ` (${status.github.repo})` : ''}`);
		console.log(`  Slack:  ${slackStatus}`);
		console.log('');
	} catch (err) {
		console.error(pc.red(`  Failed to connect to cf-monitor worker at ${workerUrl}`));
		console.error(pc.dim(`  Error: ${err}`));
		console.log(`\n  Make sure the worker is deployed: ${pc.cyan('npx cf-monitor deploy')}`);
	}
}

/** Resolve the worker URL from .cf-monitor/wrangler.jsonc or cf-monitor.yaml. */
function resolveWorkerUrl(): string | null {
	// Try reading the wrangler config for the worker name + account
	const wranglerPath = '.cf-monitor/wrangler.jsonc';
	if (existsSync(wranglerPath)) {
		try {
			const content = readFileSync(wranglerPath, 'utf-8');
			// Strip JSON comments (simple: remove // lines)
			const stripped = content.replace(/^\s*\/\/.*$/gm, '');
			const config = JSON.parse(stripped) as { name?: string; account_id?: string };
			if (config.name) {
				return `https://${config.name}.${config.account_id ?? ''}.workers.dev`;
			}
		} catch {
			// Fall through
		}
	}

	// Fallback: try CLOUDFLARE_API_TOKEN to query for the worker
	return null;
}

interface StatusResponse {
	account: string;
	accountId: string;
	plan?: string;
	healthy: boolean;
	circuitBreaker?: {
		global: string;
		account: string;
	};
	workers?: {
		count: number;
		names: string[];
	};
	billingPeriod?: {
		start: string;
		end: string;
		dayOfMonth: number;
	};
	github?: {
		configured: boolean;
		repo?: string;
	};
	slack?: {
		configured: boolean;
	};
	timestamp: number;
}
