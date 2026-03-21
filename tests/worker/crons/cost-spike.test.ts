import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectCostSpikes } from '../../../src/worker/crons/cost-spike.js';
import { createMockMonitorWorkerEnv, type MockMonitorWorkerEnv } from '../../helpers/mock-env.js';

// Mock slack alerts
vi.mock('../../../src/worker/alerts/slack.js', () => ({
	sendSlackAlert: vi.fn().mockResolvedValue(true),
}));

import { sendSlackAlert } from '../../../src/worker/alerts/slack.js';

// Mock AE client
vi.mock('../../../src/worker/ae-client.js', () => ({
	queryAE: vi.fn(),
}));

import { queryAE } from '../../../src/worker/ae-client.js';

let env: MockMonitorWorkerEnv;

beforeEach(() => {
	vi.clearAllMocks();
	env = createMockMonitorWorkerEnv({
		SLACK_WEBHOOK_URL: 'https://hooks.slack.com/test',
		CLOUDFLARE_API_TOKEN: 'test-token',
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function mockAEResponse(hours: number, data: Record<string, unknown>[]) {
	vi.mocked(queryAE).mockImplementation(async (_acc, _token, sql) => {
		const match = sql.match(/'(\d+)' HOUR/);
		const requestedHours = match ? parseInt(match[1]) : 0;
		if (requestedHours === hours) {
			return { data, meta: [], rows: data.length };
		}
		return { data: [], meta: [], rows: 0 };
	});
}

describe('detectCostSpikes (#15)', () => {
	it('does nothing when no API token configured', async () => {
		delete (env as Record<string, unknown>).CLOUDFLARE_API_TOKEN;
		await detectCostSpikes(env);
		expect(queryAE).not.toHaveBeenCalled();
	});

	it('does nothing when current hour has no data', async () => {
		vi.mocked(queryAE).mockResolvedValue({ data: [], meta: [], rows: 0 });
		await detectCostSpikes(env);
		expect(sendSlackAlert).not.toHaveBeenCalled();
	});

	it('alerts when metric spikes >200% above baseline', async () => {
		// First call: current hour (1hr)
		// Second call: baseline (24hr)
		let callCount = 0;
		vi.mocked(queryAE).mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				// Current hour: 500 d1_writes
				return {
					data: [{ worker_name: 'my-api', d1_writes: 500, d1_reads: 0, kv_reads: 0, kv_writes: 0, r2_class_a: 0, r2_class_b: 0, ai_neurons: 0, queue_messages: 0 }],
					meta: [], rows: 1,
				};
			}
			// Baseline (24hr total): 2400 → average 100/hr, so 500 = 5x spike
			return {
				data: [{ worker_name: 'my-api', d1_writes: 2400, d1_reads: 0, kv_reads: 0, kv_writes: 0, r2_class_a: 0, r2_class_b: 0, ai_neurons: 0, queue_messages: 0 }],
				meta: [], rows: 1,
			};
		});

		await detectCostSpikes(env);
		expect(sendSlackAlert).toHaveBeenCalled();
	});

	it('does not alert when metric is below threshold', async () => {
		let callCount = 0;
		vi.mocked(queryAE).mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				// Current: 150
				return {
					data: [{ worker_name: 'my-api', d1_writes: 150, d1_reads: 0, kv_reads: 0, kv_writes: 0, r2_class_a: 0, r2_class_b: 0, ai_neurons: 0, queue_messages: 0 }],
					meta: [], rows: 1,
				};
			}
			// Baseline: 2400 → avg 100/hr → 150/100 = 1.5x (below 2.0 threshold)
			return {
				data: [{ worker_name: 'my-api', d1_writes: 2400, d1_reads: 0, kv_reads: 0, kv_writes: 0, r2_class_a: 0, r2_class_b: 0, ai_neurons: 0, queue_messages: 0 }],
				meta: [], rows: 1,
			};
		});

		await detectCostSpikes(env);
		expect(sendSlackAlert).not.toHaveBeenCalled();
	});

	it('ignores low-volume metrics (below MIN_METRIC_VALUE)', async () => {
		let callCount = 0;
		vi.mocked(queryAE).mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				// Current: 5 (below minimum threshold of 10)
				return {
					data: [{ worker_name: 'my-api', d1_writes: 5, d1_reads: 0, kv_reads: 0, kv_writes: 0, r2_class_a: 0, r2_class_b: 0, ai_neurons: 0, queue_messages: 0 }],
					meta: [], rows: 1,
				};
			}
			return {
				data: [{ worker_name: 'my-api', d1_writes: 24, d1_reads: 0, kv_reads: 0, kv_writes: 0, r2_class_a: 0, r2_class_b: 0, ai_neurons: 0, queue_messages: 0 }],
				meta: [], rows: 1,
			};
		});

		await detectCostSpikes(env);
		expect(sendSlackAlert).not.toHaveBeenCalled();
	});

	it('handles AE query failure gracefully', async () => {
		vi.mocked(queryAE).mockRejectedValue(new Error('AE timeout'));
		await detectCostSpikes(env);
		// Should not throw, just log
		expect(sendSlackAlert).not.toHaveBeenCalled();
	});
});
