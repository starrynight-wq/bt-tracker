/*
 * Cloudflare Workers / Pages adapter for upstream tracker aggregation.
 *
 * Same interface as the Node adapter:
 *   fetchPeersBatch(infoHash, peerParams, upstreamUrls, budgetMs)
 *     -> { results, pendingUrls, unsupportedUrls, queried, planned }
 *
 * Cloudflare free-plan hard limits that this adapter encodes:
 *   - max 50 subrequests per invocation  -> only 40 upstreams are queried per
 *     announce (10 are reserved for KV reads/writes and support traffic). The
 *     rest is returned as pendingUrls and continued on the next announce.
 *   - max 6 simultaneous outbound connections -> connection pool size 6.
 *   - standard runtime has no UDP sockets -> udp:// trackers are skipped with
 *     an "unsupported" warning and never enter the fetch loop.
 *   - 10 ms CPU per invocation -> batching only, no sorting/heavy dedupe here;
 *     peer de-duplication happens in tracker.js with a simple Set<ip:port>.
 *
 * NOTE: this project is NOT a general-purpose proxy. It only aggregates
 * BitTorrent tracker announce responses.
 */

import { runUpstreamBatch } from './common.js';

/** Hard cap for upstream fetches in one worker invocation (subrequest limit is 50). */
export const CF_MAX_UPSTREAMS_PER_CALL = 40;
/** Cloudflare Workers limit on simultaneous outbound connections. */
export const CF_MAX_CONCURRENT_CONNECTIONS = 6;
/** Healthy upstream are expected to answer in 2-3 s; stragglers give up sooner. */
export const CF_DEFAULT_TIMEOUT_MS = 2500;

export function createCloudflareAdapter({
  concurrency = CF_MAX_CONCURRENT_CONNECTIONS,
  perRequestTimeoutMs = CF_DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch
} = {}) {
  const boundedConcurrency = Math.min(
    Math.max(1, Number(concurrency) || CF_MAX_CONCURRENT_CONNECTIONS),
    CF_MAX_CONCURRENT_CONNECTIONS
  );
  const boundedTimeout = Math.min(Math.max(250, Number(perRequestTimeoutMs) || CF_DEFAULT_TIMEOUT_MS), 5000);

  return {
    name: 'cloudflare',
    maxUpstreamsPerCall: CF_MAX_UPSTREAMS_PER_CALL,
    concurrency: boundedConcurrency,
    perRequestTimeoutMs: boundedTimeout,
    fetchPeersBatch(infoHash, peerParams, upstreamUrls, budgetMs = 8000) {
      return runUpstreamBatch({
        upstreamUrls,
        peerParams,
        budgetMs,
        concurrency: boundedConcurrency,
        perRequestTimeoutMs: boundedTimeout,
        maxUpstreams: CF_MAX_UPSTREAMS_PER_CALL,
        fetchImpl,
        logTag: 'cloudflare-adapter'
      });
    }
  };
}

/* Convenience factory matching the adapter interface without extra options. */
export function fetchPeersBatch(infoHash, peerParams, upstreamUrls, budgetMs = 8000) {
  return createCloudflareAdapter().fetchPeersBatch(infoHash, peerParams, upstreamUrls, budgetMs);
}
