import pc from 'picocolors';
import { readFileSync, existsSync } from 'node:fs';

interface UsageOptions {
	json?: boolean;
	detail?: boolean;
}

export async function usageCommand(options: UsageOptions): Promise<void> {
	const workerUrl = resolveWorkerUrl();
	if (!workerUrl) {
		console.log(pc.bold('\ncf-monitor usage\n'));
		console.log(pc.yellow('  Cannot determine worker URL.'));
		console.log(`  Ensure ${pc.cyan('.cf-monitor/wrangler.jsonc')} exists (run ${pc.cyan('npx cf-monitor init')} first).`);
		return;
	}

	try {
		const response = await fetch(`${workerUrl}/usage`);
		if (!response.ok) {
			console.error(pc.red(`  Worker returned ${response.status}: ${response.statusText}`));
			return;
		}

		const data = await response.json() as UsageResponse;

		if (options.json) {
			console.log(JSON.stringify(data, null, 2));
			return;
		}

		// Formatted output
		console.log(pc.bold('\ncf-monitor usage\n'));
		console.log(`  Account: ${pc.cyan(data.account)}`);
		if (data.plan) {
			const planLabel = data.plan === 'paid' ? pc.green('Workers Paid') : pc.yellow('Workers Free');
			console.log(`  Plan: ${planLabel}`);
		}
		if (data.billingPeriod) {
			const start = data.billingPeriod.start.slice(0, 10);
			const end = data.billingPeriod.end.slice(0, 10);
			const daysLeft = Math.max(0, Math.ceil((new Date(data.billingPeriod.end).getTime() - Date.now()) / 86_400_000));
			console.log(`  Billing period: ${start} to ${end} (${daysLeft} days remaining)`);
		}
		console.log('');

		if (!data.usage) {
			console.log(pc.dim('  No usage data collected yet. Run: POST /admin/cron/collect-account-usage'));
			console.log('');
			return;
		}

		// Usage table
		console.log(pc.bold('  Service              Metric                 Used          Included       %'));
		console.log(pc.dim('  ─────────────────────────────────────────────────────────────────────────────'));

		const services = data.usage.services ?? {};
		const allowances = data.allowances ?? {};

		printServiceRow('Workers', 'requests', services.workers?.requests, (allowances as Record<string, Record<string, number>>).workers?.requests);
		printServiceRow('D1', 'rowsRead', services.d1?.rowsRead, (allowances as Record<string, Record<string, number>>).d1?.rowsRead);
		printServiceRow('D1', 'rowsWritten', services.d1?.rowsWritten, (allowances as Record<string, Record<string, number>>).d1?.rowsWritten);
		printServiceRow('KV', 'reads', services.kv?.reads, (allowances as Record<string, Record<string, number>>).kv?.reads);
		printServiceRow('KV', 'writes', services.kv?.writes, (allowances as Record<string, Record<string, number>>).kv?.writes);
		printServiceRow('R2', 'classA', services.r2?.classA, (allowances as Record<string, Record<string, number>>).r2?.classA);
		printServiceRow('R2', 'classB', services.r2?.classB, (allowances as Record<string, Record<string, number>>).r2?.classB);
		printServiceRow('AI Gateway', 'requests', services.aiGateway?.requests, undefined);
		// v0.4.0: AI Gateway aggregates (tokens/cost/cached/errors) — only render rows with non-zero values
		const ag = services.aiGateway as AiGatewayServiceBlock | undefined;
		if (ag?.tokens_in !== undefined && ag.tokens_in > 0) printServiceRow('AI Gateway', 'tokens_in', ag.tokens_in, undefined);
		if (ag?.tokens_out !== undefined && ag.tokens_out > 0) printServiceRow('AI Gateway', 'tokens_out', ag.tokens_out, undefined);
		if (ag?.cached !== undefined && ag.cached > 0) printServiceRow('AI Gateway', 'cached', ag.cached, undefined);
		if (ag?.errors !== undefined && ag.errors > 0) printServiceRow('AI Gateway', 'errors', ag.errors, undefined);
		printServiceRow('DO', 'requests', services.durableObjects?.requests, (allowances as Record<string, Record<string, number>>).durableObjects?.requests);
		printServiceRow('Vectorize', 'queries', services.vectorize?.queries, (allowances as Record<string, Record<string, number>>).vectorize?.queries);
		printServiceRow('Queues', 'produced', services.queues?.produced, (allowances as Record<string, Record<string, number>>).queues?.produced);

		// Headline AI Gateway cost line (always shown when data exists — cost is the
		// most-watched number in this block)
		if (ag?.cost !== undefined && ag.cost > 0) {
			console.log('');
			console.log(`  ${pc.bold('AI Gateway cost today')}: ${pc.cyan(`$${ag.cost.toFixed(4)}`)} ` +
				pc.dim(`(${formatNumber(ag.requests ?? 0)} requests` +
					(ag.cached ? `, ${formatNumber(ag.cached)} cached` : '') +
					(ag.errors ? `, ${pc.red(`${formatNumber(ag.errors)} errors`)}` : '') +
					`)`));
		}

		console.log('');
		console.log(pc.dim(`  ${data.disclaimer}`));
		console.log(pc.dim(`  Last collected: ${data.usage.collected_at}`));
		console.log('');

		// --detail: per-gateway/provider/model breakdown from /usage/ai-gateway
		if (options.detail) {
			await renderAiGatewayDetail(workerUrl);
		}
	} catch (err) {
		console.error(pc.red(`  Failed to connect to cf-monitor worker at ${workerUrl}`));
		console.error(pc.dim(`  Error: ${err}`));
	}
}

