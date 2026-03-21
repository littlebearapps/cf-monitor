import pc from 'picocolors';
import { readFileSync, existsSync } from 'node:fs';

interface CoverageOptions {
	json?: boolean;
}

export async function coverageCommand(options: CoverageOptions): Promise<void> {
	const workerUrl = resolveWorkerUrl();
	if (!workerUrl) {
		console.log(pc.bold('\ncf-monitor coverage\n'));
		console.log(pc.yellow('  Cannot determine worker URL.'));
		console.log(`  Ensure ${pc.cyan('.cf-monitor/wrangler.jsonc')} exists (run ${pc.cyan('npx cf-monitor init')} first).`);
		return;
	}

	try {
		// Fetch workers and status in parallel
		const [workersResp, statusResp] = await Promise.all([
			fetch(`${workerUrl}/workers`),
			fetch(`${workerUrl}/status`),
		]);

		if (!workersResp.ok || !statusResp.ok) {
			console.error(pc.red(`  Worker returned error. Ensure cf-monitor is deployed.`));
			return;
		}

		const workersData = await workersResp.json() as WorkersResponse;
		const statusData = await statusResp.json() as StatusResponse;

		if (options.json) {
			console.log(JSON.stringify({
				account: workersData.account,
				workers: workersData.workers,
				workerCount: workersData.count,
				monitorConfigured: statusData.github?.configured ?? false,
			}, null, 2));
			return;
		}

		console.log(pc.bold('\ncf-monitor coverage\n'));
		console.log(`  Account: ${pc.cyan(workersData.account)}\n`);

		const workers = workersData.workers ?? [];
		const total = workers.length;

		if (total === 0) {
			console.log(pc.yellow('  No workers discovered. Run npx cf-monitor deploy and wait for discovery cron.'));
			return;
		}

		const monitorWorker = 'cf-monitor';
		let monitored = 0;

		console.log(`  Workers (${total} total):`);
		for (const name of workers) {
			if (name === monitorWorker) {
				console.log(`    ${pc.dim('○')} ${pc.dim(name)}${pc.dim('  self  (monitoring worker)')}`);
				continue;
			}

			// For now, all discovered workers are potential monitoring targets
			// Full SDK vs tail-only detection requires AE query
			monitored++;
			console.log(`    ${pc.green('✓')} ${name}`);
		}

		const coveragePct = total > 1 ? ((monitored / (total - 1)) * 100).toFixed(0) : '0';
		console.log(`\n  Coverage: ${monitored}/${total - 1} workers (${coveragePct}%)\n`);
		console.log(pc.dim(`  Note: Full SDK vs tail-only detection requires AE telemetry query.`));
		console.log(pc.dim(`  Run with --json for machine-readable output.`));
		console.log('');
	} catch (err) {
		console.error(pc.red(`  Failed to connect to cf-monitor worker at ${workerUrl}`));
		console.error(pc.dim(`  Error: ${err}`));
		console.log(`\n  Make sure the worker is deployed: ${pc.cyan('npx cf-monitor deploy')}`);
	}
}

function resolveWorkerUrl(): string | null {
	const wranglerPath = '.cf-monitor/wrangler.jsonc';
	if (existsSync(wranglerPath)) {
		try {
			const content = readFileSync(wranglerPath, 'utf-8');
			const stripped = content.replace(/^\s*\/\/.*$/gm, '');
			const config = JSON.parse(stripped) as { name?: string; account_id?: string };
			if (config.name) {
				return `https://${config.name}.${config.account_id ?? ''}.workers.dev`;
			}
		} catch {
			// Fall through
		}
	}
	return null;
}

interface WorkersResponse {
	account: string;
	workers: string[];
	count: number;
}

interface StatusResponse {
	github?: { configured: boolean };
}
