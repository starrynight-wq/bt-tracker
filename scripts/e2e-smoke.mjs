/*
 * End-to-end smoke test for the Node/Replit server (single process).
 *
 * Verifies the full flow:
 *   add external tracker -> client announce -> upstream tracker is queried
 *   -> tracker is recorded as "used today" -> /admin/tracker-links reports it
 *
 * It also verifies the budget-driven aggregation: a couple of black-holed
 * upstreams must not stop the response; healthy upstream peers are still
 * returned, and the announce stays inside the configured budget.
 *
 * Run with:  npm run smoke
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { encode, decodeSync } from '../src/bencode.js';

const PORT = Number(process.env.SMOKE_PORT || 31999);
const UPSTREAM_PORT = Number(process.env.SMOKE_UPSTREAM_PORT || 31998);
const HANG_PORT = Number(process.env.SMOKE_HANG_PORT || 31997);
const BASE = `http://127.0.0.1:${PORT}`;
const ANNOUNCE_BUDGET_MS = 1200;
const UPSTREAM_TIMEOUT_MS = 800;

const tmp = await mkdtemp(path.join(os.tmpdir(), 'bt-tracker-e2e-'));

/* ---- fake upstream tracker (bencoded announce response) ---- */
const upstream = createServer((req, res) => {
  const peers = new Uint8Array([1, 2, 3, 4, 0x1f, 0x90]); // 1.2.3.4:8080
  const body = new Uint8Array(encode({ interval: 1800, complete: 1, incomplete: 0, peers }));
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(Buffer.from(body));
});
await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve));

/* ---- black-holed upstreams: accept the request but never answer ---- */
const hangSockets = new Set();
const hangingUpstream = createServer(() => { /* deliberately never respond */ });
hangingUpstream.on('connection', (socket) => {
  hangSockets.add(socket);
  socket.on('close', () => hangSockets.delete(socket));
});
await new Promise((resolve) => hangingUpstream.listen(HANG_PORT, '127.0.0.1', resolve));

/* ---- configure and start the tracker server (import starts it) ---- */
process.env.PORT = String(PORT);
process.env.TORRENTS_PATH = path.join(tmp, 'torrents.json');
process.env.TRACKERS_PATH = path.join(tmp, 'trackers.json');
process.env.ALERTS_PATH = path.join(tmp, 'alerts.json');
process.env.DASHBOARD_PATH = path.resolve('public', 'dashboard.html');
process.env.TRACKER_ANNOUNCE_BUDGET_MS = String(ANNOUNCE_BUDGET_MS);
process.env.TRACKER_UPSTREAM_TIMEOUT_MS = String(UPSTREAM_TIMEOUT_MS);

await import('../src/server.js');

async function waitReady(url) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become ready: ' + url);
}

function cleanup(code) {
  try { upstream.close(); } catch {}
  try { hangingUpstream.close(); } catch {}
  for (const socket of hangSockets) { try { socket.destroy(); } catch {} }
  process.exit(code);
}

try {
  await waitReady(`${BASE}/stats`);

  /* dashboard is served */
  const html = await (await fetch(`${BASE}/dashboard`)).text();
  assert.match(html, /今日使用的外部 Tracker/);

  /* add the fake upstream tracker + two black-holed upstreams */
  let res = await fetch(`${BASE}/admin/trackers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${UPSTREAM_PORT}/announce`, enabled: true, note: 'e2e' })
  });
  assert.equal(res.status, 200);
  for (const i of [1, 2]) {
    res = await fetch(`${BASE}/admin/trackers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${HANG_PORT}/announce?dead=${i}`, enabled: true, note: 'black-hole' })
    });
    assert.equal(res.status, 200);
  }

  /* before any announce: not used today */
  let links = await (await fetch(`${BASE}/admin/tracker-links`)).json();
  assert.equal(links.ok, true);
  assert.equal(links.trackers.length, 3);
  assert.equal(links.trackers.every((t) => t.usedToday === false), true);

  /* announce -> healthy upstream queried, black-holed ones cut off by the budget */
  const started = Date.now();
  res = await fetch(`${BASE}/announce?info_hash=0123456789abcdef0123456789abcdef01234567&peer_id=abcdefghijklmnopqrst&port=6881&left=0&compact=1`);
  const elapsed = Date.now() - started;
  assert.equal(res.status, 200);
  assert.ok(elapsed < ANNOUNCE_BUDGET_MS + 1500, `announce should stay near the budget, took ${elapsed}ms`);

  const announceBody = decodeSync(new Uint8Array(await res.arrayBuffer()));
  assert.equal(announceBody['failure reason'], undefined, 'must not fail the whole announce');
  const peers = announceBody.peers;
  assert.ok(peers instanceof Uint8Array && peers.length >= 6, 'healthy upstream peers must be merged into the response');

  links = await (await fetch(`${BASE}/admin/tracker-links`)).json();
  const byUrl = new Map(links.trackers.map((t) => [t.url, t]));
  assert.equal(byUrl.get(`http://127.0.0.1:${UPSTREAM_PORT}/announce`).usedToday, true, 'healthy tracker should be marked as used');
  assert.equal(typeof links.date, 'string');

  /* enabled=all and date filtering */
  const all = await (await fetch(`${BASE}/admin/tracker-links?enabled=all`)).json();
  assert.equal(all.trackers.length, 3);
  const past = await (await fetch(`${BASE}/admin/tracker-links?date=2000-01-01`)).json();
  assert.equal(past.ok, true);
  assert.equal(past.date, '2000-01-01');
  assert.equal(past.trackers.every((t) => t.usedToday === false), true);
  const badDate = await fetch(`${BASE}/admin/tracker-links?date=2000-13-01`);
  assert.equal(badDate.status, 400);

  /* stats reflect the usage */
  const stats = await (await fetch(`${BASE}/stats`)).json();
  assert.equal(stats.ok, true);
  assert.equal(stats.trackers, 3);
  assert.ok(stats.stats.announces >= 1);

  console.log('[smoke] OK: budget-bounded announce returned partial peers; tracker-links usedToday/date/enabled filters ok');
  cleanup(0);
} catch (e) {
  console.error('[smoke] FAILED:', e);
  cleanup(1);
}
