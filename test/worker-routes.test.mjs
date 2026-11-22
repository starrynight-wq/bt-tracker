import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import worker from '../src/worker.js';
import bundle from '../src/worker-bundle.js';

const DASHBOARD_HTML = await readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8');

class MemoryKV {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  async put(key, value) { this.map.set(key, String(value)); }
  async delete(key) { this.map.delete(key); }
  async list({ prefix = '' } = {}) {
    return {
      keys: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true
    };
  }
}

function makeEnv() {
  return {
    BT_TORRENTS: new MemoryKV(),
    BT_TRACKERS: new MemoryKV(),
    BT_ALERTS: new MemoryKV(),
    BT_INTERVAL: '1800',
    BT_MIN_INTERVAL: '900',
    BT_TRACKER_ID: 'test-tracker'
  };
}

function request(url, init) {
  return new Request(url, init);
}

async function json(res) {
  assert.equal(res.status, 200, `HTTP ${res.status}`);
  return res.json();
}

for (const [name, impl] of [['worker.js', worker], ['worker-bundle.js', bundle]]) {
  test(`${name}: serves /dashboard from the public dashboard.html source`, async () => {
    const env = makeEnv();
    const res = await impl.fetch(request('https://tracker.test/dashboard'), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.equal(await res.text(), DASHBOARD_HTML);
  });

  test(`${name}: redirects / to /dashboard`, async () => {
    const env = makeEnv();
    const res = await impl.fetch(request('https://tracker.test/'), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://tracker.test/dashboard');
  });

  test(`${name}: /stats works`, async () => {
    const env = makeEnv();
    const data = await json(await impl.fetch(request('https://tracker.test/stats'), env));
    assert.equal(data.ok, true);
    assert.equal(data.trackerId, 'test-tracker');
  });

  test(`${name}: /admin/tracker-links returns enabled trackers with usedToday`, async () => {
    const env = makeEnv();
    const addRes = await impl.fetch(request('https://tracker.test/admin/trackers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:9/announce', enabled: true })
    }), env);
    assert.equal(addRes.status, 200);

    const data = await json(await impl.fetch(request('https://tracker.test/admin/tracker-links'), env));
    assert.equal(data.ok, true);
    assert.equal(Array.isArray(data.trackers), true);
    assert.equal(data.trackers.length, 1);
    assert.equal(data.trackers[0].url, 'http://127.0.0.1:9/announce');
    assert.equal(data.trackers[0].usedToday, false);
    assert.equal(data.trackers[0].lastUsedAt, 0);
  });
}
