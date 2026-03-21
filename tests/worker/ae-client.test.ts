import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { queryAE, getActiveWorkers } from '../../src/worker/ae-client.js';

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
	mockFetch = vi.fn();
	vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('queryAE', () => {
	it('sends SQL query to AE endpoint and returns parsed result', async () => {
		mockFetch.mockResolvedValue(new Response(JSON.stringify({
			data: [{ worker_name: 'my-api', invocations: 42 }],
			meta: [
				{ name: 'worker_name', type: 'String' },
				{ name: 'invocations', type: 'UInt64' },
			],
			rows: 1,
		})));

		const result = await queryAE('acc123', 'token456', 'SELECT 1');

		expect(mockFetch).toHaveBeenCalledOnce();
		const [url, opts] = mockFetch.mock.calls[0];
		expect(url).toContain('acc123');
		expect(url).toContain('analytics_engine/sql');
		expect(opts.method).toBe('POST');
		expect(opts.headers.Authorization).toBe('Bearer token456');
		expect(opts.body).toBe('SELECT 1');
		expect(result.data).toHaveLength(1);
		expect(result.rows).toBe(1);
	});

	it('throws on non-ok response', async () => {
		mockFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
		await expect(queryAE('acc', 'bad-token', 'SELECT 1')).rejects.toThrow('AE SQL query failed (401)');
	});
});

describe('getActiveWorkers', () => {
	it('returns map of active workers with invocation counts', async () => {
		mockFetch.mockResolvedValue(new Response(JSON.stringify({
			data: [
				{ worker_name: 'worker-a', invocations: 100 },
				{ worker_name: 'worker-b', invocations: 50 },
			],
			meta: [],
			rows: 2,
		})));

		const active = await getActiveWorkers('acc', 'token');

		expect(active.size).toBe(2);
		expect(active.get('worker-a')).toBe(100);
		expect(active.get('worker-b')).toBe(50);
	});

	it('returns empty map when no workers are active', async () => {
		mockFetch.mockResolvedValue(new Response(JSON.stringify({
			data: [],
			meta: [],
			rows: 0,
		})));

		const active = await getActiveWorkers('acc', 'token');
		expect(active.size).toBe(0);
	});

	it('uses custom interval in SQL query', async () => {
		mockFetch.mockResolvedValue(new Response(JSON.stringify({
			data: [],
			meta: [],
			rows: 0,
		})));

		await getActiveWorkers('acc', 'token', 30);

		const body = mockFetch.mock.calls[0][1].body;
		expect(body).toContain("'30' MINUTE");
	});
});
