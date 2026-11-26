import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/worker.js';
import { encode, decodeSync } from '../src/bencode.js';
import { CF_MAX_UPSTREAMS_PER_CALL } from '../src/adapters/cloudflare.js';

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567';
const ANNOUNCE_PATH = `/announce?info_hash=${INFO_HASH}&peer_id=abcdefghijklmnopqrst&port=6881&left=0&compact=1`;

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
    BT_TRACKER_ID: 'cf-limit-test',
    // Aggregation must be capped by the adapter's 40-upstream limit, not the budget.
    BT_ANNOUNCE_BUDGET_MS: '5000',
    BT_UPSTREAM_TIMEOUT_MS: '1000',
    BT_INTERVAL: '1800',
    BT_MIN_INTERVAL: '900'
  };
}

function announceBody() {
  // compact peer 1.2.3.4:8080
  return new Uint8Array(encode({ interval: 1800, complete: 1, incomplete: 0, peers: new Uint8Array([1, 2, 3, 4, 0x1f, 0x90]) }));
}

async function addTrackers(env, n) {
  for (let i = 0; i < n; i++) {
    const url = `http://tracker${i}.example/announce`;
    const res = await worker.fetch(new Request('https://tracker.test/admin/trackers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, enabled: true })
    }), env);
    assert.equal(res.status, 200);
  }
}

async function announce(env) {
  const res = await worker.fetch(new Request(`https://tracker.test${ANNOUNCE_PATH}`), env);
  assert.equal(res.status, 200);
  return decodeSync(new Uint8Array(await res.arrayBuffer()));
}

function pendingFromKV(env) {
  const raw = env.BT_TORRENTS.map.get('bt:' + INFO_HASH);
  if (!raw) return null;
  return JSON.parse(raw);
}

test('Cloudflare adapter caps a real worker announce at 40 upstreams and keeps the rest pending', async () => {
  const env = makeEnv();
  await addTrackers(env, 45);

  const calledRounds = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calledRounds[calledRounds.length - 1].push(String(url));
    return new Response(announceBody(), { status: 200 });
  };
  try {
    // ---- round 1: 45 upstreams configured, only 40 may be queried ----
    calledRounds.push([]);
    const first = await announce(env);
    assert.equal(calledRounds[0].length, CF_MAX_UPSTREAMS_PER_CALL, 'must query exactly the 40-upstream cap');
    assert.equal(first.interval, 120, 'incomplete results -> bootstrap interval');
    assert.ok(first['min interval'] <= 120, 'bootstrap min interval must allow 120s');
    assert.equal(first.peers.length, 6, 'healthy upstream peers are still merged');

    const state1 = pendingFromKV(env);
    assert.equal(state1.pendingUpstreams.length, 5, 'remaining 5 upstreams persist as pending');
    assert.ok(state1.bootstrapUntil > Date.now());

    // ---- round 2: pending upstreams are retried first ----
    calledRounds.push([]);
    const second = await announce(env);
    assert.equal(calledRounds[1].length, CF_MAX_UPSTREAMS_PER_CALL);
    assert.equal(second.interval, 120, 'still incomplete -> bootstrap interval stays');
    assert.deepEqual(
      calledRounds[1].slice(0, 5).map((u) => String(u).split('?')[0]),
      state1.pendingUpstreams.slice(0, 5),
      'pending upstreams must be queried first on the next announce'
    );

    // round 2 covers the previous 5 pending + 35 of the first 40 -> 5 new pending
    const state2 = pendingFromKV(env);
    assert.equal(state2.pendingUpstreams.length, 5);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Cloudflare worker announce also skips udp:// upstreams entirely', async () => {
  const env = makeEnv();
  for (const url of ['udp://tracker.example:1337/announce', 'http://tracker.example/announce']) {
    const res = await worker.fetch(new Request('https://tracker.test/admin/trackers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, enabled: true })
    }), env);
    assert.equal(res.status, 200);
  }

  const called = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    called.push(String(url));
    return new Response(announceBody(), { status: 200 });
  };
  try {
    const body = await announce(env);
    assert.equal(called.length, 1, 'udp:// must not be fetched');
    assert.ok(called[0].startsWith('http://'));
    // udp tracker is not pending either: it is unsupported, not deferred
    const state = pendingFromKV(env);
    assert.deepEqual(state.pendingUpstreams, []);
    assert.equal(body.interval, 1800);
  } finally {
    globalThis.fetch = realFetch;
  }
});
