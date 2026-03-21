/**
 * cf-monitor worker entry point.
 *
 * This is the single worker deployed per CF account.
 * It handles: tail (error capture), scheduled (metrics/budgets/gaps),
 * and fetch (status API).
 *
 * Deploy via: npx cf-monitor deploy
 */

export { default } from '../src/worker/index.js';
