import type { MonitorWorkerEnv } from '../types.js';

/**
 * Runtime config parser.
 *
 * cf-monitor.yaml is parsed by the CLI and embedded as a JSON string
 * in the worker's wrangler.jsonc vars (CF_MONITOR_CONFIG). This module
 * reads that JSON string and resolves any $ENV_VAR references against
 * the worker's env object.
 *
 * Example wrangler.jsonc vars:
 *   "CF_MONITOR_CONFIG": "{\"github\":{\"token\":\"$GITHUB_TOKEN\",\"repo\":\"owner/repo\"}}"
 */

export interface ResolvedConfig {
	account?: {
		name?: string;
		cloudflare_account_id?: string;
	};
	github?: {
		repo?: string;
		token?: string;
		webhook_secret?: string;
	};
	alerts?: {
		slack_webhook_url?: string;
	};
	monitoring?: {
		gap_detection_minutes?: number;
		heartbeat_url?: string;
		heartbeat_token?: string;
		exclude?: string[];
	};
	budgets?: {
		daily?: Record<string, number>;
		monthly?: Record<string, number>;
	};
	ai?: {
		enabled?: boolean;
		pattern_discovery?: boolean;
		health_reports?: boolean;
		coverage_auditor?: boolean;
		model?: string;
	};
}

/**
 * Parse the embedded config from env vars, resolving $ENV_VAR references.
 *
 * @param env - Worker environment (contains CF_MONITOR_CONFIG var + env vars for resolution)
 * @returns Resolved config, or null if no config embedded
 */
export function parseConfig(env: MonitorWorkerEnv): ResolvedConfig | null {
	const configJson = (env as unknown as Record<string, unknown>).CF_MONITOR_CONFIG as string | undefined;
	if (!configJson) return null;

	try {
		const config = JSON.parse(configJson) as Record<string, unknown>;
		return resolveEnvVars(config, env) as ResolvedConfig;
	} catch (err) {
		console.error(`[cf-monitor:config] Failed to parse config: ${err}`);
		return null;
	}
}

/**
 * Enrich the worker env with config values from CF_MONITOR_CONFIG.
 *
 * Precedence: direct env var/secret > resolved config > undefined.
 * Never writes unresolved $REFERENCE strings to env (safety net for
 * missing secrets).
 *
 * @returns A new env object with config values filled in, or the
 *          original env if no CF_MONITOR_CONFIG is present.
 */
export function enrichEnv(env: MonitorWorkerEnv): MonitorWorkerEnv {
	const config = parseConfig(env);
	if (!config) return env;

	const enriched = { ...env };

	const mapping: Array<[keyof MonitorWorkerEnv, unknown]> = [
		['GITHUB_REPO', config.github?.repo],
		['GITHUB_TOKEN', config.github?.token],
		['GITHUB_WEBHOOK_SECRET', config.github?.webhook_secret],
		['SLACK_WEBHOOK_URL', config.alerts?.slack_webhook_url],
		['GATUS_HEARTBEAT_URL', config.monitoring?.heartbeat_url],
		['GATUS_TOKEN', config.monitoring?.heartbeat_token],
		['ACCOUNT_NAME', config.account?.name],
	];

	for (const [key, value] of mapping) {
		if (
			typeof value === 'string' &&
			value.length > 0 &&
			!value.startsWith('$') &&
			!enriched[key]
		) {
			(enriched as Record<string, unknown>)[key] = value;
		}
	}

	return enriched;
}

/**
 * Recursively resolve $ENV_VAR references in a config object.
 * References like "$GITHUB_TOKEN" are replaced with the corresponding
 * value from the worker's env object.
 */
function resolveEnvVars(obj: unknown, env: MonitorWorkerEnv): unknown {
	if (typeof obj === 'string') {
		if (obj.startsWith('$')) {
			const varName = obj.slice(1);
			const value = (env as unknown as Record<string, unknown>)[varName];
			return typeof value === 'string' ? value : obj;
		}
		return obj;
	}

	if (Array.isArray(obj)) {
		return obj.map((item) => resolveEnvVars(item, env));
	}

	if (obj && typeof obj === 'object') {
		const resolved: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
			resolved[key] = resolveEnvVars(value, env);
		}
		return resolved;
	}

	return obj;
}
