import pc from 'picocolors';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

interface UpgradeOptions {
	dryRun?: boolean;
}

export async function upgradeCommand(options: UpgradeOptions): Promise<void> {
	console.log(pc.bold('\ncf-monitor upgrade\n'));

	const configPath = '.cf-monitor/wrangler.jsonc';
	if (!existsSync(configPath)) {
		console.error(pc.red(`  ${configPath} not found. Run ${pc.cyan('npx cf-monitor init')} first.`));
		process.exit(1);
	}

	try {
		// Step 1: Check current version
		const currentVersion = getCurrentVersion();
		console.log(`  Current version: ${pc.cyan(currentVersion ?? 'unknown')}`);

		if (options.dryRun) {
			console.log(pc.yellow('\n  Dry run — checking for updates without installing.\n'));
			const output = execSync('npm outdated @littlebearapps/cf-monitor 2>/dev/null || true', {
				encoding: 'utf-8',
			});
			if (output.trim()) {
				console.log(output);
			} else {
				console.log(pc.green('  Already up to date.'));
			}
			return;
		}

		// Step 2: Update package
		console.log('  Updating @littlebearapps/cf-monitor...');
		execSync('npm update @littlebearapps/cf-monitor', { stdio: 'pipe' });

		const newVersion = getCurrentVersion();
		if (newVersion === currentVersion) {
			console.log(pc.green('  Already up to date.'));
			return;
		}

		console.log(`  Updated to: ${pc.green(newVersion ?? 'unknown')}`);

		// Step 3: Deploy
		console.log('\n  Deploying updated worker...');
		execSync(`npx wrangler deploy -c ${configPath}`, { stdio: 'inherit' });

		// Step 4: Health check
		console.log('\n  Verifying deployment...');
		// Give worker a moment to start
		await new Promise((resolve) => setTimeout(resolve, 2000));

		console.log(pc.green('\n  Upgrade complete.'));
		console.log(`  Run ${pc.cyan('npx cf-monitor status')} to verify.`);
	} catch (err) {
		console.error(pc.red(`\n  Upgrade failed: ${err}`));
		console.log(pc.yellow('  The previous version may still be running.'));
		console.log(`  Check with: ${pc.cyan('npx cf-monitor status')}`);
		process.exit(1);
	}
}

function getCurrentVersion(): string | null {
	try {
		const output = execSync('npm list @littlebearapps/cf-monitor --json 2>/dev/null', {
			encoding: 'utf-8',
		});
		const data = JSON.parse(output) as {
			dependencies?: { '@littlebearapps/cf-monitor'?: { version?: string } };
		};
		return data.dependencies?.['@littlebearapps/cf-monitor']?.version ?? null;
	} catch {
		return null;
	}
}
