import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createKVNamespace, listWorkers, getAccountPlan } from '../../src/cli/cloudflare-api.js';

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
	mockFetch = vi.fn();
	vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('createKVNamespace', () => {
	it('creates new namespace and returns ID', async () => {
		// First call: list (no existing)
		mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
			result: [],
		})));
		// Second call: create
		mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
			result: { id: 'new-kv-id' },
		}), { status: 200 }));

		const id = await createKVNamespace('acc', 'token', 'cf-monitor');
		expect(id).toBe('new-kv-id');
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it('returns existing namespace ID if title matches', async () => {
		mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
			result: [{ id: 'existing-id', title: 'cf-monitor' }],
		})));

		const id = await createKVNamespace('acc', 'token', 'cf-monitor');
		expect(id).toBe('existing-id');
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it('throws on API error', async () => {
		mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ result: [] })));
		mockFetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

		await expect(createKVNamespace('acc', 'bad-token', 'test')).rejects.toThrow('Failed to create KV');
	});
});

describe('listWorkers', () => {
	it('returns worker names', async () => {
		mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
			result: [{ id: 'worker-a' }, { id: 'worker-b' }],
		})));

		const workers = await listWorkers('acc', 'token');
		expect(workers).toEqual(['worker-a', 'worker-b']);
	});

	it('returns empty array when no workers', async () => {
		mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
			result: [],
		})));

		const workers = await listWorkers('acc', 'token');
		expect(workers).toEqual([]);
	});

	it('throws on API error', async () => {
		mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
		await expect(listWorkers('acc', 'bad-token')).rejects.toThrow('Failed to list workers');
	});
});

describe('getAccountPlan', () => {
	it('returns plan type', async () => {
		mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
			result: { settings: { default_usage_model: 'bundled' } },
		})));

		const plan = await getAccountPlan('acc', 'token');
		expect(plan).toBe('bundled');
	});

	it('returns "unknown" on API error', async () => {
		mockFetch.mockResolvedValueOnce(new Response('Error', { status: 500 }));
		const plan = await getAccountPlan('acc', 'token');
		expect(plan).toBe('unknown');
	});

	it('returns "paid" when settings missing', async () => {
		mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
			result: {},
		})));

		const plan = await getAccountPlan('acc', 'token');
		expect(plan).toBe('paid');
	});
});
