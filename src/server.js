import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileStore } from './file-store.js';
import { Tracker } from './tracker.js';

const PORT = Number(process.env.PORT || 3000);
const INTERVAL = Number(process.env.TRACKER_INTERVAL || 1800);
const MIN_INTERVAL = Number(process.env.TRACKER_MIN_INTERVAL || 900);
const TRACKER_ID = process.env.TRACKER_ID || 'bt-tracker';

const store = new FileStore({
  torrentsPath: process.env.TORRENTS_PATH,
  trackersPath: process.env.TRACKERS_PATH,
  alertsPath: process.env.ALERTS_PATH
});

const tracker = new Tracker({
  store,
  interval: INTERVAL,
  minInterval: MIN_INTERVAL,
  trackerId: TRACKER_ID,
  /* External tracker fetcher for Node/Replit */
  externalFetch: async (url, params) => {
    try {
      const u = new URL(url);
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined) continue;
        u.searchParams.set(k, String(v));
      }
      const res = await fetch(u.toString(), {
        method: 'GET',
        headers: { 'User-Agent': 'bt-tracker/1.0' },
        // fail fast on dead external trackers
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) return { ok: false };
      const body = new Uint8Array(await res.arrayBuffer());
      // decode bencode
      const { decodeSync } = await import('./bencode.js');
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
        // compact peers: 6 bytes per peer
        for (let i = 0; i + 5 < p.length; i += 6) {
          const ip = [p[i], p[i+1], p[i+2], p[i+3]].join('.');
          const port = (p[i+4] << 8) | p[i+5];
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
});

async function init() {
  await store.init();
}

const DASHBOARD_PATH = process.env.DASHBOARD_PATH || join(process.cwd(), 'public', 'dashboard.html');
let dashboardHtml = null;
async function loadDashboardHtml() {
  try {
    dashboardHtml = await readFile(DASHBOARD_PATH, 'utf8');
  } catch (e) {
    console.error('[tracker] failed to load dashboard.html', e);
  }
}

const server = createServer(async (req, res) => {
  // Node http server doesn't give a Request object; build a minimal one
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method;

  // Collect body for admin endpoints
  let body = '';
  await new Promise((resolve, reject) => {
    req.on('data', chunk => { body += chunk; });
    req.on('end', resolve);
    req.on('error', reject);
  });

  const path = url.pathname;
  const query = {};
  for (const [k, v] of url.searchParams) query[k] = v;

  const send = (status, content, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
    res.end(content);
  };

  try {
    // Dashboard HTML
    if (path === '/dashboard' || path === '/dashboard/') {
      if (!dashboardHtml) return send(500, 'dashboard not loaded');
      send(200, dashboardHtml, 'text/html; charset=utf-8');
      return;
    }

    // tracker announce/scrape/stats
    if (path === '/announce' || path === '/scrape' || path === '/stats') {
      // Build a Request-like object for tracker.handleRequest
      const fakeReq = { url: url.toString() };
      const response = await tracker.handleRequest(fakeReq);
      const text = await response.text();
      send(response.status, text, response.headers.get('content-type') || 'text/plain');
      return;
    }

    // admin API (JSON)
    if (path === '/admin/trackers') {
      if (method === 'GET') {
        const r = await tracker.listTrackers();
        send(200, JSON.stringify(r), 'application/json');
      } else if (method === 'POST') {
        const d = body ? JSON.parse(body || '{}') : {};
        const r = await tracker.addTracker(d.url, d.enabled !== false, d.note);
        send(r.ok ? 200 : 400, JSON.stringify(r), 'application/json');
      } else {
        send(405, JSON.stringify({ ok: false, error: 'method not allowed' }), 'application/json');
      }
      return;
    }
    const m = path.match(/^\/admin\/trackers\/(.+)$/);
    if (m) {
      const url2 = decodeURIComponent(m[1]);
      if (method === 'DELETE') {
        const r = await tracker.removeTracker(url2);
        send(200, JSON.stringify(r), 'application/json');
      } else if (method === 'PATCH') {
        const d = body ? JSON.parse(body || '{}') : {};
        const r = await tracker.setTracker(url2, { enabled: d.enabled, note: d.note });
        send(200, JSON.stringify(r), 'application/json');
      } else {
        send(405, JSON.stringify({ ok: false, error: 'method not allowed' }), 'application/json');
      }
      return;
    }
    // admin alerts API
    if (path === '/admin/alerts') {
      if (method === 'GET') {
        const r = await tracker.listAlerts();
        send(200, JSON.stringify(r), 'application/json');
      } else if (method === 'POST') {
        const d = body ? JSON.parse(body || '{}') : {};
        const r = await tracker.addAlert(d);
        send(r.ok ? 200 : 400, JSON.stringify(r), 'application/json');
      } else {
        send(405, JSON.stringify({ ok: false, error: 'method not allowed' }), 'application/json');
      }
      return;
    }
    const m2 = path.match(/^\/admin\/alerts\/(.+)$/);
    if (m2) {
      const id = decodeURIComponent(m2[1]);
      if (method === 'DELETE') {
        const r = await tracker.deleteAlert(id);
        send(200, JSON.stringify(r), 'application/json');
      } else if (method === 'PATCH') {
        const d = body ? JSON.parse(body || '{}') : {};
        const r = await tracker.updateAlert(id, d);
        send(200, JSON.stringify(r), 'application/json');
      } else {
        send(405, JSON.stringify({ ok: false, error: 'method not allowed' }), 'application/json');
      }
      return;
    }
    if (path === '/admin/export') {
      const r = await tracker.exportTorrents();
      send(200, JSON.stringify(r.data), 'application/json');
      return;
    }
    if (path === '/admin/import') {
      if (method !== 'POST') {
        send(405, JSON.stringify({ ok: false, error: 'method not allowed' }), 'application/json');
        return;
      }
      let data;
      try { data = JSON.parse(body || '{}'); } catch { send(400, JSON.stringify({ ok: false, error: 'invalid json' }), 'application/json'); return; }
      const merge = query.merge !== 'false';
      const r = await tracker.importTorrents(data, { merge });
      send(200, JSON.stringify(r), 'application/json');
      return;
    }

    if (path === '/admin/tracker-links') {
      const includeDisabled = query.enabled === 'all';
      const r = await tracker.getTrackerLinks({ includeDisabled, date: query.date || null });
      send(r.ok ? 200 : 400, JSON.stringify(r), 'application/json');
      return;
    }

    send(404, 'not found');
  } catch (e) {
    console.error('[tracker] request error', e);
    send(500, 'internal error');
  }
});

init().then(async () => {
  await loadDashboardHtml();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[tracker] listening on http://0.0.0.0:${PORT}`);
  });
}).catch(err => {
  console.error('[tracker] init failed', err);
  process.exit(1);
});
