import { describe, it, expect } from 'vitest';
import { classifyR2Action } from '../../../src/worker/crons/r2-classification.js';

describe('classifyR2Action', () => {
	it('classifies reads/metadata as Class B', () => {
		expect(classifyR2Action('GetObject')).toBe('classB');
		expect(classifyR2Action('HeadObject')).toBe('classB');
	});

	it('classifies writes/mutations/bucket-listing as Class A', () => {
		expect(classifyR2Action('PutObject')).toBe('classA');
		expect(classifyR2Action('CopyObject')).toBe('classA');
		expect(classifyR2Action('CreateMultipartUpload')).toBe('classA');
		expect(classifyR2Action('UploadPart')).toBe('classA');
		expect(classifyR2Action('CompleteMultipartUpload')).toBe('classA');
		// `ListBuckets` (plural) lists the buckets in an account — Class A.
		expect(classifyR2Action('ListBuckets')).toBe('classA');
		expect(classifyR2Action('PutBucketCors')).toBe('classA');
		expect(classifyR2Action('PutBucketLifecycleConfiguration')).toBe('classA');
	});

	it('classifies delete/abort operations as free (non-billable)', () => {
		expect(classifyR2Action('DeleteObject')).toBe('free');
		expect(classifyR2Action('DeleteBucket')).toBe('free');
		expect(classifyR2Action('AbortMultipartUpload')).toBe('free');
	});

	it('classifies unrecognised, empty, or legacy-verb actions as unknown', () => {
		expect(classifyR2Action('FooBarOp')).toBe('unknown');
		expect(classifyR2Action('')).toBe('unknown');
		// Legacy lowercase verbs (pre-correction assumption) must NOT silently map to a class.
		expect(classifyR2Action('read')).toBe('unknown');
		expect(classifyR2Action('write')).toBe('unknown');
	});

	it('classifies ListBucket (singular) as unknown — ambiguous Class A vs Class B until Billing Read invoice settles it', () => {
		// `ListBucket` (singular, "list objects in a bucket") is the S3-IAM action whose Class A vs
		// Class B classification is genuinely ambiguous: the 2026-05-27 probe brief said Class B,
		// but Cloudflare R2 pricing docs may class the equivalent `ListObjects` as Class A.
		// "Prefer unknown over fake precision" — kept here as a regression guard.
		expect(classifyR2Action('ListBucket')).toBe('unknown');
	});
});
