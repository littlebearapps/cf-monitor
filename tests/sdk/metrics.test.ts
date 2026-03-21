import { describe, it, expect } from 'vitest';
import { createMetrics, isZero, toDataPoint } from '../../src/sdk/metrics.js';
import { AE_FIELDS } from '../../src/constants.js';

describe('createMetrics', () => {
	it('returns zeroed accumulator with requests = 1', () => {
		const m = createMetrics();
		expect(m.requests).toBe(1);
		expect(m.d1Writes).toBe(0);
		expect(m.d1Reads).toBe(0);
		expect(m.kvReads).toBe(0);
		expect(m.kvWrites).toBe(0);
		expect(m.aiRequests).toBe(0);
		expect(m.r2ClassA).toBe(0);
		expect(m.errorCount).toBe(0);
	});
});

describe('isZero', () => {
	it('returns true for fresh metrics (only requests is non-zero)', () => {
		expect(isZero(createMetrics())).toBe(true);
	});

	it('returns false when d1Writes > 0', () => {
		const m = createMetrics();
		m.d1Writes = 1;
		expect(isZero(m)).toBe(false);
	});

	it('returns false when kvReads > 0', () => {
		const m = createMetrics();
		m.kvReads = 1;
		expect(isZero(m)).toBe(false);
	});

	it('returns false when queueMessages > 0', () => {
		const m = createMetrics();
		m.queueMessages = 1;
		expect(isZero(m)).toBe(false);
	});
});

describe('toDataPoint', () => {
	it('maps metrics to correct AE doubles positions', () => {
		const m = createMetrics();
		m.d1Writes = 10;
		m.kvReads = 5;
		m.aiNeurons = 100;

		const dp = toDataPoint('my-worker', 'my-worker:fetch:GET:api', m);

		expect(dp.doubles[AE_FIELDS.d1Writes]).toBe(10);
		expect(dp.doubles[AE_FIELDS.kvReads]).toBe(5);
		expect(dp.doubles[AE_FIELDS.aiNeurons]).toBe(100);
		expect(dp.doubles[AE_FIELDS.requests]).toBe(1);
		expect(dp.doubles).toHaveLength(20);
	});

	it('parses featureId into blob fields', () => {
		const dp = toDataPoint('my-worker', 'my-worker:fetch:GET:api-users', createMetrics());

		expect(dp.blobs[0]).toBe('my-worker');
		expect(dp.blobs[1]).toBe('fetch');
		expect(dp.blobs[2]).toBe('GET:api-users');
		expect(dp.indexes[0]).toBe('my-worker:fetch:GET:api-users');
	});

	it('handles featureId with only 2 parts', () => {
		const dp = toDataPoint('worker', 'worker:cron', createMetrics());

		expect(dp.blobs[1]).toBe('cron');
		expect(dp.blobs[2]).toBe('unknown');
	});
});
