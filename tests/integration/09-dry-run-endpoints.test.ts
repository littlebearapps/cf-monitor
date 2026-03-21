/**
 * Integration: Dry-run admin endpoints for GitHub issue creation and Slack alerting.
 * Tests formatting, fingerprinting, and payload structure without real credentials.
 *
 * Issues: #34 (GitHub issue creation), #35 (Slack alerting)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
	hasCredentials,
	loadTestResources,
	fetchWorkerPost,
	type TestResources,
} from './helpers.js';

const SKIP = !hasCredentials();
let resources: TestResources;
let monitorUrl: string;

beforeAll(() => {
	if (SKIP) return;
	const loaded = loadTestResources();
	resources = loaded.resources;
	monitorUrl = resources.monitorWorkerUrl;
});

// =============================================================================
// GITHUB ISSUE DRY-RUN (#34)
// =============================================================================

describe.skipIf(SKIP)('GitHub issue dry-run (#34)', () => {
	it('returns correct issue title and labels for exception', async () => {
		const resp = await fetchWorkerPost(monitorUrl, '/admin/test/github-dry-run', {
			scriptName: 'test-worker',
			outcome: 'exception',
			errorMessage: 'Connection timeout',
			errorName: 'Error',
		});
		expect(resp.status).toBe(200);

		const body = await resp.json() as {
			title: string;
			body: string;
			labels: string[];
			fingerprint: string;
			priority: string;
			isTransient: boolean;
		};

		expect(body.title).toBe('[P1] test-worker: exception');
		expect(body.priority).toBe('P1');
		expect(body.labels).toContain('cf:error:exception');
		expect(body.labels).toContain('cf:priority:p1');
		expect(body.fingerprint).toMatch(/^[0-9a-f]{8}$/);
	}, 15_000);

	it('detects transient patterns', async () => {
		const resp = await fetchWorkerPost(monitorUrl, '/admin/test/github-dry-run', {
			scriptName: 'test-worker',
			outcome: 'exception',
			errorMessage: 'Rate limit exceeded: 429 Too Many Requests',
		});
		expect(resp.status).toBe(200);

		const body = await resp.json() as { isTransient: boolean; labels: string[] };
		expect(body.isTransient).toBe(true);
		expect(body.labels).toContain('cf:transient');
	}, 15_000);

	it('produces stable fingerprints (same error → same hash)', async () => {
		// Same input twice should produce identical fingerprints
		const [resp1, resp2] = await Promise.all([
			fetchWorkerPost(monitorUrl, '/admin/test/github-dry-run', {
				scriptName: 'test-worker',
				outcome: 'exception',
				errorMessage: 'Database connection failed',
			}),
			fetchWorkerPost(monitorUrl, '/admin/test/github-dry-run', {
				scriptName: 'test-worker',
				outcome: 'exception',
				errorMessage: 'Database connection failed',
			}),
		]);

		const body1 = await resp1.json() as { fingerprint: string };
		const body2 = await resp2.json() as { fingerprint: string };

		expect(body1.fingerprint).toBe(body2.fingerprint);
		expect(body1.fingerprint).toMatch(/^[0-9a-f]{8}$/);

		// Different error → different fingerprint
		const resp3 = await fetchWorkerPost(monitorUrl, '/admin/test/github-dry-run', {
			scriptName: 'test-worker',
			outcome: 'exception',
			errorMessage: 'Redis timeout exceeded',
		});
		const body3 = await resp3.json() as { fingerprint: string };
		expect(body3.fingerprint).not.toBe(body1.fingerprint);
	}, 15_000);

	it('formats issue body with markdown table and fingerprint', async () => {
		const resp = await fetchWorkerPost(monitorUrl, '/admin/test/github-dry-run', {
			scriptName: 'monitor-test',
			outcome: 'exceededCpu',
			errorMessage: 'CPU time exceeded',
		});
		expect(resp.status).toBe(200);

		const body = await resp.json() as { body: string; priority: string };
		expect(body.priority).toBe('P0'); // exceededCpu → P0
		expect(body.body).toContain('## Error Details');
		expect(body.body).toContain('| **Fingerprint** |');
		expect(body.body).toContain('| **Worker** | `monitor-test`');
	}, 15_000);
});

// =============================================================================
// SLACK ALERT DRY-RUN (#35)
// =============================================================================

describe.skipIf(SKIP)('Slack alert dry-run (#35)', () => {
	it('budget warning payload has correct structure', async () => {
		const resp = await fetchWorkerPost(monitorUrl, '/admin/test/slack-dry-run', {
			type: 'budget-warning',
			featureId: 'test:fetch:GET:api',
			metric: 'kv_reads',
			current: 700,
			limit: 1000,
		});
		expect(resp.status).toBe(200);

		const body = await resp.json() as { type: string; message: { blocks: Array<{ type: string; text?: { text: string }; fields?: Array<{ text: string }> }> } };
		expect(body.type).toBe('budget-warning');
		expect(body.message.blocks[0].type).toBe('header');
		expect(body.message.blocks[0].text?.text).toContain('Budget Warning');

		// Section with fields
		const section = body.message.blocks[1];
		expect(section.type).toBe('section');
		expect(section.fields).toBeDefined();
		const fieldTexts = section.fields!.map((f) => f.text).join(' ');
		expect(fieldTexts).toContain('test:fetch:GET:api');
		expect(fieldTexts).toContain('kv_reads');
	}, 15_000);

	it('critical budget warning uses rotating_light emoji', async () => {
		const resp = await fetchWorkerPost(monitorUrl, '/admin/test/slack-dry-run', {
			type: 'budget-warning',
			featureId: 'test:fetch:GET:api',
			metric: 'kv_reads',
			current: 950,
			limit: 1000,
		});
		expect(resp.status).toBe(200);

		const body = await resp.json() as { message: { blocks: Array<{ text?: { text: string } }> } };
		// 95% → rotating_light (>= 90%)
		expect(body.message.blocks[0].text?.text).toContain(':rotating_light:');
	}, 15_000);

	it('error alert payload has correct structure', async () => {
		const resp = await fetchWorkerPost(monitorUrl, '/admin/test/slack-dry-run', {
			type: 'error-alert',
			scriptName: 'test-worker',
			outcome: 'exception',
			priority: 'P1',
			issueUrl: 'https://github.com/test/repo/issues/1',
		});
		expect(resp.status).toBe(200);

		const body = await resp.json() as { type: string; message: { blocks: Array<{ type: string; text?: { text: string }; fields?: Array<{ text: string }> }> } };
		expect(body.type).toBe('error-alert');
		expect(body.message.blocks[0].text?.text).toContain(':fire:');
		expect(body.message.blocks[0].text?.text).toContain('test-worker');

		const section = body.message.blocks[1];
		const fieldTexts = section.fields!.map((f) => f.text).join(' ');
		expect(fieldTexts).toContain('exception');
		expect(fieldTexts).toContain('View');
	}, 15_000);
});
