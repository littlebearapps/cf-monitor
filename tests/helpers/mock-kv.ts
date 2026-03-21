/// <reference types="@cloudflare/workers-types" />

/**
 * In-memory KV mock with TTL simulation.
 * Faithfully models the KVNamespace interface for unit testing.
 */

interface MockKVEntry {
	value: string;
	expiresAt: number | null;
}

export interface MockKV extends KVNamespace {
	/** Direct access to the store for test assertions. */
	_store: Map<string, MockKVEntry>;
	/** Advance simulated time by ms (causes TTL-expired entries to be invisible). */
	_advanceTime: (ms: number) => void;
	/** Reset the store. */
	_reset: () => void;
}

export function createMockKV(): MockKV {
	const store = new Map<string, MockKVEntry>();
	let timeOffset = 0;

	function now(): number {
		return Date.now() + timeOffset;
	}

	function isExpired(entry: MockKVEntry): boolean {
		return entry.expiresAt !== null && now() >= entry.expiresAt;
	}

	const kv = {
		_store: store,
		_advanceTime: (ms: number) => {
			timeOffset += ms;
		},
		_reset: () => {
			store.clear();
			timeOffset = 0;
		},

		async get(key: string, typeOrOpts?: unknown): Promise<string | null | unknown> {
			const entry = store.get(key);
			if (!entry || isExpired(entry)) return null;

			const type = typeof typeOrOpts === 'string' ? typeOrOpts : (typeOrOpts as Record<string, unknown>)?.type;
			if (type === 'json') return JSON.parse(entry.value);
			if (type === 'arrayBuffer') return new TextEncoder().encode(entry.value).buffer;
			if (type === 'stream') return new ReadableStream();
			return entry.value;
		},

		async getWithMetadata(key: string): Promise<{ value: string | null; metadata: unknown }> {
			const entry = store.get(key);
			if (!entry || isExpired(entry)) return { value: null, metadata: null };
			return { value: entry.value, metadata: null };
		},

		async put(key: string, value: string, opts?: { expirationTtl?: number; expiration?: number; metadata?: unknown }): Promise<void> {
			let expiresAt: number | null = null;
			if (opts?.expirationTtl) {
				expiresAt = now() + opts.expirationTtl * 1000;
			} else if (opts?.expiration) {
				expiresAt = opts.expiration * 1000;
			}
			store.set(key, { value, expiresAt });
		},

		async delete(key: string): Promise<void> {
			store.delete(key);
		},

		async list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
			keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
			list_complete: boolean;
			cursor?: string;
		}> {
			const prefix = opts?.prefix ?? '';
			const limit = opts?.limit ?? 1000;
			const keys: Array<{ name: string }> = [];

			for (const [key, entry] of store) {
				if (key.startsWith(prefix) && !isExpired(entry)) {
					keys.push({ name: key });
					if (keys.length >= limit) break;
				}
			}

			return { keys, list_complete: keys.length < limit };
		},
	} as unknown as MockKV;

	return kv;
}
