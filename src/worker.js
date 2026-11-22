/*
 * Cloudflare Workers entry point for bt-tracker.
 *
 * Deploy with the CLI:
 *   wrangler deploy            (see wrangler.toml)
 *
 * This module is also reused by ./functions/[[path]].js for Cloudflare Pages
 * Functions, and it is the source used to generate ./worker-bundle.js (the
 * single-file variant for pasting into the Cloudflare dashboard).
 *
 * Runtime configuration comes from Worker/Pages bindings (env):
 *   BT_TORRENTS, BT_TRACKERS, BT_ALERTS  - KV namespaces
 *   BT_INTERVAL                          - announce interval seconds (default 1800)
 *   BT_MIN_INTERVAL                      - minimum announce interval (default 900)
 *   BT_TRACKER_ID                        - tracker id string
 */

import { KvStore } from './store.js';
import { Tracker } from './tracker.js';
import { decodeSync } from './bencode.js';
import { DASHBOARD_HTML } from './dashboard-html.js';

const ENV_DEFAULT_INTERVAL = 1800;
const ENV_DEFAULT_MIN_INTERVAL = 900;
const ENV_DEFAULT_TRACKER_ID = 'bt-tracker';

function makeStore(torrentsNs, trackersNs, alertsNs) {
  return new KvStore({ torrentsNamespace: torrentsNs, trackersNamespace: trackersNs, alertsNamespace: alertsNs });
}

/* External tracker fetcher for Cloudflare Workers (uses the global fetch) */
async function externalFetch(url, params) {
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      u.searchParams.set(k, String(v));
    }
    const res = await fetch(u.toString(), {
      method: 'GET',
      headers: { 'User-Agent': 'bt-tracker/1.0' }
    });
    if (!res.ok) return { ok: false };
    const body = new Uint8Array(await res.arrayBuffer());
    const decoded = decodeSync(body);
    if (!decoded || typeof decoded !== 'object') return { ok: false };

    const peers = [];
    const p = decoded.peers;
    if (Array.isArray(p)) {
      for (const item of p) {
        if (item && item.ip && item.port !== undefined) {
          peers.push({ ip: item.ip, port: Number(item.port), peerId: item.peer_id || '' });
        }
      }
    } else if (p instanceof Uint8Array) {
      for (let i = 0; i + 5 < p.length; i += 6) {
        const ip = [p[i], p[i + 1], p[i + 2], p[i + 3]].join('.');
        const port = (p[i + 4] << 8) | p[i + 5];
        peers.push({ ip, port, peerId: 'ext' });
      }
    }
    return {
      ok: true,
      peers,
      complete: decoded.complete,
      incomplete: decoded.incomplete
    };
  } catch (e) {
    return { ok: false };
  }
}

export default {
  async fetch(request, env) {
    env = env || {};
    const store = makeStore(env.BT_TORRENTS, env.BT_TRACKERS, env.BT_ALERTS);
    const tracker = new Tracker({
      store,
      interval: Number(env.BT_INTERVAL || ENV_DEFAULT_INTERVAL),
      minInterval: Number(env.BT_MIN_INTERVAL || ENV_DEFAULT_MIN_INTERVAL),
      trackerId: env.BT_TRACKER_ID || ENV_DEFAULT_TRACKER_ID,
      externalFetch
    });

    const url = new URL(request.url);
    const path = url.pathname;

    // Dashboard (HTML is generated from public/dashboard.html)
    if (path === '/' ) {
      return Response.redirect(new URL('/dashboard', url).toString(), 302);
    }
    if (path === '/dashboard' || path === '/dashboard/') {
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // tracker endpoints
    if (path === '/announce' || path === '/scrape' || path === '/stats') {
      return tracker.handleRequest(request);
    }

    // admin endpoints
    if (path.startsWith('/admin/')) {
      return adminHandler(request, tracker, url);
    }

    // Static assets (Cloudflare Pages advanced mode exposes env.ASSETS)
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response('not found', { status: 404 });
  }
};

async function adminHandler(request, tracker, url) {
  const path = url.pathname;
  const method = request.method;
  const query = {};
  for (const [k, v] of url.searchParams) query[k] = v;

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });

  let body = null;
  if (method === 'POST' || method === 'PATCH') {
    try { body = await request.json(); } catch { body = null; }
  }

  try {
    if (path === '/admin/trackers') {
      if (method === 'GET') return json(await tracker.listTrackers());
      if (method === 'POST') return json(await tracker.addTracker(body && body.url, body && body.enabled !== false, body && body.note));
      return json({ ok: false, error: 'method not allowed' }, 405);
    }
    const m = path.match(/^\/admin\/trackers\/(.+)$/);
    if (m) {
      const targetUrl = decodeURIComponent(m[1]);
      if (method === 'DELETE') return json(await tracker.removeTracker(targetUrl));
      if (method === 'PATCH') return json(await tracker.setTracker(targetUrl, { enabled: body && body.enabled, note: body && body.note }));
      return json({ ok: false, error: 'method not allowed' }, 405);
    }
    // admin alerts API
    if (path === '/admin/alerts') {
      if (method === 'GET') return json(await tracker.listAlerts());
      if (method === 'POST') return json(await tracker.addAlert(body));
      return json({ ok: false, error: 'method not allowed' }, 405);
    }
    const m2 = path.match(/^\/admin\/alerts\/(.+)$/);
    if (m2) {
      const id = decodeURIComponent(m2[1]);
      if (method === 'DELETE') return json(await tracker.deleteAlert(id));
      if (method === 'PATCH') return json(await tracker.updateAlert(id, body));
      return json({ ok: false, error: 'method not allowed' }, 405);
    }
    if (path === '/admin/export') {
      const r = await tracker.exportTorrents();
      return json(r.data);
    }
    if (path === '/admin/import') {
      if (method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
      const merge = query.merge !== 'false';
      const r = await tracker.importTorrents(body, { merge });
      return json(r);
    }
    // external tracker usage list (dashboard "today" view)
    if (path === '/admin/tracker-links') {
      if (method !== 'GET') return json({ ok: false, error: 'method not allowed' }, 405);
      return json(await tracker.getTrackerLinks());
    }
    return json({ ok: false, error: 'not found' }, 404);
  } catch (e) {
    console.error('[tracker] admin error', e);
    return json({ ok: false, error: 'internal error' }, 500);
  }
}
