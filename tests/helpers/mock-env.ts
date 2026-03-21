/// <reference types="@cloudflare/workers-types" />

import { vi } from 'vitest';
import type { MonitorWorkerEnv } from '../../src/types.js';
import { createMockKV, type MockKV } from './mock-kv.js';
import { createMockAE, type MockAE } from './mock-ae.js';

// =============================================================================
// MONITOR WORKER ENV (for worker tests)
// =============================================================================

export interface MockMonitorWorkerEnv extends MonitorWorkerEnv {
	CF_MONITOR_KV: MockKV;
	CF_MONITOR_AE: MockAE;
}

export function createMockMonitorWorkerEnv(
	overrides?: Partial<MonitorWorkerEnv>
): MockMonitorWorkerEnv {
	return {
		CF_MONITOR_KV: createMockKV(),
		CF_MONITOR_AE: createMockAE(),
		CF_ACCOUNT_ID: 'test-account-id',
		ACCOUNT_NAME: 'test-account',
		GITHUB_REPO: undefined,
		GITHUB_TOKEN: undefined,
		SLACK_WEBHOOK_URL: undefined,
		CLOUDFLARE_API_TOKEN: undefined,
		GATUS_HEARTBEAT_URL: undefined,
		GATUS_TOKEN: undefined,
		...overrides,
	} as MockMonitorWorkerEnv;
}

// =============================================================================
// CONSUMER WORKER ENV (for SDK tests)
// =============================================================================

export interface MockConsumerEnv {
	CF_MONITOR_KV: MockKV;
	CF_MONITOR_AE: MockAE;
	WORKER_NAME: string;
	DB: ReturnType<typeof createMockD1>;
	MY_KV: ReturnType<typeof createMockUserKV>;
	MY_BUCKET: ReturnType<typeof createMockR2>;
	AI: ReturnType<typeof createMockAI>;
	MY_INDEX: ReturnType<typeof createMockVectorize>;
	MY_QUEUE: ReturnType<typeof createMockQueue>;
	MY_DO: ReturnType<typeof createMockDurableObjectNamespace>;
	MY_WORKFLOW: ReturnType<typeof createMockWorkflow>;
}

export function createMockConsumerEnv(
	overrides?: Partial<MockConsumerEnv>
): MockConsumerEnv {
	return {
		CF_MONITOR_KV: createMockKV(),
		CF_MONITOR_AE: createMockAE(),
		WORKER_NAME: 'test-worker',
		DB: createMockD1(),
		MY_KV: createMockUserKV(),
		MY_BUCKET: createMockR2(),
		AI: createMockAI(),
		MY_INDEX: createMockVectorize(),
		MY_QUEUE: createMockQueue(),
		MY_DO: createMockDurableObjectNamespace(),
		MY_WORKFLOW: createMockWorkflow(),
		...overrides,
	};
}

// =============================================================================
// MOCK BINDINGS (duck-typing compatible with detection.ts)
// =============================================================================

/** Mock D1 — has prepare/batch/exec (matches isD1Database check). */
export function createMockD1() {
	const mockStmt = {
		bind: vi.fn().mockReturnThis(),
		first: vi.fn().mockResolvedValue({ meta: { rows_read: 1, rows_written: 0 } }),
		all: vi.fn().mockResolvedValue({ results: [], meta: { rows_read: 5, rows_written: 0 } }),
		raw: vi.fn().mockResolvedValue([]),
		run: vi.fn().mockResolvedValue({ meta: { rows_read: 0, rows_written: 1 } }),
	};

	return {
		prepare: vi.fn().mockReturnValue(mockStmt),
		batch: vi.fn().mockResolvedValue([]),
		exec: vi.fn().mockResolvedValue(undefined),
		dump: vi.fn(),
		_stmt: mockStmt,
	};
}

/** Mock KV (user's KV, not monitor's) — has get/put/delete/list but NOT head (matches isKVNamespace). */
export function createMockUserKV() {
	return {
		get: vi.fn().mockResolvedValue(null),
		getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
		put: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
	};
}

/** Mock R2 — has get/put/head/delete/list (matches isR2Bucket — has 'head'). */
export function createMockR2() {
	return {
		get: vi.fn().mockResolvedValue(null),
		put: vi.fn().mockResolvedValue(null),
		head: vi.fn().mockResolvedValue(null),
		delete: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue({ objects: [] }),
		createMultipartUpload: vi.fn().mockResolvedValue({}),
		resumeMultipartUpload: vi.fn().mockResolvedValue({}),
	};
}

/** Mock AI — has run() but NOT get (matches isAiBinding). */
export function createMockAI() {
	return {
		run: vi.fn().mockResolvedValue({ response: 'test' }),
	};
}

/** Mock Vectorize — has query/insert/upsert (matches isVectorize). */
export function createMockVectorize() {
	return {
		query: vi.fn().mockResolvedValue({ matches: [] }),
		insert: vi.fn().mockResolvedValue({ count: 1 }),
		upsert: vi.fn().mockResolvedValue({ count: 1 }),
		getByIds: vi.fn().mockResolvedValue([]),
		deleteByIds: vi.fn().mockResolvedValue({ count: 0 }),
		describe: vi.fn().mockResolvedValue({}),
	};
}

/** Mock Queue — has send/sendBatch (matches isQueue). */
export function createMockQueue() {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		sendBatch: vi.fn().mockResolvedValue(undefined),
	};
}

/** Mock Durable Object Namespace — has get/idFromName/idFromString (matches isDurableObjectNamespace). */
export function createMockDurableObjectNamespace() {
	const mockStub = {
		fetch: vi.fn().mockResolvedValue(new Response('ok')),
		id: { toString: () => 'test-id' },
		name: 'test-do',
	};

	return {
		get: vi.fn().mockReturnValue(mockStub),
		idFromName: vi.fn().mockReturnValue({ toString: () => 'test-id' }),
		idFromString: vi.fn().mockReturnValue({ toString: () => 'test-id' }),
		newUniqueId: vi.fn().mockReturnValue({ toString: () => 'new-id' }),
		_stub: mockStub,
	};
}

/** Mock Workflow — has create/get but NOT put (matches isWorkflow). */
export function createMockWorkflow() {
	return {
		create: vi.fn().mockResolvedValue({ id: 'wf-123' }),
		get: vi.fn().mockResolvedValue({ id: 'wf-123', status: 'running' }),
	};
}
