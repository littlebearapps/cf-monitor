import { MONITOR_BINDINGS } from '../constants.js';

// =============================================================================
// WORKER NAME DETECTION
// =============================================================================

/**
 * Auto-detect the worker name from env.
 * Cloudflare does NOT auto-set WORKER_NAME — it must be added to wrangler
 * vars (e.g. via `cf-monitor wire --apply`) or passed as config.workerName.
 *
 * Detection chain: config.workerName → env.WORKER_NAME → env.name → 'worker'
 */
export function detectWorkerName(env: object, configWorkerName?: string): string {
	if (configWorkerName) return configWorkerName;
	const e = env as Record<string, unknown>;
	if (typeof e.WORKER_NAME === 'string' && e.WORKER_NAME) return e.WORKER_NAME;
	if (typeof e.name === 'string' && e.name) return e.name;
	return 'worker';
}

// =============================================================================
// FEATURE ID GENERATION
// =============================================================================

/**
 * Auto-generate a feature ID for a fetch request.
 * Format: {workerName}:fetch:{METHOD}:{path-slug}
 *
 * Path normalisation:
 * - Strip numeric segments, UUIDs, query strings
 * - Limit to first 2 meaningful segments
 * - e.g. GET /api/users/123/posts → my-api:fetch:GET:api-users
 */
export function generateFetchFeatureId(workerName: string, request: Request): string {
	const url = new URL(request.url);
	const method = request.method;
	const slug = normalisePath(url.pathname);
	return `${workerName}:fetch:${method}:${slug}`;
}

/**
 * Auto-generate a feature ID for a cron expression.
 * Format: {workerName}:cron:{slugified-expression}
 */
export function generateCronFeatureId(workerName: string, cron: string): string {
	const slug = cron
		.replace(/\*/g, 'x')
		.replace(/\s+/g, '-')
		.replace(/[^a-zA-Z0-9_-]/g, '_');
	return `${workerName}:cron:${slug}`;
}

/**
 * Auto-generate a feature ID for a queue.
 * Format: {workerName}:queue:{queueName}
 */
export function generateQueueFeatureId(workerName: string, queueName: string): string {
	const slug = queueName.replace(/[^a-zA-Z0-9_-]/g, '_');
	return `${workerName}:queue:${slug}`;
}

/**
 * Normalise a URL path into a slug for feature ID use.
 * Strips numeric segments, UUIDs, and limits depth.
 */
function normalisePath(pathname: string): string {
	const segments = pathname
		.split('/')
		.filter(Boolean)
		.filter((s) => !isNumericOrUuid(s))
		.slice(0, 2);

	if (segments.length === 0) return 'root';
	return segments.join('-');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNumericOrUuid(segment: string): boolean {
	if (/^\d+$/.test(segment)) return true;
	if (UUID_RE.test(segment)) return true;
	if (/^[0-9a-f]{24,}$/i.test(segment)) return true; // MongoDB-style IDs
	return false;
}

// =============================================================================
// BINDING DETECTION
// =============================================================================

/** Detected binding inventory. */
export interface BindingInventory {
	d1: string[];
	kv: string[];
	r2: string[];
	ai: boolean;
	vectorize: string[];
	queues: string[];
	durableObjects: string[];
	workflows: string[];
	serviceBindings: string[];
}

/**
 * Auto-detect Cloudflare resource bindings in the worker environment.
 * Uses duck-typing to identify binding types.
 */
export function detectBindings(env: object): BindingInventory {
	const inventory: BindingInventory = {
		d1: [],
		kv: [],
		r2: [],
		ai: false,
		vectorize: [],
		queues: [],
		durableObjects: [],
		workflows: [],
		serviceBindings: [],
	};

	const skipKeys = new Set([MONITOR_BINDINGS.KV, MONITOR_BINDINGS.AE, 'WORKER_NAME']);

	for (const [key, value] of Object.entries(env)) {
		if (skipKeys.has(key)) continue;
		if (value == null || typeof value !== 'object') continue;

		const v = value as Record<string, unknown>;

		// D1 Database: has prepare() method
		if (typeof v.prepare === 'function' && typeof v.batch === 'function') {
			inventory.d1.push(key);
			continue;
		}

		// KV Namespace: has get/put/delete/list methods
		if (
			typeof v.get === 'function' &&
			typeof v.put === 'function' &&
			typeof v.delete === 'function' &&
			typeof v.list === 'function'
		) {
			inventory.kv.push(key);
			continue;
		}

		// R2 Bucket: has get/put/delete/list + head
		if (
			typeof v.get === 'function' &&
			typeof v.put === 'function' &&
			typeof v.head === 'function' &&
			typeof v.list === 'function'
		) {
			inventory.r2.push(key);
			continue;
		}

		// Workers AI: has run() method
		if (typeof v.run === 'function' && !('get' in v)) {
			inventory.ai = true;
			continue;
		}

		// Vectorize Index: has query/insert/upsert
		if (typeof v.query === 'function' && typeof v.insert === 'function') {
			inventory.vectorize.push(key);
			continue;
		}

		// Queue: has send/sendBatch
		if (typeof v.send === 'function' && typeof v.sendBatch === 'function') {
			inventory.queues.push(key);
			continue;
		}

		// Durable Object Namespace: has get/idFromName
		if (typeof v.get === 'function' && typeof v.idFromName === 'function') {
			inventory.durableObjects.push(key);
			continue;
		}

		// Workflow: has create/get
		if (typeof v.create === 'function' && typeof v.get === 'function' && !('put' in v)) {
			inventory.workflows.push(key);
			continue;
		}

		// Service Binding: has fetch() but nothing else
		if (typeof v.fetch === 'function' && Object.keys(v).length <= 2) {
			inventory.serviceBindings.push(key);
			continue;
		}
	}

	return inventory;
}

// =============================================================================
// MONITOR BINDING CHECK
// =============================================================================

/** Check if the required cf-monitor bindings exist in env. */
export function hasMonitorBindings(env: object): boolean {
	const e = env as Record<string, unknown>;
	return e[MONITOR_BINDINGS.KV] != null && e[MONITOR_BINDINGS.AE] != null;
}
