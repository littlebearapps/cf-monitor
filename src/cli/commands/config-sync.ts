import pc from 'picocolors';
import { readFileSync, existsSync } from 'node:fs';

interface ConfigSyncOptions {
	validate?: boolean;
}

export async function configSyncCommand(options: ConfigSyncOptions): Promise<void> {
	const configPath = 'cf-monitor.yaml';

	if (!existsSync(configPath)) {
		console.error(pc.red(`  ${configPath} not found. Run ${pc.cyan('npx cf-monitor init')} first.`));
		process.exit(1);
	}

	if (options.validate) {
		await validateConfig(configPath);
		return;
	}

	await syncConfig(configPath);
}

async function validateConfig(configPath: string): Promise<void> {
	console.log(pc.bold('\ncf-monitor config validate\n'));

	try {
		const content = readFileSync(configPath, 'utf-8');

		// Basic YAML structure checks (without full YAML parser)
		const issues: string[] = [];

		if (!content.includes('account:')) {
			issues.push('Missing required section: account');
		}
		if (!content.includes('name:')) {
			issues.push('Missing required field: account.name');
		}
		if (!content.includes('cloudflare_account_id:')) {
			issues.push('Missing required field: account.cloudflare_account_id');
		}

		// Check for $ENV_VAR references
		const envVarRefs = content.match(/\$[A-Z_][A-Z0-9_]*/g) ?? [];
		if (envVarRefs.length > 0) {
			console.log(`  ${pc.cyan('ENV_VAR references found:')}`);
			for (const ref of [...new Set(envVarRefs)]) {
				const resolved = process.env[ref.slice(1)];
				const status = resolved ? pc.green('set') : pc.yellow('not set');
				console.log(`    ${ref} — ${status}`);
			}
			console.log('');
		}

		if (issues.length > 0) {
			for (const issue of issues) {
				console.log(`  ${pc.red('✗')} ${issue}`);
			}
			process.exit(1);
		}

		console.log(`  ${pc.green('✓')} Config is valid`);
	} catch (err) {
		console.error(pc.red(`  Failed to read config: ${err}`));
		process.exit(1);
	}
}

async function syncConfig(configPath: string): Promise<void> {
	console.log(pc.bold('\ncf-monitor config sync\n'));

	const apiToken = process.env.CLOUDFLARE_API_TOKEN;
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

	if (!apiToken || !accountId) {
		console.error(pc.red('  CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set'));
		process.exit(1);
	}

	try {
		const content = readFileSync(configPath, 'utf-8');

		// Extract budget values from YAML (simple key: value parsing)
		const dailyBudgets = extractBudgets(content, 'daily');
		const monthlyBudgets = extractBudgets(content, 'monthly');

		// Read wrangler config for KV namespace ID
		const wranglerPath = '.cf-monitor/wrangler.jsonc';
		if (!existsSync(wranglerPath)) {
			console.error(pc.red(`  ${wranglerPath} not found. Run ${pc.cyan('npx cf-monitor init')} first.`));
			process.exit(1);
		}

		const wranglerContent = readFileSync(wranglerPath, 'utf-8');
		const stripped = wranglerContent.replace(/^\s*\/\/.*$/gm, '');
		const wranglerConfig = JSON.parse(stripped) as {
			kv_namespaces?: Array<{ id: string; binding: string }>;
		};

		const kvNamespaceId = wranglerConfig.kv_namespaces?.find(
			(ns) => ns.binding === 'CF_MONITOR_KV'
		)?.id;

		if (!kvNamespaceId) {
			console.error(pc.red('  CF_MONITOR_KV namespace ID not found in wrangler config'));
			process.exit(1);
		}

		let writtenCount = 0;

		// Write daily budgets
		for (const [feature, limits] of Object.entries(dailyBudgets)) {
			const key = `budget:config:${feature}`;
			await writeKV(accountId, apiToken, kvNamespaceId, key, JSON.stringify(limits));
			console.log(`  ${pc.green('✓')} ${key}`);
			writtenCount++;
		}

		// Write monthly budgets
		for (const [feature, limits] of Object.entries(monthlyBudgets)) {
			const key = `budget:config:monthly:${feature}`;
			await writeKV(accountId, apiToken, kvNamespaceId, key, JSON.stringify(limits));
			console.log(`  ${pc.green('✓')} ${key}`);
			writtenCount++;
		}

		console.log(`\n  Synced ${writtenCount} budget config(s) to KV.`);
	} catch (err) {
		console.error(pc.red(`  Sync failed: ${err}`));
		process.exit(1);
	}
}

/** Simple YAML budget extraction (key: value under daily/monthly section). */
function extractBudgets(
	yamlContent: string,
	section: 'daily' | 'monthly'
): Record<string, Record<string, number>> {
	const result: Record<string, Record<string, number>> = {};
	const lines = yamlContent.split('\n');

	let inBudgets = false;
	let inSection = false;
	let currentFeature = '';

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed === 'budgets:') {
			inBudgets = true;
			continue;
		}

		if (inBudgets && trimmed === `${section}:`) {
			inSection = true;
			continue;
		}

		if (inSection) {
			// End of section (new top-level key or less indented)
			if (!line.startsWith('      ') && !line.startsWith('\t\t\t') && trimmed.length > 0 && !trimmed.startsWith('#')) {
				if (!line.startsWith('    ') && !line.startsWith('\t\t')) break;
			}

			const metricMatch = trimmed.match(/^(\w+):\s*(\d[\d_]*)/);
			if (metricMatch) {
				const metric = metricMatch[1];
				const value = parseInt(metricMatch[2].replace(/_/g, ''), 10);
				if (!currentFeature) currentFeature = '__default__';
				if (!result[currentFeature]) result[currentFeature] = {};
				result[currentFeature][metric] = value;
			}
		}
	}

	return result;
}

/** Write a key-value pair to a KV namespace via CF API. */
async function writeKV(
	accountId: string,
	apiToken: string,
	namespaceId: string,
	key: string,
	value: string
): Promise<void> {
	const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;

	const response = await fetch(url, {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${apiToken}`,
			'Content-Type': 'text/plain',
		},
		body: value,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`KV write failed for ${key}: ${response.status} ${text}`);
	}
}
