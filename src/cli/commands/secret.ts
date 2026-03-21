import pc from 'picocolors';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const KNOWN_SECRETS = [
	'GITHUB_TOKEN',
	'SLACK_WEBHOOK_URL',
	'CLOUDFLARE_API_TOKEN',
	'GATUS_HEARTBEAT_URL',
	'GATUS_TOKEN',
	'GITHUB_WEBHOOK_SECRET',
];

interface SecretOptions {
	name?: string;
}

export async function secretSetCommand(name: string, _options: SecretOptions): Promise<void> {
	const configPath = '.cf-monitor/wrangler.jsonc';

	if (!existsSync(configPath)) {
		console.error(pc.red(`  ${configPath} not found. Run ${pc.cyan('npx cf-monitor init')} first.`));
		process.exit(1);
	}

	if (!name) {
		console.log(pc.bold('\ncf-monitor secret set\n'));
		console.log('  Known secrets:');
		for (const s of KNOWN_SECRETS) {
			console.log(`    ${pc.cyan(s)}`);
		}
		console.log(`\n  Usage: ${pc.cyan('npx cf-monitor secret set <NAME>')}`);
		return;
	}

	console.log(`\n  Setting secret ${pc.cyan(name)} on cf-monitor worker...\n`);

	try {
		// wrangler secret put reads from stdin interactively
		execSync(`npx wrangler secret put ${name} -c ${configPath}`, {
			stdio: 'inherit',
		});
		console.log(pc.green(`\n  Secret ${name} set successfully.`));
	} catch (err) {
		console.error(pc.red(`\n  Failed to set secret: ${err}`));
		process.exit(1);
	}
}
