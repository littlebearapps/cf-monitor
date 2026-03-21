import { CF_PRICING } from '../constants.js';
import type { MetricsAccumulator } from '../types.js';

/**
 * Estimate USD cost from a MetricsAccumulator snapshot.
 * Uses CF Workers Paid plan pricing.
 */
export function estimateCost(metrics: MetricsAccumulator): number {
	return (
		metrics.d1Reads * CF_PRICING.d1_read +
		metrics.d1Writes * CF_PRICING.d1_write +
		metrics.kvReads * CF_PRICING.kv_read +
		metrics.kvWrites * CF_PRICING.kv_write +
		metrics.r2ClassA * CF_PRICING.r2_class_a +
		metrics.r2ClassB * CF_PRICING.r2_class_b +
		metrics.aiNeurons * CF_PRICING.ai_neuron +
		metrics.queueMessages * CF_PRICING.queue_message +
		metrics.doRequests * CF_PRICING.do_request +
		metrics.vectorizeQueries * CF_PRICING.vectorize_query
	);
}
