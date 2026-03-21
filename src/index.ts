/**
 * @littlebearapps/cf-monitor
 *
 * Self-contained Cloudflare account monitoring.
 * One worker per account: error collection, feature budgets,
 * circuit breakers, cost protection.
 *
 * @example
 * ```typescript
 * import { monitor } from '@littlebearapps/cf-monitor';
 *
 * export default monitor({
 *   fetch: async (request, env, ctx) => {
 *     return new Response('Hello');
 *   },
 * });
 * ```
 */

export { monitor } from './sdk/monitor.js';
export { CircuitBreakerError, RequestBudgetExceededError } from './types.js';
export type { MonitorConfig, MetricsAccumulator, RequestLimits, BudgetOverrides } from './types.js';
