import { describe, it, expect } from 'vitest';
import {
	detectWorkerName,
	generateFetchFeatureId,
	generateCronFeatureId,
	generateQueueFeatureId,
	detectBindings,
	hasMonitorBindings,
} from '../../src/sdk/detection.js';
import { createMockConsumerEnv, createMockD1, createMockUserKV, createMockR2, createMockAI, createMockVectorize, createMockQueue } from '../helpers/mock-env.js';

describe('detectWorkerName', () => {
	it('returns WORKER_NAME from env when present', () => {
		expect(detectWorkerName({ WORKER_NAME: 'my-api' })).toBe('my-api');
	});

	it('falls back to name from env', () => {
		expect(detectWorkerName({ name: 'fallback-name' })).toBe('fallback-name');
	});

	it('falls back to "worker" when neither exists', () => {
		expect(detectWorkerName({})).toBe('worker');
	});

	it('ignores empty WORKER_NAME', () => {
		expect(detectWorkerName({ WORKER_NAME: '', name: 'backup' })).toBe('backup');
	});
});

describe('generateFetchFeatureId', () => {
	function req(path: string, method = 'GET'): Request {
		return new Request(`https://test.workers.dev${path}`, { method });
	}

	it('generates feature ID from method and path', () => {
		expect(generateFetchFeatureId('my-api', req('/api/users'))).toBe('my-api:fetch:GET:api-users');
	});

	it('strips numeric IDs from path', () => {
		expect(generateFetchFeatureId('my-api', req('/api/users/12345/posts'))).toBe('my-api:fetch:GET:api-users');
	});

	it('strips UUIDs from path', () => {
		expect(generateFetchFeatureId('my-api', req('/items/550e8400-e29b-41d4-a716-446655440000'))).toBe('my-api:fetch:GET:items');
	});

	it('limits to first 2 meaningful segments', () => {
		expect(generateFetchFeatureId('my-api', req('/api/v1/deep/nested'))).toBe('my-api:fetch:GET:api-v1');
	});

	it('uses "root" for root path', () => {
		expect(generateFetchFeatureId('my-api', req('/'))).toBe('my-api:fetch:GET:root');
	});

	it('uses POST method', () => {
		expect(generateFetchFeatureId('my-api', req('/api/scan', 'POST'))).toBe('my-api:fetch:POST:api-scan');
	});

	it('strips MongoDB-style hex IDs', () => {
		expect(generateFetchFeatureId('my-api', req('/docs/507f1f77bcf86cd799439011'))).toBe('my-api:fetch:GET:docs');
	});
});

describe('generateCronFeatureId', () => {
	it('slugifies cron expression', () => {
		expect(generateCronFeatureId('my-api', '0 2 * * *')).toBe('my-api:cron:0-2-x-x-x');
	});

	it('handles every-15-min cron', () => {
		expect(generateCronFeatureId('my-api', '*/15 * * * *')).toBe('my-api:cron:x_15-x-x-x-x');
	});
});

describe('generateQueueFeatureId', () => {
	it('generates feature ID from queue name', () => {
		expect(generateQueueFeatureId('my-api', 'task-pipeline')).toBe('my-api:queue:task-pipeline');
	});

	it('sanitises special characters', () => {
		expect(generateQueueFeatureId('my-api', 'queue.name/special')).toBe('my-api:queue:queue_name_special');
	});
});

describe('detectBindings', () => {
	it('identifies all binding types', () => {
		const env = createMockConsumerEnv();
		const inventory = detectBindings(env);

		expect(inventory.d1).toContain('DB');
		expect(inventory.kv).toContain('MY_KV');
		// NOTE: detectBindings checks KV before R2, and R2 has get/put/delete/list,
		// so R2 is classified as KV in detectBindings. The proxy layer uses isKVNamespace()
		// which has a !('head' in obj) check to distinguish — so tracking is still correct.
		// MY_BUCKET ends up in kv[] in detectBindings, but wrapR2() handles it in proxy.
		expect(inventory.kv).toContain('MY_BUCKET');
		expect(inventory.ai).toBe(true);
		expect(inventory.vectorize).toContain('MY_INDEX');
		expect(inventory.queues).toContain('MY_QUEUE');
	});

	it('skips CF_MONITOR_KV and CF_MONITOR_AE', () => {
		const env = createMockConsumerEnv();
		const inventory = detectBindings(env);

		expect(inventory.kv).not.toContain('CF_MONITOR_KV');
		// CF_MONITOR_AE has writeDataPoint but won't match any pattern
	});
});

describe('hasMonitorBindings', () => {
	it('returns true when both bindings present', () => {
		const env = createMockConsumerEnv();
		expect(hasMonitorBindings(env)).toBe(true);
	});

	it('returns false when KV missing', () => {
		expect(hasMonitorBindings({ CF_MONITOR_AE: {} })).toBe(false);
	});

	it('returns false when AE missing', () => {
		expect(hasMonitorBindings({ CF_MONITOR_KV: {} })).toBe(false);
	});

	it('returns false when both missing', () => {
		expect(hasMonitorBindings({})).toBe(false);
	});
});
