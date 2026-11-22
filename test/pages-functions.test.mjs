import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from '../functions/[[path]].js';

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

const env = () => ({
  BT_TORRENTS: new MemoryKV(),
  BT_TRACKERS: new MemoryKV(),
  BT_ALERTS: new MemoryKV()
});

test('Pages Functions onRequest serves the dashboard', async () => {
  const res = await onRequest({ request: new Request('https://page.test/dashboard'), env: env() });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /今日使用的外部 Tracker/);
});

test('Pages Functions onRequest exposes /admin/tracker-links', async () => {
  const ctx = { request: new Request('https://page.test/admin/tracker-links'), env: env() };
  const res = await onRequest(ctx);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.deepEqual(data.trackers, []);
});
