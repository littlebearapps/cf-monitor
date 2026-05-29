/**
 * R2 operation classification by S3-style `actionType`.
 *
 * The CF GraphQL `r2OperationsAdaptiveGroups.dimensions.actionType` dimension returns full
 * S3 operation names (`GetObject`, `HeadObject`, `PutObject`, `ListBucket`, …) — NOT lowercase
 * `read`/`write` (verified by the 2026-05-27 live API probe). Unrecognised actions are classified
 * as `'unknown'` so they are surfaced rather than silently billed as Class A.
 */

export type R2OpClass = 'classA' | 'classB' | 'free' | 'unknown';

// Class B (cheap reads / metadata).
// NOTE: `ListBucket` was previously classified Class B per the 2026-05-27 probe brief, but
// reclassified to `unknown` on 2026-05-28: Cloudflare's R2 pricing docs may class the equivalent
// `ListObjects` as Class A, and the brief itself permits "unknown or conservative class_a_assumed"
// when ambiguous. Following "prefer unknown over fake precision", `ListBucket` now falls through
// to `unknown` (warned, not counted) until a Billing Read invoice settles it. See
// docs/research/billing-endpoints-follow-up.md.
const R2_CLASS_B = new Set(['GetObject', 'HeadObject']);

// Free / non-billable operations (Cloudflare bills $0 for these).
const R2_FREE = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);

// Class A (writes / mutations / bucket listing). `PutBucket*` config mutations matched by prefix.
const R2_CLASS_A = new Set([
	'PutObject',
	'CopyObject',
	'CreateMultipartUpload',
	'UploadPart',
	'UploadPartCopy',
	'CompleteMultipartUpload',
	'ListMultipartUploads',
	'ListParts',
	'ListBuckets',
]);

export function classifyR2Action(action: string): R2OpClass {
	if (R2_CLASS_B.has(action)) return 'classB';
	if (R2_FREE.has(action)) return 'free';
	if (R2_CLASS_A.has(action) || action.startsWith('PutBucket')) return 'classA';
	return 'unknown'; // empty / missing / unrecognised → surfaced, never silently billed
}
