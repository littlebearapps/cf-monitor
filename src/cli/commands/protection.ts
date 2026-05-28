import pc from 'picocolors';
import { readFileSync, existsSync } from 'node:fs';

interface ProtectionOptions {
	json?: boolean;
	adminToken?: string;
}

interface Finding {
	id: string;
	title: string;
	severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
	status: 'protected' | 'partially_protected' | 'unprotected' | 'unknown' | 'not_applicable';
	resource_type?: string;
	resource_name?: string;
	evidence: string;
	recommended_actions: string[];
}

interface ProtectionResponse {
	generated_at: string;
	account: string;
	summary: {
		score: number;
		protected: number;
		partially_protected: number;
		unprotected: number;
		unknown: number;
		not_applicable: number;
		critical: number;
		high: number;
		medium: number;
		low: number;
		info: number;
	};
	findings: Finding[];
	caveats: string[];
}

export async function protectionCommand(options: ProtectionOptions): Promise<void> {
	const workerUrl = resolveWorkerUrl();
	if (!workerUrl) {
		console.log(pc.bold('\ncf-monitor protection\n'));
		console.log(pc.yellow('  Cannot determine worker URL.'));
		console.log(`  Ensure ${pc.cyan('.cf-monitor/wrangler.jsonc')} exists (run ${pc.cyan('npx cf-monitor init')} first).`);
		return;
	}

	const token = options.adminToken ?? process.env.CF_MONITOR_ADMIN_TOKEN;
	const headers: Record<string, string> = {};
	if (token) headers['Authorization'] = `Bearer ${token}`;

	let body: ProtectionResponse;
	try {
		const resp = await fetch(`${workerUrl}/protection`, { headers });
		if (resp.status === 401) {
			console.error(pc.red('  Worker returned 401 Unauthorized.'));
			console.error(`  /protection requires an admin token. Export ${pc.cyan('CF_MONITOR_ADMIN_TOKEN')} or pass ${pc.cyan('--admin-token <token>')}.`);
			console.error(pc.dim('  Set the token on the worker with: wrangler secret put ADMIN_TOKEN'));
			process.exitCode = 1;
			return;
		}
		if (!resp.ok) {
			console.error(pc.red(`  Worker returned ${resp.status}: ${resp.statusText}`));
			process.exitCode = 1;
			return;
		}
		body = await resp.json() as ProtectionResponse;
	} catch (err) {
		console.error(pc.red(`  Failed to connect to cf-monitor worker at ${workerUrl}`));
		console.error(pc.dim(`  Error: ${err instanceof Error ? err.message : String(err)}`));
		process.exitCode = 1;
		return;
	}

	if (options.json) {
		console.log(JSON.stringify(body, null, 2));
		return;
	}

	renderText(body);
}

function renderText(body: ProtectionResponse): void {
	console.log(pc.bold('\ncf-monitor protection coverage\n'));
	console.log(`  Account:  ${pc.cyan(body.account)}`);

	const scoreColor = body.summary.score >= 80 ? pc.green
		: body.summary.score >= 50 ? pc.yellow
		: pc.red;
	console.log(`  Score:    ${scoreColor(`${body.summary.score}/100`)}  ${pc.dim('(heuristic)')}`);
	console.log(`  Status:   ${pc.green(String(body.summary.protected))} protected · ` +
		`${pc.yellow(String(body.summary.partially_protected))} partial · ` +
		`${pc.red(String(body.summary.unprotected))} unprotected · ` +
		`${pc.dim(String(body.summary.unknown))} unknown · ` +
		`${pc.dim(String(body.summary.not_applicable))} n/a`);
	console.log('');

	for (const sev of ['critical', 'high', 'medium', 'low', 'info'] as const) {
		const group = body.findings.filter((f) => f.severity === sev);
		if (group.length === 0) continue;
		const header = sev[0].toUpperCase() + sev.slice(1);
		const color = sev === 'critical' ? pc.red
			: sev === 'high' ? pc.red
			: sev === 'medium' ? pc.yellow
			: pc.dim;
		console.log(color(pc.bold(`${header}:`)));
		for (const f of group) {
			const statusGlyph = f.status === 'protected' ? pc.green('✓')
				: f.status === 'partially_protected' ? pc.yellow('~')
				: f.status === 'unprotected' ? pc.red('✗')
				: f.status === 'not_applicable' ? pc.dim('·')
				: pc.dim('?');
			console.log(`  ${statusGlyph} ${f.title}`);
			if (f.evidence) console.log(pc.dim(`    ${f.evidence}`));
			for (const action of f.recommended_actions.slice(0, 2)) {
				console.log(pc.dim(`    → ${action}`));
			}
		}
		console.log('');
	}

	if (body.caveats.length > 0) {
		console.log(pc.bold('Caveats:'));
		for (const c of body.caveats) console.log(pc.dim(`  • ${c}`));
		console.log('');
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