function printServiceRow(
	service: string,
	metric: string,
	used: number | undefined,
	included: number | undefined
): void {
	if (used === undefined && included === undefined) return;

	const usedStr = used !== undefined ? formatNumber(used) : '-';
	const includedStr = included !== undefined && included !== Infinity ? formatNumber(included) : 'unlimited';

	let pctStr = '';
	let colour = pc.green;

	if (used !== undefined && included !== undefined && included > 0 && included !== Infinity) {
		const pct = (used / included) * 100;
		pctStr = `${pct.toFixed(1)}%`;
		if (pct >= 90) colour = pc.red;
		else if (pct >= 70) colour = pc.yellow;
	}

	const svc = service.padEnd(20);
	const met = metric.padEnd(22);
	const usd = usedStr.padStart(12);
	const inc = includedStr.padStart(14);
	const pct = pctStr.padStart(8);

	console.log(`  ${svc} ${met} ${colour(usd)}  ${pc.dim(inc)}  ${colour(pct)}`);
}

function formatNumber(n: number): string {
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
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

interface UsageResponse {
	account: string;
	plan?: string;
	billingPeriod?: { start: string; end: string; dayOfMonth: number };
	allowances?: Record<string, unknown>;
	usage?: {
		collected_at: string;
		disclaimer: string;
		services: Record<string, Record<string, number>>;
	};
	disclaimer: string;
	timestamp: number;
}

interface AiGatewayServiceBlock {
	requests?: number;
	tokens_in?: number;
	tokens_out?: number;
	cost?: number;
	cached?: number;
	errors?: number;
}

interface AiGatewayDetailResponse {
	account: string;
	date: string;
	status: 'ok' | 'no_data' | 'corrupted';
	snapshot?: {
		date: string;
		gateways: Record<string, {
			providers: Record<string, {
				models: Record<string, {
					requests: number;
					tokens_in: number;
					tokens_out: number;
					cost: number;
					cached: number;
					errors: number;
					p50_duration_ms: number;
				}>;
			}>;
		}>;
		totals: { requests: number; tokens_in: number; tokens_out: number; cost: number; cached: number; errors: number };
		lastUpdated: number;
	};
	reason?: string;
}

async function renderAiGatewayDetail(workerUrl: string): Promise<void> {
	console.log(pc.bold('  AI Gateway detail (today)'));
	console.log(pc.dim('  ─────────────────────────────────────────────────────────────────────────────'));
	let body: AiGatewayDetailResponse;
	try {
		const resp = await fetch(`${workerUrl}/usage/ai-gateway`);
		if (!resp.ok) {
			console.log(pc.yellow(`    Worker returned ${resp.status}`));
			console.log('');
			return;
		}
		body = await resp.json() as AiGatewayDetailResponse;
	} catch (err) {
		console.log(pc.red(`    Fetch failed: ${err instanceof Error ? err.message : String(err)}`));
		console.log('');
		return;
	}

	if (body.status !== 'ok' || !body.snapshot) {
		console.log(pc.dim(`    No AI Gateway data for ${body.date} (${body.reason ?? body.status})`));
		console.log('');
		return;
	}

	const snap = body.snapshot;
	for (const [gwId, gw] of Object.entries(snap.gateways)) {
		console.log(`    ${pc.bold(gwId)}`);
		for (const [provider, prov] of Object.entries(gw.providers)) {
			for (const [model, agg] of Object.entries(prov.models)) {
				const costStr = pc.cyan(`$${agg.cost.toFixed(4)}`);
				const reqStr = formatNumber(agg.requests);
				const tokStr = `${formatNumber(agg.tokens_in)}/${formatNumber(agg.tokens_out)}`;
				const cacheStr = agg.cached ? pc.green(`cached=${formatNumber(agg.cached)}`) : pc.dim('cached=0');
				const errStr = agg.errors ? pc.red(`errors=${agg.errors}`) : pc.dim('errors=0');
				const p50Str = pc.dim(`p50=${agg.p50_duration_ms}ms`);
				console.log(`      ${provider.padEnd(20)} ${model.padEnd(28)} req=${reqStr.padStart(6)}  tok=${tokStr.padEnd(14)}  ${costStr.padStart(10)}  ${cacheStr}  ${errStr}  ${p50Str}`);
			}
		}
	}

	console.log('');
	console.log(pc.dim(`    Last updated: ${new Date(snap.lastUpdated).toISOString()}`));
	console.log('');
}
