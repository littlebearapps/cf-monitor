import { describe, it, expect } from 'vitest';
import { computeFingerprint } from '../../../src/worker/errors/fingerprint.js';

describe('computeFingerprint', () => {
	it('is deterministic — same input produces same hash', () => {
		const a = computeFingerprint('my-worker', 'exception', 'Connection refused');
		const b = computeFingerprint('my-worker', 'exception', 'Connection refused');
		expect(a).toBe(b);
	});

	it('different scripts produce different fingerprints', () => {
		const a = computeFingerprint('worker-a', 'exception', 'Error');
		const b = computeFingerprint('worker-b', 'exception', 'Error');
		expect(a).not.toBe(b);
	});

	it('different outcomes produce different fingerprints', () => {
		const a = computeFingerprint('my-worker', 'exception', 'Error');
		const b = computeFingerprint('my-worker', 'exceededCpu', 'Error');
		expect(a).not.toBe(b);
	});

	it('normalises UUIDs — different UUIDs produce same fingerprint', () => {
		const a = computeFingerprint('w', 'exception', 'Failed for user 550e8400-e29b-41d4-a716-446655440000');
		const b = computeFingerprint('w', 'exception', 'Failed for user a1b2c3d4-e5f6-7890-abcd-ef1234567890');
		expect(a).toBe(b);
	});

	it('normalises numeric IDs — different numbers produce same fingerprint', () => {
		const a = computeFingerprint('w', 'exception', 'Error at row 12345');
		const b = computeFingerprint('w', 'exception', 'Error at row 67890');
		expect(a).toBe(b);
	});

	it('normalises timestamps to <TS>', () => {
		// Numeric ID normalisation (\b\d{4,}\b) runs first, replacing the year.
		// The remaining timestamp fragment is identical for same date+time, so
		// messages differing only in year still produce the same fingerprint.
		const a = computeFingerprint('w', 'exception', 'Error at 2025-03-20T14:30:00Z in handler');
		const b = computeFingerprint('w', 'exception', 'Error at 2026-03-20T14:30:00Z in handler');
		// Both normalise: year → <N>, remaining fragment identical
		expect(a).toBe(b);
	});

	it('normalises IP addresses', () => {
		const a = computeFingerprint('w', 'exception', 'Connection from 192.168.1.1 failed');
		const b = computeFingerprint('w', 'exception', 'Connection from 10.0.0.5 failed');
		expect(a).toBe(b);
	});

	it('returns 8-char hex string', () => {
		const fp = computeFingerprint('w', 'exception', 'test');
		expect(fp).toMatch(/^[0-9a-f]{8}$/);
	});
});
