import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGitHubIssue, type ErrorIssueParams } from '../../../src/worker/errors/github.js';
import { createMockMonitorWorkerEnv } from '../../helpers/mock-env.js';

function defaultParams(overrides?: Partial<ErrorIssueParams>): ErrorIssueParams {
	return {
		scriptName: 'my-worker',
		outcome: 'exception',
		priority: 'P1',
		fingerprint: 'abc12345',
		errorMessage: 'Something broke',
		errorName: 'Error',
		isTransient: false,
		accountName: 'test-account',
		...overrides,
	};
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
	mockFetch = vi.fn().mockResolvedValue(
		new Response(JSON.stringify({ html_url: 'https://github.com/test/repo/issues/42' }), {
			status: 201,
			headers: { 'Content-Type': 'application/json' },
		})
	);
	vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('createGitHubIssue', () => {
	it('creates issue with correct title format', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		await createGitHubIssue(env, defaultParams());

		const call = mockFetch.mock.calls[0];
		const body = JSON.parse(call[1].body);
		expect(body.title).toBe('[P1] my-worker: exception');
	});

	it('includes correct labels', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		await createGitHubIssue(env, defaultParams());

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.labels).toContain('cf:error:exception');
		expect(body.labels).toContain('cf:priority:p1');
	});

	it('adds cf:transient label when isTransient is true', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		await createGitHubIssue(env, defaultParams({ isTransient: true }));

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.labels).toContain('cf:transient');
	});

	it('returns issue URL on success', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		const url = await createGitHubIssue(env, defaultParams());
		expect(url).toBe('https://github.com/test/repo/issues/42');
	});

	it('returns null when GITHUB_REPO not configured', async () => {
		const env = createMockMonitorWorkerEnv();
		const url = await createGitHubIssue(env, defaultParams());
		expect(url).toBeNull();
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it('returns null when API returns non-200', async () => {
		mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		const url = await createGitHubIssue(env, defaultParams());
		expect(url).toBeNull();
	});

	it('returns null on fetch error', async () => {
		mockFetch.mockRejectedValueOnce(new Error('Network error'));

		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		const url = await createGitHubIssue(env, defaultParams());
		expect(url).toBeNull();
	});
});
