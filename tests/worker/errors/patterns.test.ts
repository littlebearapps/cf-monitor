import { describe, it, expect } from 'vitest';
import { matchTransientPattern, getTransientPatternName } from '../../../src/worker/errors/patterns.js';
import type { CustomTransientPattern } from '../../../src/types.js';

describe('matchTransientPattern', () => {
	it('matches rate limit errors', () => {
		expect(matchTransientPattern('rate limit exceeded', 'exception')).toBe(true);
		expect(matchTransientPattern('429 Too Many Requests', 'exception')).toBe(true);
		expect(matchTransientPattern('too many requests', 'exception')).toBe(true);
	});

	it('matches timeout errors', () => {
		expect(matchTransientPattern('request timed out', 'exception')).toBe(true);
		expect(matchTransientPattern('ETIMEDOUT', 'exception')).toBe(true);
		expect(matchTransientPattern('connection timeout', 'exception')).toBe(true);
	});

	it('matches quota errors', () => {
		expect(matchTransientPattern('quota exceeded', 'exception')).toBe(true);
		expect(matchTransientPattern('exceeded daily limit', 'exception')).toBe(true);
		expect(matchTransientPattern('billing issue', 'exception')).toBe(true);
	});

	it('matches connection refused', () => {
		expect(matchTransientPattern('ECONNREFUSED', 'exception')).toBe(true);
		expect(matchTransientPattern('connection was refused', 'exception')).toBe(true);
	});

	it('matches DNS failures', () => {
		expect(matchTransientPattern('ENOTFOUND', 'exception')).toBe(true);
		expect(matchTransientPattern('DNS lookup failed', 'exception')).toBe(true);
		expect(matchTransientPattern('getaddrinfo ENOTFOUND', 'exception')).toBe(true);
	});

	it('matches service unavailable via outcome', () => {
		expect(matchTransientPattern('any message', 'canceled')).toBe(true);
		expect(matchTransientPattern('any message', 'responseStreamDisconnected')).toBe(true);
	});

	it('matches service unavailable via message', () => {
		expect(matchTransientPattern('503 Service Unavailable', 'exception')).toBe(true);
		expect(matchTransientPattern('502 Bad Gateway', 'exception')).toBe(true);
	});

	it('matches CF internal errors', () => {
		expect(matchTransientPattern('Cloudflare internal error occurred', 'exception')).toBe(true);
	});

	it('matches billing-exhausted errors (#92)', () => {
		expect(matchTransientPattern('DeepSeek API error: 402 Insufficient Balance', 'exception')).toBe(true);
		expect(matchTransientPattern('402 Payment Required', 'exception')).toBe(true);
		expect(matchTransientPattern('insufficient balance on account', 'exception')).toBe(true);
		expect(matchTransientPattern('payment required for this API', 'exception')).toBe(true);
	});

	it('matches custom patterns from cf-monitor.yaml (#92)', () => {
		const customPatterns: CustomTransientPattern[] = [
			{ name: 'custom-error', match: 'my-special-error|custom_failure' },
		];
		expect(matchTransientPattern('my-special-error occurred', 'exception', customPatterns)).toBe(true);
		expect(matchTransientPattern('custom_failure in handler', 'exception', customPatterns)).toBe(true);
	});

	it('returns false for custom patterns when message does not match', () => {
		const customPatterns: CustomTransientPattern[] = [
			{ name: 'custom-error', match: 'my-special-error' },
		];
		expect(matchTransientPattern('NullPointerException', 'exception', customPatterns)).toBe(false);
	});

	it('works without custom patterns (backward compatible)', () => {
		expect(matchTransientPattern('rate limit exceeded', 'exception')).toBe(true);
		expect(matchTransientPattern('rate limit exceeded', 'exception', undefined)).toBe(true);
		expect(matchTransientPattern('rate limit exceeded', 'exception', [])).toBe(true);
	});

	it('returns false for non-transient errors', () => {
		expect(matchTransientPattern('NullPointerException', 'exception')).toBe(false);
		expect(matchTransientPattern('TypeError: Cannot read properties of undefined', 'exception')).toBe(false);
		expect(matchTransientPattern('ReferenceError: x is not defined', 'exception')).toBe(false);
	});
});

describe('getTransientPatternName', () => {
	it('returns correct pattern name for rate limit', () => {
		expect(getTransientPatternName('rate limit exceeded', 'exception')).toBe('rate-limited');
	});

	it('returns correct pattern name for timeout', () => {
		expect(getTransientPatternName('ETIMEDOUT', 'exception')).toBe('timeout');
	});

	it('returns correct pattern name for quota', () => {
		expect(getTransientPatternName('quota exceeded', 'exception')).toBe('quota-exhausted');
	});

	it('returns correct pattern name for billing-exhausted (#92)', () => {
		expect(getTransientPatternName('DeepSeek API error: 402 Insufficient Balance', 'exception')).toBe('billing-exhausted');
	});

	it('returns custom pattern name (#92)', () => {
		const customPatterns: CustomTransientPattern[] = [
			{ name: 'my-custom', match: 'special-error' },
		];
		expect(getTransientPatternName('special-error in handler', 'exception', customPatterns)).toBe('my-custom');
	});

	it('prefers built-in over custom pattern', () => {
		const customPatterns: CustomTransientPattern[] = [
			{ name: 'custom-timeout', match: 'timeout' },
		];
		// Built-in 'timeout' pattern should win
		expect(getTransientPatternName('connection timeout', 'exception', customPatterns)).toBe('timeout');
	});

	it('returns null for non-transient errors', () => {
		expect(getTransientPatternName('NullPointerException', 'exception')).toBeNull();
	});
});
