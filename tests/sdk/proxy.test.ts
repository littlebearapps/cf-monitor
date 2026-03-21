import { describe, it, expect } from 'vitest';
import { createTrackedEnv, getTrackingInfo } from '../../src/sdk/proxy.js';
import { RequestBudgetExceededError } from '../../src/types.js';
import { createMockConsumerEnv } from '../helpers/mock-env.js';

function tracked(limits?: Record<string, number>) {
	const env = createMockConsumerEnv();
	const te = createTrackedEnv(env, 'test:fetch:GET:api', 'test-worker', limits);
	return { env, te, metrics: () => getTrackingInfo(te).metrics };
}

describe('D1 proxy', () => {
	it('prepare().first() increments d1Reads', async () => {
		const { te, metrics } = tracked();
		await (te as any).DB.prepare('SELECT 1').first();
		expect(metrics().d1Reads).toBe(1);
	});

	it('prepare().all() increments d1Reads', async () => {
		const { te, metrics } = tracked();
		await (te as any).DB.prepare('SELECT 1').all();
		expect(metrics().d1Reads).toBe(1);
	});

	it('prepare().raw() increments d1Reads', async () => {
		const { te, metrics } = tracked();
		await (te as any).DB.prepare('SELECT 1').raw();
		expect(metrics().d1Reads).toBe(1);
	});

	it('prepare().run() increments d1Writes', async () => {
		const { te, metrics } = tracked();
		await (te as any).DB.prepare('INSERT INTO t VALUES(1)').run();
		expect(metrics().d1Writes).toBe(1);
	});

	it('prepare().bind().run() increments d1Writes (chained)', async () => {
		const { te, metrics } = tracked();
		await (te as any).DB.prepare('INSERT INTO t VALUES(?)').bind(1).run();
		expect(metrics().d1Writes).toBe(1);
	});

	it('batch() increments d1Writes by statement count', async () => {
		const { te, metrics } = tracked();
		const stmts = [{}, {}, {}]; // 3 statements
		await (te as any).DB.batch(stmts);
		expect(metrics().d1Writes).toBe(3);
	});

	it('exec() increments d1Writes', async () => {
		const { te, metrics } = tracked();
		await (te as any).DB.exec('CREATE TABLE t(id INT)');
		expect(metrics().d1Writes).toBe(1);
	});

	it('tracks d1RowsRead from result metadata', async () => {
		const { te, metrics } = tracked();
		await (te as any).DB.prepare('SELECT *').first();
		expect(metrics().d1RowsRead).toBe(1);
	});

	it('tracks d1RowsWritten from run result metadata', async () => {
		const { te, metrics } = tracked();
		await (te as any).DB.prepare('INSERT').run();
		expect(metrics().d1RowsWritten).toBe(1);
	});
});

describe('KV proxy', () => {
	it('get() increments kvReads', async () => {
		const { te, metrics } = tracked();
		await (te as any).MY_KV.get('key');
		expect(metrics().kvReads).toBe(1);
	});

	it('getWithMetadata() increments kvReads', async () => {
		const { te, metrics } = tracked();
		await (te as any).MY_KV.getWithMetadata('key');
		expect(metrics().kvReads).toBe(1);
	});

	it('put() increments kvWrites', async () => {
		const { te, metrics } = tracked();
		await (te as any).MY_KV.put('key', 'value');
		expect(metrics().kvWrites).toBe(1);
	});

	it('delete() increments kvDeletes', async () => {
		const { te, metrics } = tracked();
		await (te as any).MY_KV.delete('key');
		expect(metrics().kvDeletes).toBe(1);
	});

	it('list() increments kvLists', async () => {
		const { te, metrics } = tracked();
		await (te as any).MY_KV.list();
		expect(metrics().kvLists).toBe(1);
	});
});

