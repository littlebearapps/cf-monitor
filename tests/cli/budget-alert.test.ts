import { describe, it, expect, vi } from 'vitest';
import {
	buildPolicyBody,
	findExistingCfMonitorPolicy,
	findOrCreateWebhookDestination,
	registerBudgetAlert,
	BudgetAlertError,
	POLICY_NAME,
	ALERT_TYPE,
} from '../../src/cli/budget-alert.js';

const ACCOUNT = 'aabbccdd11223344aabbccdd11223344';
const TOKEN = 'test-token';

function makeFetchMock(): ReturnType<typeof vi.fn> {
	return vi.fn();
}

function jsonResp(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

describe('buildPolicyBody', () => {
	it('builds the canonical body for an email mechanism', () => {
		const body = buildPolicyBody(
			{ threshold: 100, recipientEmail: 'nathan@example.com' },
			{ type: 'email', id: 'nathan@example.com' },
		);
		expect(body.name).toBe(POLICY_NAME);
		expect(body.alert_type).toBe(ALERT_TYPE);
		expect(body.enabled).toBe(true);
		expect((body.mechanisms as { email: Array<{ id: string }> }).email[0].id).toBe('nathan@example.com');
		expect(body.filters).toEqual({});
		expect((body.description as string).toLowerCase()).toContain('alert_only');
		expect((body.description as string).toLowerCase()).toContain('threshold');
	});

	it('builds the body for a webhook mechanism using the destination id', () => {
		const body = buildPolicyBody(
			{ threshold: 250, webhookUrl: 'https://hooks.example.com/cf' },
			{ type: 'webhooks', id: 'dest-uuid-123' },
		);
		expect((body.mechanisms as { webhooks: Array<{ id: string }> }).webhooks[0].id).toBe('dest-uuid-123');
		expect(body.alert_type).toBe(ALERT_TYPE);
	});
});

describe('findExistingCfMonitorPolicy', () => {
	it('returns null when no cf-monitor policy is present', async () => {
		const fetchMock = makeFetchMock() as unknown as typeof fetch;
		(fetchMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResp(200, {
			result: [{ id: 'p1', name: 'unrelated' }],
		}));
		expect(await findExistingCfMonitorPolicy(ACCOUNT, TOKEN, fetchMock)).toBeNull();
	});

	it('returns the policy id when a cf-monitor policy is present', async () => {
		const fetchMock = makeFetchMock() as unknown as typeof fetch;
		(fetchMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResp(200, {
			result: [{ id: 'p1', name: 'unrelated' }, { id: 'cfm-id', name: POLICY_NAME }],
		}));
		const found = await findExistingCfMonitorPolicy(ACCOUNT, TOKEN, fetchMock);
		expect(found?.id).toBe('cfm-id');
	});

	it('throws BudgetAlertError on 403', async () => {
		const fetchMock = makeFetchMock() as unknown as typeof fetch;
		(fetchMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
		await expect(findExistingCfMonitorPolicy(ACCOUNT, TOKEN, fetchMock)).rejects.toThrow(BudgetAlertError);
	});
});

describe('findOrCreateWebhookDestination', () => {
	it('reuses an existing destination matched by URL', async () => {
		const fetchMock = makeFetchMock() as unknown as typeof fetch;
		(fetchMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResp(200, {
			result: [
				{ id: 'other', url: 'https://other.example/' },
				{ id: 'match', url: 'https://hooks.example.com/cf' },
			],
		}));
		const id = await findOrCreateWebhookDestination(ACCOUNT, TOKEN, 'https://hooks.example.com/cf', fetchMock);
		expect(id).toBe('match');
		// Only the LIST call should fire — no create.
		expect((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
	});

	it('creates a new destination when none match', async () => {
		const fetchMock = makeFetchMock() as unknown as typeof fetch;
		const fnMock = fetchMock as unknown as ReturnType<typeof vi.fn>;
		fnMock
			.mockResolvedValueOnce(jsonResp(200, { result: [] }))
			.mockResolvedValueOnce(jsonResp(200, { result: { id: 'new-dest' } }));
		const id = await findOrCreateWebhookDestination(ACCOUNT, TOKEN, 'https://hooks.example.com/cf', fetchMock);
		expect(id).toBe('new-dest');
		expect(fnMock.mock.calls).toHaveLength(2);
		expect((fnMock.mock.calls[1][1] as RequestInit).method).toBe('POST');
	});
});

describe('registerBudgetAlert', () => {
	it('creates a new policy when none exists (email path, happy)', async () => {
		const fetchMock = makeFetchMock() as unknown as typeof fetch;
		const fnMock = fetchMock as unknown as ReturnType<typeof vi.fn>;
		fnMock
			// list policies → none
			.mockResolvedValueOnce(jsonResp(200, { result: [] }))
			// create policy
			.mockResolvedValueOnce(jsonResp(200, { result: { id: 'new-policy-id' } }));

		const status = await registerBudgetAlert(ACCOUNT, TOKEN, {
			threshold: 100,
			recipientEmail: 'nathan@example.com',
		}, fetchMock);

		expect(status.policy_id).toBe('new-policy-id');
		expect(status.threshold).toBe(100);
		expect(status.alert_type).toBe(ALERT_TYPE);
		expect(status.label).toBe('alert_only');
		expect(status.recipient).toBe('email');
		expect(status.dashboard_threshold_url).toContain('billable-usage');

		const createCall = fnMock.mock.calls[1];
		const createBody = JSON.parse((createCall[1] as RequestInit).body as string) as Record<string, unknown>;
		expect(createBody.alert_type).toBe(ALERT_TYPE);
		expect(createBody.name).toBe(POLICY_NAME);
		expect((createBody.mechanisms as { email: Array<{ id: string }> }).email[0].id).toBe('nathan@example.com');
	});

	it('updates the existing policy in place (idempotency)', async () => {
		const fetchMock = makeFetchMock() as unknown as typeof fetch;
		const fnMock = fetchMock as unknown as ReturnType<typeof vi.fn>;
		fnMock
			// list policies → cf-monitor policy present
			.mockResolvedValueOnce(jsonResp(200, { result: [{ id: 'existing-id', name: POLICY_NAME }] }))
			// update PUT
			.mockResolvedValueOnce(jsonResp(200, { result: { id: 'existing-id' } }));

		const status = await registerBudgetAlert(ACCOUNT, TOKEN, {
			threshold: 250,
			recipientEmail: 'nathan@example.com',
		}, fetchMock);

		expect(status.policy_id).toBe('existing-id');
		expect(status.threshold).toBe(250);
		const updateCall = fnMock.mock.calls[1];
		expect((updateCall[1] as RequestInit).method).toBe('PUT');
		expect(updateCall[0] as string).toContain('/policies/existing-id');
	});

	it('throws BudgetAlertError("forbidden") on 403 from policy POST', async () => {
		const fetchMock = makeFetchMock() as unknown as typeof fetch;
		const fnMock = fetchMock as unknown as ReturnType<typeof vi.fn>;
		fnMock
			.mockResolvedValueOnce(jsonResp(200, { result: [] }))
			.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

		await expect(registerBudgetAlert(ACCOUNT, TOKEN, {
			threshold: 100,
			recipientEmail: 'nathan@example.com',
		}, fetchMock)).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('rejects when neither email nor webhook is supplied', async () => {
		const fetchMock = makeFetchMock() as unknown as typeof fetch;
		await expect(registerBudgetAlert(ACCOUNT, TOKEN, { threshold: 100 }, fetchMock))
			.rejects.toMatchObject({ code: 'no_recipient' });
	});

	it('uses a webhook mechanism when --alert-webhook is supplied', async () => {
		const fetchMock = makeFetchMock() as unknown as typeof fetch;
		const fnMock = fetchMock as unknown as ReturnType<typeof vi.fn>;
		fnMock
			// list webhook destinations → none, then create
			.mockResolvedValueOnce(jsonResp(200, { result: [] }))
			.mockResolvedValueOnce(jsonResp(200, { result: { id: 'dest-id' } }))
			// list policies → none, then create
			.mockResolvedValueOnce(jsonResp(200, { result: [] }))
			.mockResolvedValueOnce(jsonResp(200, { result: { id: 'pol-id' } }));

		const status = await registerBudgetAlert(ACCOUNT, TOKEN, {
			threshold: 100,
			webhookUrl: 'https://hooks.example.com/cf',
		}, fetchMock);

		expect(status.recipient).toBe('webhook');
		const createPolicyBody = JSON.parse((fnMock.mock.calls[3][1] as RequestInit).body as string) as Record<string, unknown>;
		expect((createPolicyBody.mechanisms as { webhooks: Array<{ id: string }> }).webhooks[0].id).toBe('dest-id');
	});
});
