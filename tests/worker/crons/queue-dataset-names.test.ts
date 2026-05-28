import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard for the 2026-05-27 probe correction: the Queue GraphQL datasets are SINGULAR
// (`queueBacklogAdaptiveGroups`, …). The plural `queuesBacklogAdaptiveGroups` is a 400 "unknown field"
// and must never appear in source again. No queue collector exists yet, so we only assert the wrong
// name is absent — we don't require the singular names to be present.
const WRONG_PLURAL = 'queuesBacklogAdaptiveGroups';

function collectTsFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			collectTsFiles(full, acc);
		} else if (entry.isFile() && entry.name.endsWith('.ts')) {
			acc.push(full);
		}
	}
	return acc;
}

describe('queue GraphQL dataset names', () => {
	it('never uses the wrong plural name anywhere in src/', () => {
		const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src');
		const offenders = collectTsFiles(srcDir).filter((f) =>
			readFileSync(f, 'utf-8').includes(WRONG_PLURAL)
		);
		expect(offenders, `Found wrong plural "${WRONG_PLURAL}" in: ${offenders.join(', ')}`).toEqual([]);
	});
});
