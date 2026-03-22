import pc from 'picocolors';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

interface DeployOptions {
	dryRun?: boolean;
}

export async function deployCommand(options: DeployOptions): Promise<void> {
	console.log(pc.bold('\ncf-monitor deploy\n'));

	const wranglerConfig = '.cf-monitor/wrangler.jsonc';

	if (!existsSync(wranglerConfig)) {
		console.error(pc.red('No .cf-monitor/wrangler.jsonc found. Run: npx cf-monitor init'));
		process.exit(1);
	}

	if (options.dryRun) {
		console.log(`  ${pc.yellow('Dry run')} — would deploy using ${wranglerConfig}`);
		return;
	}

	console.log('  Deploying cf-monitor worker...');

	try {
		const output = execFileSync('npx', ['wrangler', 'deploy', '-c', wranglerConfig], {
			encoding: 'utf-8',
			stdio: ['inherit', 'pipe', 'pipe'],
		});
		console.log(output);
		console.log(`  ${pc.green('✓')} cf-monitor worker deployed successfully`);
	} catch (err) {
		console.error(pc.red('\n  Deploy failed:'));
		console.error(err);
		process.exit(1);
	}

	console.log(`\n  Next: ${pc.cyan('npx cf-monitor wire --apply')} to auto-wire tail_consumers`);
}
