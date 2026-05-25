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

describe('enriched issue body', () => {
	it('includes stack trace when provided', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		await createGitHubIssue(env, defaultParams({
			stackTrace: 'Error: Something broke\n    at handler (worker.js:42:10)',
		}));

		const body = JSON.parse(mockFetch.mock.calls[0][1].body).body as string;
		expect(body).toContain('### Stack Trace');
		expect(body).toContain('worker.js:42:10');
	});

	it('includes CPU and wall time when provided', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		await createGitHubIssue(env, defaultParams({
			cpuTimeMs: 42,
			wallTimeMs: 1250,
		}));

		const body = JSON.parse(mockFetch.mock.calls[0][1].body).body as string;
		expect(body).toContain('42ms');
		expect(body).toContain('1250ms');
	});

	it('includes event type for fetch handlers', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		await createGitHubIssue(env, defaultParams({
			eventType: 'fetch',
			requestUrl: 'https://api.example.com/data',
			requestMethod: 'POST',
			responseStatus: 500,
		}));

		const body = JSON.parse(mockFetch.mock.calls[0][1].body).body as string;
		expect(body).toContain('Fetch');
		expect(body).toContain('POST');
		expect(body).toContain('api.example.com');
		expect(body).toContain('HTTP 500');
	});

	it('includes event type for scheduled handlers with cron', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		await createGitHubIssue(env, defaultParams({
			eventType: 'scheduled',
			cronExpression: '0 2 * * *',
		}));

		const body = JSON.parse(mockFetch.mock.calls[0][1].body).body as string;
		expect(body).toContain('Scheduled');
		expect(body).toContain('0 2 * * *');
	});

	it('includes event type for queue handlers', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		await createGitHubIssue(env, defaultParams({
			eventType: 'queue',
			queueName: 'telemetry-queue',
			queueBatchSize: 25,
		}));

		const body = JSON.parse(mockFetch.mock.calls[0][1].body).body as string;
		expect(body).toContain('Queue');
		expect(body).toContain('telemetry-queue');
		expect(body).toContain('batch: 25');
	});

	it('includes log history table when provided', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		const baseTime = 1700000000000;
		await createGitHubIssue(env, defaultParams({
			eventTimestamp: baseTime,
			logHistory: [
				{ level: 'info', message: 'Starting handler', timestamp: baseTime + 10 },
				{ level: 'error', message: 'Database failed', timestamp: baseTime + 50 },
			],
		}));

		const body = JSON.parse(mockFetch.mock.calls[0][1].body).body as string;
		expect(body).toContain('### Logs');
		expect(body).toContain('info');
		expect(body).toContain('Starting handler');
		expect(body).toContain('error');
		expect(body).toContain('Database failed');
	});

	it('includes truncation warning when logs were truncated', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		await createGitHubIssue(env, defaultParams({ truncated: true }));

		const body = JSON.parse(mockFetch.mock.calls[0][1].body).body as string;
		expect(body).toContain('truncated by Cloudflare');
		expect(body).toContain('256KB');
	});

	it('includes dashboard links when cfAccountId provided', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		await createGitHubIssue(env, defaultParams({
			cfAccountId: '55a0bf6d1396d90cbf9dcbf30fceeb14',
		}));

		const body = JSON.parse(mockFetch.mock.calls[0][1].body).body as string;
		expect(body).toContain('### Investigation');
		expect(body).toContain('dash.cloudflare.com/55a0bf6d1396d90cbf9dcbf30fceeb14');
		expect(body).toContain('my-worker');
	});

	it('uses event timestamp instead of capture time when available', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		const eventTime = new Date('2026-04-15T07:00:00.000Z').getTime();
		await createGitHubIssue(env, defaultParams({
			eventTimestamp: eventTime,
		}));

		const body = JSON.parse(mockFetch.mock.calls[0][1].body).body as string;
		expect(body).toContain('2026-04-15T07:00:00.000Z');
	});

	it('formats JSON error messages readably', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		const jsonMsg = JSON.stringify({
			level: 'error',
			message: 'Cloudflare API error',
			context: { status: 429, account: 'scout' },
		});

		await createGitHubIssue(env, defaultParams({
			errorMessage: jsonMsg,
		}));

		const body = JSON.parse(mockFetch.mock.calls[0][1].body).body as string;
		expect(body).toContain('Cloudflare API error');
		expect(body).toContain('429');
	});

	it('includes execution model when provided', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		await createGitHubIssue(env, defaultParams({
			executionModel: 'modules',
		}));

		const body = JSON.parse(mockFetch.mock.calls[0][1].body).body as string;
		expect(body).toContain('modules');
	});

	it('includes DO ID when provided', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		await createGitHubIssue(env, defaultParams({
			durableObjectId: 'abc123-do-id',
		}));

		const body = JSON.parse(mockFetch.mock.calls[0][1].body).body as string;
		expect(body).toContain('DO ID');
		expect(body).toContain('abc123-do-id');
	});

	it('omits optional sections when data not available', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		await createGitHubIssue(env, defaultParams());

		const body = JSON.parse(mockFetch.mock.calls[0][1].body).body as string;
		expect(body).not.toContain('### Stack Trace');
		expect(body).not.toContain('### Logs');
		expect(body).not.toContain('### Investigation');
		expect(body).not.toContain('truncated');
		expect(body).not.toContain('CPU');
	});

	it('caps stack trace at 2000 characters', async () => {
		const env = createMockMonitorWorkerEnv({
			GITHUB_REPO: 'owner/repo',
			GITHUB_TOKEN: 'ghp_test',
		});

		const longStack = 'Error: big\n' + '    at line (file.js:1:1)\n'.repeat(200);
		await createGitHubIssue(env, defaultParams({
			stackTrace: longStack,
		}));

		const body = JSON.parse(mockFetch.mock.calls[0][1].body).body as string;
		expect(body).toContain('(truncated)');
	});
});
