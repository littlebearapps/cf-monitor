import { CF_PRICING } from '../../constants.js';
import type { MonitorWorkerEnv } from '../../types.js';
import { queryAE } from '../ae-client.js';
import { sendSlackAlert } from '../alerts/slack.js';

/** Spike threshold: alert if current hour exceeds 200% of baseline. */
const SPIKE_THRESHOLD = 2.0;

/** Minimum absolute value to consider (avoids noise from low-volume workers). */
const MIN_METRIC_VALUE = 10;

/** Metrics we track for cost spikes, mapped to CF_PRICING keys. */
const COST_METRICS: Record<string, keyof typeof CF_PRICING> = {
	d1_writes: 'd1_write',
	d1_reads: 'd1_read',
	kv_writes: 'kv_write',
	kv_reads: 'kv_read',
	ai_neurons: 'ai_neuron',
	r2_class_a: 'r2_class_a',
	r2_class_b: 'r2_class_b',
	queue_messages: 'queue_message',
};

interface HourlyMetrics {
	workerName: string;
	metrics: Record<string, number>;
}

/**
 * Detect cost spikes by comparing last hour against the previous 24h average.
 * Alerts via Slack if any metric exceeds SPIKE_THRESHOLD (200%) above baseline.
 */
export async function detectCostSpikes(env: MonitorWorkerEnv): Promise<void> {
	if (!env.CLOUDFLARE_API_TOKEN || !env.CF_ACCOUNT_ID) return;

	try {
		const [currentHour, baseline] = await Promise.all([
			getHourlyMetrics(env, 1),  // Last 1 hour
			getHourlyMetrics(env, 24), // Last 24 hours (for average)
		]);

		if (currentHour.length === 0) return;

		// Build baseline averages per worker
		const baselineAvg = new Map<string, Record<string, number>>();
		for (const entry of baseline) {
			const existing = baselineAvg.get(entry.workerName);
			if (existing) {
				for (const [metric, value] of Object.entries(entry.metrics)) {
					existing[metric] = (existing[metric] ?? 0) + value;
				}
			} else {
				baselineAvg.set(entry.workerName, { ...entry.metrics });
			}
		}

		// Divide by 24 to get hourly average
		for (const [, metrics] of baselineAvg) {
			for (const metric of Object.keys(metrics)) {
				metrics[metric] = metrics[metric] / 24;
			}
		}

		// Compare current hour against baseline
		for (const current of currentHour) {
			const avg = baselineAvg.get(current.workerName);
			if (!avg) continue; // New worker, no baseline

			for (const [metric, currentValue] of Object.entries(current.metrics)) {
				if (currentValue < MIN_METRIC_VALUE) continue;

				const avgValue = avg[metric] ?? 0;
				if (avgValue < MIN_METRIC_VALUE) continue;

				const ratio = currentValue / avgValue;
				if (ratio >= SPIKE_THRESHOLD) {
					const pricingKey = COST_METRICS[metric];
					const estimatedCost = pricingKey
						? currentValue * CF_PRICING[pricingKey]
						: 0;

					await sendSlackAlert(
						env,
						`spike:${current.workerName}:${metric}:${currentHourKey()}`,
						3600, // 1hr dedup
						{
							blocks: [
								{
									type: 'header',
									text: {
										type: 'plain_text',
										text: `:chart_with_upwards_trend: Cost Spike: ${env.ACCOUNT_NAME}`,
									},
								},
								{
									type: 'section',
									fields: [
										{ type: 'mrkdwn', text: `*Worker:*\n\`${current.workerName}\`` },
										{ type: 'mrkdwn', text: `*Metric:*\n${metric}` },
										{
											type: 'mrkdwn',
											text: `*Current hour:*\n${currentValue.toLocaleString()} (${ratio.toFixed(1)}x baseline)`,
										},
										{
											type: 'mrkdwn',
											text: `*Estimated cost:*\n$${estimatedCost.toFixed(4)}`,
										},
									],
								},
							],
						}
					);
				}
			}
		}
	} catch (err) {
		console.error(`[cf-monitor:spike] Cost spike detection failed: ${err}`);
	}
}

/** Query AE for per-worker metrics over the given interval. */
async function getHourlyMetrics(
	env: MonitorWorkerEnv,
	hours: number
): Promise<HourlyMetrics[]> {
	// AE doubles layout: 0=d1Writes, 1=d1Reads, 2=kvReads, 3=kvWrites,
	// 6=r2ClassA, 7=r2ClassB, 8=aiNeurons, 9=queueMessages
	const sql = `
		SELECT
			blob1 AS worker_name,
			sum(double1) AS d1_writes,
			sum(double2) AS d1_reads,
			sum(double3) AS kv_reads,
			sum(double4) AS kv_writes,
			sum(double7) AS r2_class_a,
			sum(double8) AS r2_class_b,
			sum(double9) AS ai_neurons,
			sum(double10) AS queue_messages
		FROM "cf-monitor"
		WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
		GROUP BY worker_name
	`;

	const result = await queryAE(env.CF_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN!, sql);

	return result.data.map((row) => ({
		workerName: row.worker_name as string,
		metrics: {
			d1_writes: Number(row.d1_writes) || 0,
			d1_reads: Number(row.d1_reads) || 0,
			kv_reads: Number(row.kv_reads) || 0,
			kv_writes: Number(row.kv_writes) || 0,
			r2_class_a: Number(row.r2_class_a) || 0,
			r2_class_b: Number(row.r2_class_b) || 0,
			ai_neurons: Number(row.ai_neurons) || 0,
			queue_messages: Number(row.queue_messages) || 0,
		},
	}));
}

function currentHourKey(): string {
	return new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
}
