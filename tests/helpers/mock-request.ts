/// <reference types="@cloudflare/workers-types" />

import { vi } from 'vitest';

/**
 * Create a test Request object.
 */
export function createRequest(
	path: string,
	method = 'GET',
	opts?: { headers?: Record<string, string>; body?: string }
): Request {
	return new Request(`https://test.workers.dev${path}`, {
		method,
		headers: opts?.headers,
		body: opts?.body,
	});
}

/**
 * Create a mock ExecutionContext with accessible waitUntil promises.
 */
export function createMockCtx(): ExecutionContext & {
	_waitUntilPromises: Promise<unknown>[];
	_flush: () => Promise<unknown[]>;
} {
	const waitUntilPromises: Promise<unknown>[] = [];

	return {
		waitUntil: (p: Promise<unknown>) => {
			waitUntilPromises.push(p);
		},
		passThroughOnException: () => {},
		props: {},
		_waitUntilPromises: waitUntilPromises,
		_flush: () => Promise.all(waitUntilPromises),
	} as unknown as ExecutionContext & {
		_waitUntilPromises: Promise<unknown>[];
		_flush: () => Promise<unknown[]>;
	};
}

/**
 * Create a mock ScheduledController.
 */
export function createMockScheduledController(cron: string): ScheduledController {
	return {
		cron,
		scheduledTime: Date.now(),
		noRetry: vi.fn(),
	} as unknown as ScheduledController;
}

/**
 * Create a mock MessageBatch for queue handler tests.
 */
export function createMockMessageBatch(
	queue: string,
	messages: unknown[] = []
): MessageBatch<unknown> {
	return {
		queue,
		messages: messages.map((body, i) => ({
			id: `msg-${i}`,
			timestamp: new Date(),
			body,
			ack: vi.fn(),
			retry: vi.fn(),
		})),
		ackAll: vi.fn(),
		retryAll: vi.fn(),
	} as unknown as MessageBatch<unknown>;
}
