/*
 * Cloudflare Pages Functions entry point (catch-all).
 *
 * Pages Functions use the `onRequest` handler shape rather than the Workers
 * `export default { fetch }` shape, so this file adapts the shared Worker
 * implementation (src/worker.js) to Pages.
 *
 * Deployment (Pages project settings):
 *   - Build command:      npm run build   (optional; regenerates bundle files)
 *   - Build output dir:   public
 *   - KV bindings:        BT_TORRENTS / BT_TRACKERS / BT_ALERTS
 *   - Variables:          BT_INTERVAL / BT_MIN_INTERVAL / BT_TRACKER_ID (optional)
 *
 * Requests handled by this Function are restricted by public/_routes.json so
 * static assets keep being served directly by Pages.
 */

import worker from '../src/worker.js';

export function onRequest(context) {
  return worker.fetch(context.request, context.env, context);
}
