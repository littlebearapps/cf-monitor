import { describe, it, expect } from 'vitest';
import {
	checkFeatureCb,
	checkAccountCb,
	tripFeatureCb,
	resetFeatureCb,
} from '../../src/sdk/circuit-breaker.js';
import { KV } from '../../src/constants.js';
import { createMockKV } from '../helpers/mock-kv.js';

describe('checkFeatureCb', () => {
	it('returns GO when no KV entry exists', async () => {
		const kv = createMockKV();
		expect(await checkFeatureCb(kv, 'my-feature')).toBe('GO');
	});

	it('returns STOP when KV entry is STOP', async () => {
		const kv = createMockKV();
		await kv.put(`${KV.CB_FEATURE}my-feature`, 'STOP');
		expect(await checkFeatureCb(kv, 'my-feature')).toBe('STOP');
	});

	it('returns GO when KV entry has unexpected value', async () => {
		const kv = createMockKV();
		await kv.put(`${KV.CB_FEATURE}my-feature`, 'WARNING');
		expect(await checkFeatureCb(kv, 'my-feature')).toBe('GO');
	});

	it('returns GO (fail-open) when KV throws', async () => {
		const kv = createMockKV();
		kv.get = () => {
			throw new Error('KV unavailable');
		};
		expect(await checkFeatureCb(kv as any, 'my-feature')).toBe('GO');
	});
});

describe('checkAccountCb', () => {
	it('returns null when no CB entries', async () => {
		const kv = createMockKV();
		expect(await checkAccountCb(kv)).toBeNull();
	});

	it('returns 503 Response when global CB is true', async () => {
		const kv = createMockKV();
		await kv.put(KV.CB_GLOBAL, 'true');
		const resp = await checkAccountCb(kv);
		expect(resp).toBeInstanceOf(Response);
		expect(resp!.status).toBe(503);
		expect(resp!.headers.get('X-Circuit-Breaker')).toBe('active');
	});

	it('returns 503 Response when account CB is paused', async () => {
		const kv = createMockKV();
		await kv.put(KV.CB_ACCOUNT, 'paused');
		const resp = await checkAccountCb(kv);
		expect(resp).toBeInstanceOf(Response);
		expect(resp!.status).toBe(503);
	});

	it('returns null when account CB is active (not paused)', async () => {
		const kv = createMockKV();
		await kv.put(KV.CB_ACCOUNT, 'active');
		expect(await checkAccountCb(kv)).toBeNull();
	});

	it('returns null (fail-open) when KV throws', async () => {
		const kv = createMockKV();
		kv.get = () => {
			throw new Error('KV unavailable');
		};
		expect(await checkAccountCb(kv as any)).toBeNull();
	});
});

describe('tripFeatureCb', () => {
	it('writes STOP and reason with TTL', async () => {
		const kv = createMockKV();
		await tripFeatureCb(kv, 'my-feature', 'Budget exceeded', 3600);

		expect(await kv.get(`${KV.CB_FEATURE}my-feature`)).toBe('STOP');
		expect(await kv.get(`${KV.CB_FEATURE}my-feature:reason`)).toBe('Budget exceeded');
	});
});

describe('resetFeatureCb', () => {
	it('writes GO with TTL instead of deleting (faster propagation)', async () => {
		const kv = createMockKV();
		await kv.put(`${KV.CB_FEATURE}my-feature`, 'STOP');
		await kv.put(`${KV.CB_FEATURE}my-feature:reason`, 'test');

		await resetFeatureCb(kv, 'my-feature');

		// Status key should be 'GO' (not null) — forces KV cache invalidation
		expect(await kv.get(`${KV.CB_FEATURE}my-feature`)).toBe('GO');
		// Reason key is deleted (not read in hot path)
		expect(await kv.get(`${KV.CB_FEATURE}my-feature:reason`)).toBeNull();
	});

	it('checkFeatureCb returns GO after reset', async () => {
		const kv = createMockKV();
		await tripFeatureCb(kv, 'my-feature', 'Budget exceeded', 3600);
		expect(await checkFeatureCb(kv, 'my-feature')).toBe('STOP');

		await resetFeatureCb(kv, 'my-feature');
		expect(await checkFeatureCb(kv, 'my-feature')).toBe('GO');
	});
});
