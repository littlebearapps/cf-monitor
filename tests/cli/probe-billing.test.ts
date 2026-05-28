import { describe, it, expect, vi } from 'vitest';
import {
	classifyProbeOutcome,
	redactBilling,
	probeBillingEndpoints,
	BILLING_PROBE_ENDPOINTS,
} from '../../src/cli/probe-billing.js';

describe('classifyProbeOutcome', () => {
	it('maps 2xx to payload', () => {
		expect(classifyProbeOutcome(200, { success: true, result: {} })).toBe('payload');
	});

	it('maps 403 to permission_denied (endpoint exists, needs Billing Read)', () => {
		expect(classifyProbeOutcome(403, { errors: [{ message: 'Authentication error' }] })).toBe('permission_denied');
	});

	it('maps 400 "could not route" to no_route', () => {
		expect(classifyProbeOutcome(400, { errors: [{ message: 'Could not route to /accounts/x/billing' }] })).toBe('no_route');
	});

	it('maps a generic 500 to unknown_error', () => {
		expect(classifyProbeOutcome(500, 'Internal Server Error')).toBe('unknown_error');
	});
});

describe('redactBilling', () => {
	const accountId = 'aabbccdd11223344aabbccdd11223344';

	it('redacts sensitive keys, preserves non-sensitive values, and scrubs the account ID everywhere', () => {
		const input = {
			email: 'nathan@example.com',
			plan: 'workers_paid',
			count: 42,
			customer_id: 'cus_12345',
			id: 'sub_opaque', // non-sensitive opaque id → preserved
			nested: {
				phone: '+61400000000',
				note: `account ${accountId} owns this`,
			},
			addresses: [{ street: '1 Main St' }],
		};

		const out = redactBilling(input, accountId) as Record<string, unknown>;

		expect(out.email).toBe('<REDACTED>');
		expect(out.customer_id).toBe('<REDACTED>');
		expect((out.nested as Record<string, unknown>).phone).toBe('<REDACTED>');
		expect(((out.addresses as Array<Record<string, unknown>>)[0]).street).toBe('<REDACTED>');

		// Non-sensitive values pass through (short pseudo-id that doesn't match any opaque-id pattern).
		expect(out.plan).toBe('workers_paid');
		expect(out.count).toBe(42);
		expect(out.id).toBe('sub_opaque');

		// Account ID is replaced even when embedded in a non-sensitive string value.
		expect((out.nested as Record<string, unknown>).note).toBe('account <ACCOUNT_ID> owns this');
	});

	it('redacts opaque-id-shaped string values regardless of key name', () => {
		const accountId = '00000000000000000000000000000000';
		const input = {
			profile_id: 'f47adeed453a5862a004e8ef552e5041',           // 32-hex → <REDACTED_ID>
			tracker: '264d8ea2-73a6-59c2-a39f-e17b1d0b8d45',          // UUID under non-sensitive key → <REDACTED_ID>
			external: 'sub_1SDf2RCM3YxTUEmtVQBxAneH',                // Stripe sub_ → <REDACTED_ID>
			rate_plan: { id: 'workers_paid', currency: 'USD' },      // catalog values preserved
			short_id: 'sub_opaque',                                  // too short for Stripe regex → preserved
			zone: { id: 'd41cec4834a62156ae4c05efcbad4504' },         // 32-hex under `id` key → <REDACTED_ID>
		};
		const out = redactBilling(input, accountId) as Record<string, unknown>;
		expect(out.profile_id).toBe('<REDACTED_ID>');
		expect(out.tracker).toBe('<REDACTED_ID>');
		expect(out.external).toBe('<REDACTED_ID>');
		expect((out.rate_plan as Record<string, unknown>).id).toBe('workers_paid');
		expect((out.rate_plan as Record<string, unknown>).currency).toBe('USD');
		expect(out.short_id).toBe('sub_opaque');
		expect((out.zone as Record<string, unknown>).id).toBe('<REDACTED_ID>');
	});

	it('redacts values under invoice_id / receipt_id keys (independent of value shape)', () => {
		const out = redactBilling(
			{ invoice_id: 'human-readable-anything', receipt_id: 'IN-64052317' },
			'00000000000000000000000000000000',
		) as Record<string, unknown>;
		expect(out.invoice_id).toBe('<REDACTED>');
		expect(out.receipt_id).toBe('<REDACTED>');
	});
});

describe('probeBillingEndpoints', () => {
	it('probes all four endpoints with GET only and never mutates', async () => {
		const accountId = 'aabbccdd11223344aabbccdd11223344';
		const mockFetch = vi.fn(async () =>
			new Response(JSON.stringify({ errors: [{ message: 'Authentication error' }] }), { status: 403 })
		) as unknown as typeof fetch;

		const results = await probeBillingEndpoints('test-token', accountId, mockFetch);

		// One result per endpoint, all classified as permission_denied (403).
		expect(results.map((r) => r.endpoint)).toEqual([...BILLING_PROBE_ENDPOINTS]);
		expect(results.every((r) => r.outcome === 'permission_denied')).toBe(true);

		// No-mutation guarantee: every call is a GET with no body.
		const calls = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls).toHaveLength(BILLING_PROBE_ENDPOINTS.length);
		for (const [, init] of calls) {
			const method = (init as RequestInit | undefined)?.method;
			expect(method === undefined || method === 'GET').toBe(true);
			expect((init as RequestInit | undefined)?.body).toBeUndefined();
		}
	});

	it('classifies a 200 payload and redacts the account ID in the stored body', async () => {
		const accountId = 'aabbccdd11223344aabbccdd11223344';
		const mockFetch = vi.fn(async (url: string) =>
			new Response(JSON.stringify({ success: true, result: { ref: url } }), { status: 200 })
		) as unknown as typeof fetch;

		const results = await probeBillingEndpoints('test-token', accountId, mockFetch);
		const usage = results.find((r) => r.endpoint.startsWith('/billing/usage'));

		expect(usage?.outcome).toBe('payload');
		// The probed URL contained the account ID; it must be scrubbed in the redacted body.
		expect(JSON.stringify(usage?.body)).not.toContain(accountId);
		expect(JSON.stringify(usage?.body)).toContain('<ACCOUNT_ID>');
	});
});
