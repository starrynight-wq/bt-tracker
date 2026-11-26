/*
 * Node.js / Replit adapter for upstream tracker aggregation.
 *
 * Same interface as the Cloudflare adapter:
 *   fetchPeersBatch(infoHash, peerParams, upstreamUrls, budgetMs)
 *     -> { results, pendingUrls, unsupportedUrls, queried, planned }
 *
 * Node has no per-invocation subrequest cap, so the batch is limited only by
 * the time budget. Connections are still bounded (default 24, clamped to the
 * 1..30 range) to avoid opening hundreds of sockets from one announce.
 *
 * udp:// trackers are skipped with a warning (dgram-based announce is not
 * implemented in this project).
 */

import { runUpstreamBatch } from './common.js';

export const NODE_DEFAULT_CONCURRENCY = 24;
export const NODE_DEFAULT_TIMEOUT_MS = 3000;
export const NODE_MAX_CONCURRENCY = 30;

export function createNodeAdapter({
  concurrency = NODE_DEFAULT_CONCURRENCY,
  perRequestTimeoutMs = NODE_DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch
} = {}) {
  const boundedConcurrency = Math.min(
    Math.max(1, Number(concurrency) || NODE_DEFAULT_CONCURRENCY),
    NODE_MAX_CONCURRENCY
  );
  const boundedTimeout = Math.min(Math.max(250, Number(perRequestTimeoutMs) || NODE_DEFAULT_TIMEOUT_MS), 5000);

  return {
    name: 'node',
    concurrency: boundedConcurrency,
    perRequestTimeoutMs: boundedTimeout,
    fetchPeersBatch(infoHash, peerParams, upstreamUrls, budgetMs = 8000) {
      return runUpstreamBatch({
        upstreamUrls,
        peerParams,
        budgetMs,
        concurrency: boundedConcurrency,
        perRequestTimeoutMs: boundedTimeout,
        fetchImpl,
        logTag: 'node-adapter'
      });
    }
  };
}

/* Convenience factory matching the adapter interface without extra options. */
export function fetchPeersBatch(infoHash, peerParams, upstreamUrls, budgetMs = 8000) {
  return createNodeAdapter().fetchPeersBatch(infoHash, peerParams, upstreamUrls, budgetMs);
}
