import pc from 'picocolors';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeAlertingEndpoints } from '../probe-alerting.js';
import type { ProbeOutcome } from '../probe-billing.js';

interface ProbeAlertingOptions {
	accountId?: string;
	token?: string;
	out?: string;
}

export async function probeAlertingCommand(options: ProbeAlertingOptions): Promise<void> {
	const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
	const token = options.token ?? process.env.CLOUDFLARE_API_TOKEN;

	console.log(pc.bold('\ncf-monitor probe alerting\n'));

	if (!token || !accountId) {
		console.error(pc.red('  Missing credentials.'));
		console.error(`  Set ${pc.cyan('CLOUDFLARE_API_TOKEN')} and ${pc.cyan('CLOUDFLARE_ACCOUNT_ID')} (or pass ${pc.cyan('--token')} / ${pc.cyan('--account-id')}).`);
		process.exitCode = 1;
		return;
	}
	if (!/^[0-9a-f]{32}$/i.test(accountId)) {
		console.error(pc.red('  CLOUDFLARE_ACCOUNT_ID must be a 32-character hex string.'));
		process.exitCode = 1;
		return;
	}

	console.log(pc.dim('  Read-only GET probe — no mutations. Sensitive values are redacted before saving.\n'));

	const results = await probeAlertingEndpoints(token, accountId);
	for (const r of results) {
		console.log(`  ${r.endpoint.padEnd(40)} ${String(r.status).padStart(3)}  ${outcomeLabel(r.outcome)}`);
	}

	const date = new Date().toISOString().slice(0, 10);
	const dir = options.out ?? join('docs', 'research', 'probes');
	const file = join(dir, `alerting-probe-${date}.redacted.json`);
	mkdirSync(dir, { recursive: true });
	const payload = {
		probed_at: new Date().toISOString(),
		account_id: '<ACCOUNT_ID>',
		note: 'Read-only probe of CF Notifications/Alerting endpoints. Sensitive values redacted before saving.',
		results,
	};
	writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');

	console.log('');
	console.log(`  Saved: ${pc.cyan(file)}`);

	if (results.some((r) => r.outcome === 'permission_denied')) {
		console.log('');
		console.log(pc.yellow('  Some endpoints returned 403 — they exist but the token lacks Notifications Read/Write.'));
	}
	console.log('');
}

function outcomeLabel(outcome: ProbeOutcome): string {
	switch (outcome) {
		case 'payload': return pc.green('payload returned');
		case 'permission_denied': return pc.yellow('exists — needs Notifications Read/Write');
		case 'no_route': return pc.dim('does not route');
		default: return pc.red('unknown error');
	}
}
