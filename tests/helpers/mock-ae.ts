/// <reference types="@cloudflare/workers-types" />

/**
 * In-memory Analytics Engine mock.
 * Collects writeDataPoint calls for test assertions.
 */

export interface DataPointRecord {
	blobs: string[];
	doubles: number[];
	indexes: string[];
}

export interface MockAE extends AnalyticsEngineDataset {
	/** All data points written. */
	_dataPoints: DataPointRecord[];
	/** Clear collected data. */
	_reset: () => void;
}

export function createMockAE(): MockAE {
	const dataPoints: DataPointRecord[] = [];

	return {
		_dataPoints: dataPoints,
		_reset: () => {
			dataPoints.length = 0;
		},
		writeDataPoint(dp: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void {
			dataPoints.push({
				blobs: dp.blobs ? [...dp.blobs] : [],
				doubles: dp.doubles ? [...dp.doubles] : [],
				indexes: dp.indexes ? [...dp.indexes] : [],
			});
		},
	} as unknown as MockAE;
}
