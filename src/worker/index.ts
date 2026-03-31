/// <reference types="@cloudflare/workers-types" />

/**
 * cf-monitor Worker
 *
 * Single worker per Cloudflare account that provides:
 * - Tail handler: captures errors from all tailed workers
 * - Scheduled handler: cron multiplexer for metrics, budgets, gaps, discovery
 * - Fetch handler: status API, error queries, budget status
 */

import type { MonitorWorkerEnv } from '../types.js';
import { enrichEnv } from './config.js';
import { handleTailEvents } from './tail-handler.js';
import { handleScheduled } from './scheduled-handler.js';
import { handleFetch } from './fetch-handler.js';

export default {
	async tail(events: TraceItem[], env: MonitorWorkerEnv, ctx: ExecutionContext): Promise<void> {
		await handleTailEvents(events, enrichEnv(env), ctx);
	},

	async scheduled(controller: ScheduledController, env: MonitorWorkerEnv, ctx: ExecutionContext): Promise<void> {
		await handleScheduled(controller, enrichEnv(env), ctx);
	},

	async fetch(request: Request, env: MonitorWorkerEnv, ctx: ExecutionContext): Promise<Response> {
		return handleFetch(request, enrichEnv(env), ctx);
	},
} satisfies ExportedHandler<MonitorWorkerEnv>;
