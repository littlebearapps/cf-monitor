import pc from 'picocolors';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface WireOptions {
	apply?: boolean;
	dir?: string;
}

export async function wireCommand(options: WireOptions): Promise<void> {
	const dir = options.dir ?? '.';
	const apply = options.apply ?? false;

	console.log(pc.bold('\ncf-monitor wire\n'));
	console.log(`  Scanning ${dir} for wrangler configs...\n`);

	const configs = findWranglerConfigs(dir);

	if (configs.length === 0) {
		console.log(pc.yellow('  No wrangler.*.jsonc files found.'));
		return;
	}

	let modified = 0;
	let skipped = 0;

	for (const configPath of configs) {
		const result = processConfig(configPath, apply);
		if (result === 'modified') {
			modified++;
			console.log(`    ${pc.green('✓')} ${configPath} ${apply ? '(updated)' : '(would update)'}`);
		} else if (result === 'skipped') {
			skipped++;
			console.log(`    ${pc.dim('○')} ${configPath} (already wired)`);
		} else {
			console.log(`    ${pc.dim('○')} ${configPath} (cf-monitor, skipped)`);
		}
	}

	console.log(`\n  ${modified} config(s) ${apply ? 'updated' : 'would be updated'}, ${skipped} already wired.`);

	if (modified > 0 && !apply) {
		console.log(`\n  Run ${pc.cyan('npx cf-monitor wire --apply')} to apply changes.`);
	} else if (modified > 0 && apply) {
		console.log(`\n  Redeploy updated workers for changes to take effect.`);
	}
}

function findWranglerConfigs(dir: string): string[] {
	try {
		const files = readdirSync(dir);
		return files
			.filter((f) => f.match(/^wrangler.*\.jsonc?$/))
			.map((f) => join(dir, f));
	} catch {
		return [];
	}
}

type ProcessResult = 'modified' | 'skipped' | 'self';

function processConfig(configPath: string, apply: boolean): ProcessResult {
	const raw = readFileSync(configPath, 'utf-8');

	// Strip JSONC comments for parsing
	const stripped = stripJsoncComments(raw);

	let config: Record<string, unknown>;
	try {
		config = JSON.parse(stripped);
	} catch {
		console.warn(`    ${pc.yellow('⚠')} ${configPath}: invalid JSON, skipping`);
		return 'skipped';
	}

	// Skip cf-monitor's own config
	if (config.name === 'cf-monitor') return 'self';

	// Check if already wired
	const tailConsumers = (config.tail_consumers as Array<{ service: string }>) ?? [];
	const hasMonitorTail = tailConsumers.some((tc) => tc.service === 'cf-monitor');

	const kvNamespaces = (config.kv_namespaces as Array<{ binding: string }>) ?? [];
	const hasMonitorKV = kvNamespaces.some((ns) => ns.binding === 'CF_MONITOR_KV');

	const aeDatasets = (config.analytics_engine_datasets as Array<{ binding: string }>) ?? [];
	const hasMonitorAE = aeDatasets.some((ds) => ds.binding === 'CF_MONITOR_AE');

	// Check if WORKER_NAME is set in vars
	const vars = (config.vars as Record<string, string>) ?? {};
	const hasWorkerName = typeof vars.WORKER_NAME === 'string' && vars.WORKER_NAME.length > 0;
	const workerName = config.name as string | undefined;

	if (hasMonitorTail && hasMonitorKV && hasMonitorAE && hasWorkerName) return 'skipped';

	if (!apply) return 'modified';

	// Apply changes to raw JSONC (preserve comments and formatting)
	let modified = raw;

	if (!hasMonitorTail) {
		modified = addJsoncProperty(modified, 'tail_consumers', [{ service: 'cf-monitor' }], tailConsumers);
	}

	// Inject WORKER_NAME into vars if missing (reads `name` from wrangler config)
	if (!hasWorkerName && workerName) {
		modified = addJsoncVarsEntry(modified, 'WORKER_NAME', workerName);
		console.log(`    ${pc.cyan('+')} Added WORKER_NAME: "${workerName}" to vars`);
	}

	// KV and AE bindings need the provisioned IDs — tell user to add manually for now
	if (!hasMonitorKV || !hasMonitorAE) {
		console.log(`    ${pc.yellow('⚠')} Add CF_MONITOR_KV and CF_MONITOR_AE bindings manually to ${configPath}`);
		console.log(`        (IDs are in .cf-monitor/wrangler.jsonc)`);
	}

	writeFileSync(configPath, modified);
	return 'modified';
}

function stripJsoncComments(text: string): string {
	return text
		.replace(/\/\/.*$/gm, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Add a key-value entry to the "vars" object in a JSONC file.
 * Creates the "vars" section if it doesn't exist.
 */
function addJsoncVarsEntry(raw: string, key: string, value: string): string {
	const varsRegex = /"vars"\s*:\s*\{([^}]*)}/;
	const match = raw.match(varsRegex);

	if (match) {
		// vars section exists — append entry
		const existingContent = match[1].trimEnd();
		const needsComma = existingContent.length > 0 && !existingContent.endsWith(',');
		const newContent = `${existingContent}${needsComma ? ',' : ''}\n\t\t"${key}": "${value}"`;
		return raw.replace(varsRegex, `"vars": {${newContent}\n\t}`);
	}

	// No vars section — add before the last closing brace
	const lastBrace = raw.lastIndexOf('}');
	if (lastBrace === -1) return raw;

	const before = raw.slice(0, lastBrace).trimEnd();
	const needsComma = before.endsWith('}') || before.endsWith(']') || before.endsWith('"') || /\d$/.test(before);

	return `${before}${needsComma ? ',' : ''}\n\t"vars": {\n\t\t"${key}": "${value}"\n\t}\n}`;
}

function addJsoncProperty(
	raw: string,
	key: string,
	newValue: unknown[],
	existingValue: unknown[]
): string {
	const merged = [...existingValue, ...newValue];
	const serialised = JSON.stringify(merged, null, 4);

	// Try to find existing property and replace
	const regex = new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)\\]`);
	if (regex.test(raw)) {
		return raw.replace(regex, `"${key}": ${serialised}`);
	}

	// Add before the last closing brace
	const lastBrace = raw.lastIndexOf('}');
	if (lastBrace === -1) return raw;

	const before = raw.slice(0, lastBrace).trimEnd();
	const needsComma = before.endsWith('}') || before.endsWith(']') || before.endsWith('"') || /\d$/.test(before);

	return `${before}${needsComma ? ',' : ''}\n  "${key}": ${serialised}\n}`;
}
