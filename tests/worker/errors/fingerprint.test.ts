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

	it('normalises timestamps to <TS> (#92 — regex ordering fix)', () => {
		// Timestamp regex now runs BEFORE numeric ID regex,
		// so full ISO timestamps are replaced as a unit.
		const a = computeFingerprint('w', 'exception', 'Error at 2025-03-20T14:30:00Z in handler');
		const b = computeFingerprint('w', 'exception', 'Error at 2026-04-01T09:00:00Z in handler');
		expect(a).toBe(b);
	});

	it('normalises timestamps with different times', () => {
		const a = computeFingerprint('w', 'exception', 'Failed at 2026-04-03T10:30:00.123Z');
		const b = computeFingerprint('w', 'exception', 'Failed at 2026-04-03T22:15:45.999Z');
		expect(a).toBe(b);
	});

	it('normalises short hex IDs (8+ chars) — catches correlationIds (#92)', () => {
		const a = computeFingerprint('w', 'exception', 'Error in request a1b2c3d4 failed');
		const b = computeFingerprint('w', 'exception', 'Error in request f9e8d7c6 failed');
		expect(a).toBe(b);
	});

	it('does not normalise short non-hex strings', () => {
		// "handler" contains only [a-f] + non-hex chars — word boundary check prevents false matches
		const a = computeFingerprint('w', 'exception', 'Error in module xyz123');
		const b = computeFingerprint('w', 'exception', 'Error in module abc456');
		// These differ because they're not pure hex
		expect(a).not.toBe(b);
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

	it('extracts message field from JSON structured logs (#92)', () => {
		const jsonA = JSON.stringify({
			level: 'error',
			message: 'AI Gateway request failed after all retries',
			timestamp: '2026-04-02T00:00:52.953Z',
			duration_ms: 9513,
			metadata: { totalAttempts: 4, correlationId: '83c4fec5-0f3e-4bdf-9abc-123456789012' },
		});
		const jsonB = JSON.stringify({
			level: 'error',
			message: 'AI Gateway request failed after all retries',
			timestamp: '2026-04-03T12:01:55.100Z',
			duration_ms: 3201,
			metadata: { totalAttempts: 2, correlationId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
		});
		const a = computeFingerprint('bc', 'exception', jsonA);
		const b = computeFingerprint('bc', 'exception', jsonB);
		expect(a).toBe(b);
	});

	it('falls back to regex normalisation for invalid JSON', () => {
		const truncated = '{"level":"error","message":"AI Gateway request failed","timestamp":"2026-04-02T00:00:52.953Z","duratio';
		const fp = computeFingerprint('w', 'exception', truncated);
		expect(fp).toMatch(/^[0-9a-f]{8}$/);
	});

	it('normalises JSON-embedded small numbers (#92)', () => {
		const a = computeFingerprint('w', 'exception', '"totalAttempts": 4, "retry": 1}');
		const b = computeFingerprint('w', 'exception', '"totalAttempts": 9, "retry": 3}');
		expect(a).toBe(b);
	});
});