describe('R2 proxy', () => {
	it('put() increments r2ClassA', async () => {
		const { te, metrics } = tracked();
		await (te as any).MY_BUCKET.put('key', 'data');
		expect(metrics().r2ClassA).toBe(1);
	});

	it('delete() increments r2ClassA', async () => {
		const { te, metrics } = tracked();
		await (te as any).MY_BUCKET.delete('key');
		expect(metrics().r2ClassA).toBe(1);
	});

	it('get() increments r2ClassB', async () => {
		const { te, metrics } = tracked();
		await (te as any).MY_BUCKET.get('key');
		expect(metrics().r2ClassB).toBe(1);
	});

	it('head() increments r2ClassB', async () => {
		const { te, metrics } = tracked();
		await (te as any).MY_BUCKET.head('key');
		expect(metrics().r2ClassB).toBe(1);
	});

	it('list() increments r2ClassB', async () => {
		const { te, metrics } = tracked();
		await (te as any).MY_BUCKET.list();
		expect(metrics().r2ClassB).toBe(1);
	});
});

describe('AI proxy', () => {
	it('run() increments aiRequests', async () => {
		const { te, metrics } = tracked();
		await (te as any).AI.run('model', {});
		expect(metrics().aiRequests).toBe(1);
	});
});

describe('Vectorize proxy', () => {
	it('query() increments vectorizeQueries', async () => {
		const { te, metrics } = tracked();
		await (te as any).MY_INDEX.query([1, 2, 3]);
		expect(metrics().vectorizeQueries).toBe(1);
	});

	it('insert() increments vectorizeInserts', async () => {
		const { te, metrics } = tracked();
		await (te as any).MY_INDEX.insert([]);
		expect(metrics().vectorizeInserts).toBe(1);
	});

	it('upsert() increments vectorizeInserts', async () => {
		const { te, metrics } = tracked();
		await (te as any).MY_INDEX.upsert([]);
		expect(metrics().vectorizeInserts).toBe(1);
	});
});

describe('Queue proxy', () => {
	it('send() increments queueMessages by 1', async () => {
		const { te, metrics } = tracked();
		await (te as any).MY_QUEUE.send({ data: 'test' });
		expect(metrics().queueMessages).toBe(1);
	});

	it('sendBatch() increments queueMessages by batch length', async () => {
		const { te, metrics } = tracked();
		await (te as any).MY_QUEUE.sendBatch([{ body: 'a' }, { body: 'b' }]);
		expect(metrics().queueMessages).toBe(2);
	});
});

describe('RequestLimits enforcement', () => {
	it('throws RequestBudgetExceededError when d1Writes exceeds limit', async () => {
		const { te } = tracked({ d1Writes: 1 });
		await (te as any).DB.prepare('INSERT').run(); // d1Writes = 1
		await expect((te as any).DB.prepare('INSERT').run()).rejects.toThrow(RequestBudgetExceededError);
	});

	it('throws RequestBudgetExceededError when kvWrites exceeds limit', async () => {
		const { te } = tracked({ kvWrites: 1 });
		// First put: kvWrites = 1, check 1 > 1 = false (allowed)
		await (te as any).MY_KV.put('k1', 'v1');
		// Second put: kvWrites = 2, check 2 > 1 = true (throws synchronously)
		expect(() => (te as any).MY_KV.put('k2', 'v2')).toThrow(RequestBudgetExceededError);
	});

	it('throws RequestBudgetExceededError when aiRequests exceeds limit', async () => {
		const { te } = tracked({ aiRequests: 1 });
		await (te as any).AI.run('model', {}); // aiRequests = 1
		await expect((te as any).AI.run('model', {})).rejects.toThrow(RequestBudgetExceededError);
	});
});

describe('monitor binding skip', () => {
	it('CF_MONITOR_KV is NOT proxied', async () => {
		const { env, te, metrics } = tracked();
		// Access the monitor KV binding — it should be the raw mock, not tracked
		const monitorKv = (te as any).CF_MONITOR_KV;
		expect(monitorKv).toBe(env.CF_MONITOR_KV);
		await monitorKv.get('test');
		// kvReads should NOT have incremented
		expect(metrics().kvReads).toBe(0);
	});

	it('CF_MONITOR_AE is NOT proxied', () => {
		const { env, te } = tracked();
		expect((te as any).CF_MONITOR_AE).toBe(env.CF_MONITOR_AE);
	});
});
