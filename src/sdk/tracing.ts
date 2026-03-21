/**
 * Simplified W3C distributed tracing.
 * Generates trace context and propagates via headers.
 */

export interface TraceContext {
	traceId: string;
	spanId: string;
	sampled: boolean;
}

/**
 * Create trace context from an incoming request or generate fresh.
 */
export function createTraceContext(request?: Request): TraceContext {
	if (request) {
		const traceparent = request.headers.get('traceparent');
		if (traceparent) {
			const parsed = parseTraceparent(traceparent);
			if (parsed) return { ...parsed, spanId: generateSpanId() };
		}
	}

	return {
		traceId: generateTraceId(),
		spanId: generateSpanId(),
		sampled: true,
	};
}

/**
 * Format trace context as W3C traceparent header.
 */
export function formatTraceparent(ctx: TraceContext): string {
	const flags = ctx.sampled ? '01' : '00';
	return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/**
 * Add trace headers to an outgoing request init.
 */
export function propagateTrace(ctx: TraceContext, init?: RequestInit): RequestInit {
	const headers = new Headers(init?.headers);
	headers.set('traceparent', formatTraceparent(ctx));
	return { ...init, headers };
}

// =============================================================================
// INTERNAL
// =============================================================================

function parseTraceparent(header: string): { traceId: string; spanId: string; sampled: boolean } | null {
	const parts = header.split('-');
	if (parts.length < 4) return null;
	const traceId = parts[1];
	const spanId = parts[2];
	const flags = parseInt(parts[3], 16);
	if (!traceId || traceId.length !== 32) return null;
	if (!spanId || spanId.length !== 16) return null;
	return { traceId, spanId, sampled: (flags & 1) === 1 };
}

function generateTraceId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return hexEncode(bytes);
}

function generateSpanId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return hexEncode(bytes);
}

function hexEncode(bytes: Uint8Array): string {
	let hex = '';
	for (const b of bytes) {
		hex += b.toString(16).padStart(2, '0');
	}
	return hex;
}
