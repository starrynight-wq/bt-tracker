/*
 * Shared helpers for upstream peer-fetch adapters.
 *
 * Adapters connect the platform-agnostic aggregation logic in tracker.js with
 * the platform transport:
 *
 *   fetchPeersBatch(infoHash, peerParams, upstreamUrls, budgetMs)
 *     -> { results, pendingUrls, unsupportedUrls, queried, planned }
 *
 * Design constraints (see tracker.js header for the audit notes):
 *   - Every batch is bounded by budgetMs (default 8000 ms) so the client gets
 *     a valid bencoded response well inside its ~10 s receive timeout.
 *   - Requests are fired concurrently through a bounded worker pool; the
 *     aggregation never uses Promise.all (only Promise.allSettled for the pool).
 *   - udp:// trackers are skipped everywhere: Cloudflare's standard runtime has
 *     no UDP sockets and Node only via dgram (not implemented here).
 *
 * NOTE: this project is NOT a general-purpose proxy. It only fetches BitTorrent
 * tracker announce responses for the tracker aggregation feature.
 */

import { decodeSync } from '../bencode.js';

/** udp trackers are unsupported on both runtimes (no UDP in Workers). */
export const UDP_SCHEME = 'udp:';

export function isUdpTracker(url) {
  return typeof url === 'string' && url.trim().toLowerCase().startsWith(UDP_SCHEME);
}

/** Parse a bencoded announce response into { ok, peers, complete, incomplete }. */
export function parseAnnounceResponse(bytes) {
  let decoded;
  try {
    decoded = decodeSync(bytes);
  } catch {
    return { ok: false, error: 'invalid bencode' };
  }
  if (!decoded || typeof decoded !== 'object') return { ok: false, error: 'invalid announce body' };
  if (decoded['failure reason'] !== undefined) {
    return { ok: false, error: String(decoded['failure reason']) };
  }

  const peers = [];
  const p = decoded.peers;
  if (Array.isArray(p)) {
    for (const item of p) {
      if (item && item.ip && item.port !== undefined) {
        peers.push({ ip: String(item.ip), port: Number(item.port), peerId: item.peer_id || '' });
      }
    }
  } else if (p instanceof Uint8Array) {
    // compact peers: 4-byte IPv4 + 2-byte port per entry
    for (let i = 0; i + 5 < p.length; i += 6) {
      const ip = [p[i], p[i + 1], p[i + 2], p[i + 3]].join('.');
      peers.push({ ip, port: (p[i + 4] << 8) | p[i + 5], peerId: 'ext' });
    }
  }
  return {
    ok: true,
    peers,
    complete: Number(decoded.complete) || 0,
    incomplete: Number(decoded.incomplete) || 0
  };
}

/** Build the upstream announce URL with the client's announce parameters. */
export function buildAnnounceUrl(baseUrl, params) {
  const u = new URL(baseUrl);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * Fetch + decode one upstream announce, bounded by timeoutMs.
 *
 * The race guarantees a result even if the injected fetch implementation
 * ignores the abort signal (important for tests and broken runtimes).
 */
export function fetchAnnounce(url, params, timeoutMs, fetchImpl = fetch, userAgent = 'bt-tracker/1.0') {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      try { if (controller) controller.abort(); } catch { /* ignore */ }
      resolve({ ok: false, error: 'timeout' });
    }, Math.max(1, timeoutMs));
  });
  const work = (async () => {
    try {
      const res = await fetchImpl(buildAnnounceUrl(url, params), {
        method: 'GET',
        headers: { 'User-Agent': userAgent },
        ...(controller ? { signal: controller.signal } : {})
      });
      if (!res || !res.ok) return { ok: false, error: `http ${res && res.status}` };
      const body = new Uint8Array(await res.arrayBuffer());
      return parseAnnounceResponse(body);
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
      return { ok: false, error: aborted ? 'timeout' : 'fetch failed' };
    } finally {
      clearTimeout(timer);
    }
  })();
  return Promise.race([work, timeoutPromise]).then((r) => {
    clearTimeout(timer);
    return r;
  });
}

/**
 * Run one batch of upstream announces with bounded concurrency and a hard budget.
 *
 * - `maxUpstreams` truncates the batch (Cloudflare: 40); the remainder is
 *   returned as `pendingUrls` so the next announce can continue.
 * - requests still running when the budget is exhausted are not started
 *   (their URLs become pending).
 * - `perRequestTimeoutMs` is clamped to the remaining budget for every request,
 *   so a single slow upstream can never overrun the batch.
 */
export async function runUpstreamBatch({
  upstreamUrls,
  peerParams,
  budgetMs,
  concurrency,
  perRequestTimeoutMs,
  maxUpstreams = Number.POSITIVE_INFINITY,
  fetchImpl = fetch,
  logTag = 'adapter'
}) {
  const budget = Math.min(Math.max(Number(budgetMs) || 8000, 250), 30000);
  const supported = [];
  const unsupportedUrls = [];
  for (const url of upstreamUrls || []) {
    if (typeof url !== 'string' || url.length === 0) continue;
    if (isUdpTracker(url)) unsupportedUrls.push(url);
    else supported.push(url);
  }
  if (unsupportedUrls.length > 0) {
    console.warn(`[${logTag}] unsupported udp:// tracker(s) skipped: ${unsupportedUrls.join(', ')}`);
  }

  const planned = supported.slice(0, maxUpstreams);
  const pendingUrls = supported.slice(maxUpstreams);
  if (planned.length === 0) {
    return { results: [], pendingUrls, unsupportedUrls, queried: 0, planned: 0 };
  }

  // Reserve a small slice of the budget for merging + bencode encoding.
  const deadline = Date.now() + Math.max(150, budget - 300);
  const results = new Array(planned.length).fill(null);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= planned.length) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return; // unstarted -> pending for the next announce
      const timeoutMs = Math.max(250, Math.min(perRequestTimeoutMs, remaining));
      try {
        const r = await fetchAnnounce(planned[index], peerParams, timeoutMs, fetchImpl);
        results[index] = { ...r, url: planned[index], timeoutMs };
      } catch (e) {
        results[index] = { ok: false, url: planned[index], error: 'adapter error' };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, planned.length));
  const workers = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.allSettled(workers);

  const settled = [];
  for (let i = 0; i < planned.length; i++) {
    if (results[i]) settled.push(results[i]);
    else pendingUrls.push(planned[i]);
  }
  return {
    results: settled,
    pendingUrls,
    unsupportedUrls,
    queried: settled.length,
    planned: planned.length
  };
}
