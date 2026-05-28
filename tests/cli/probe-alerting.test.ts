import { describe, it, expect, vi } from 'vitest';
import {
	probeAlertingEndpoints,
	ALERTING_PROBE_ENDPOINTS,
} from '../../src/cli/probe-alerting.js';

describe('probeAlertingEndpoints', () => {
	it('probes all three alerting endpoints with GET only and never mutates', async () => {
		const accountId = 'aabbccdd11223344aabbccdd11223344';
		const mockFetch = vi.fn(async () =>
			new Response(JSON.stringify({ result: [] }), { status: 200 }),
		) as unknown as typeof fetch;

		const results = await probeAlertingEndpoints('test-token', accountId, mockFetch);
		expect(results.map((r) => r.endpoint)).toEqual([...ALERTING_PROBE_ENDPOINTS]);
		expect(results.every((r) => r.outcome === 'payload')).toBe(true);

		const calls = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls).toHaveLength(ALERTING_PROBE_ENDPOINTS.length);
		for (const [, init] of calls) {
			const method = (init as RequestInit | undefined)?.method;
			expect(method === undefined || method === 'GET').toBe(true);
			expect((init as RequestInit | undefined)?.body).toBeUndefined();
		}
	});

	it('classifies 403 as permission_denied and 200 as payload', async () => {
		const accountId = 'aabbccdd11223344aabbccdd11223344';
		const mockFetch = vi.fn() as unknown as typeof fetch;
		const fnMock = mockFetch as unknown as ReturnType<typeof vi.fn>;
		fnMock
			.mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
			.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
			.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

		const results = await probeAlertingEndpoints('test-token', accountId, mockFetch);
		expect(results[0].outcome).toBe('payload');
		expect(results[1].outcome).toBe('permission_denied');
		expect(results[2].outcome).toBe('permission_denied');
	});

	it('redacts opaque ids in the saved body (32-hex / UUID via shared redactor)', async () => {
		const accountId = 'aabbccdd11223344aabbccdd11223344';
		const policyId = '11223344556677889900aabbccddeeff';
		const mockFetch = vi.fn(async () =>
			new Response(JSON.stringify({ result: [{ id: policyId, name: 'cf-monitor:budget-alert' }] }), { status: 200 }),
		) as unknown as typeof fetch;

		const results = await probeAlertingEndpoints('test-token', accountId, mockFetch);
		const serialised = JSON.stringify(results);
		expect(serialised).not.toContain(policyId);
		expect(serialised).toContain('<REDACTED_ID>');
	});
});
