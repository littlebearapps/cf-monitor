import { AE_FIELD_COUNT } from '../constants.js';
import type { MetricsAccumulator, TelemetryDataPoint } from '../types.js';

/** Create a zeroed MetricsAccumulator. */
export function createMetrics(): MetricsAccumulator {
	return {
		d1Writes: 0,
		d1Reads: 0,
		d1RowsRead: 0,
		d1RowsWritten: 0,
		kvReads: 0,
		kvWrites: 0,
		kvDeletes: 0,
		kvLists: 0,
		aiRequests: 0,
		aiNeurons: 0,
		vectorizeQueries: 0,
		vectorizeInserts: 0,
		r2ClassA: 0,
		r2ClassB: 0,
		queueMessages: 0,
		doRequests: 0,
		workflowInvocations: 0,
		requests: 1,
		cpuMs: 0,
		errorCount: 0,
	};
}

/** Check if all metric values are zero (nothing to report). */
export function isZero(m: MetricsAccumulator): boolean {
	return (
		m.d1Writes === 0 &&
		m.d1Reads === 0 &&
		m.kvReads === 0 &&
		m.kvWrites === 0 &&
		m.aiRequests === 0 &&
		m.r2ClassA === 0 &&
		m.r2ClassB === 0 &&
		m.queueMessages === 0 &&
		m.doRequests === 0 &&
		m.vectorizeQueries === 0 &&
		m.workflowInvocations === 0
	);
}

/**
 * Convert a MetricsAccumulator to an AE data point.
 * Field order matches AE_FIELDS constant (append-only, backward compatible).
 */
export function toDataPoint(
	workerName: string,
	featureId: string,
	metrics: MetricsAccumulator
): TelemetryDataPoint {
	const parts = featureId.split(':');
	const category = parts[1] ?? 'unknown';
	const feature = parts.slice(2).join(':') || 'unknown';

	const doubles = new Array<number>(AE_FIELD_COUNT).fill(0);
	doubles[0] = metrics.d1Writes;
	doubles[1] = metrics.d1Reads;
	doubles[2] = metrics.kvReads;
	doubles[3] = metrics.kvWrites;
	doubles[4] = metrics.doRequests;
	doubles[5] = 0; // doGbSeconds (reserved)
	doubles[6] = metrics.r2ClassA;
	doubles[7] = metrics.r2ClassB;
	doubles[8] = metrics.aiNeurons;
	doubles[9] = metrics.queueMessages;
	doubles[10] = metrics.requests;
	doubles[11] = metrics.cpuMs;
	doubles[12] = metrics.d1RowsRead;
	doubles[13] = metrics.d1RowsWritten;
	doubles[14] = metrics.kvDeletes;
	doubles[15] = metrics.kvLists;
	doubles[16] = metrics.aiRequests;
	doubles[17] = metrics.vectorizeQueries;
	doubles[18] = metrics.vectorizeInserts;
	doubles[19] = metrics.workflowInvocations;

	return {
		blobs: [workerName, category, feature],
		doubles,
		indexes: [featureId],
	};
}
