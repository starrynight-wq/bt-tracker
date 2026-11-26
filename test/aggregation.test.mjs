import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStore } from '../src/store.js';
import { Tracker } from '../src/tracker.js';
import { decodeSync } from '../src/bencode.js';

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567';
const PEER_ID = 'abcdefghijklmnopqrst';

function announceUrl(extra = '') {
  return `http://tracker.local/announce?info_hash=${INFO_HASH}&peer_id=${PEER_ID}&port=6881&left=0&compact=1${extra}`;
}

function makeTracker({ store, adapter, budgetMs } = {}) {
  return new Tracker({
    store,
    adapter,
    interval: 1800,
    minInterval: 900,
    trackerId: 'aggregation-test',
    ...(budgetMs ? { budgetMs } : {})
  });
}

async function announce(tracker, options) {
  const res = await tracker.handleRequest({ url: announceUrl() }, options);
  const body = decodeSync(new Uint8Array(await res.arrayBuffer()));
  return { res, body };
}

async function addTrackers(store, urls) {
  for (const url of urls) await store.putTracker(url, { url, enabled: true, addedAt: Date.now() });
}

async function getTorrent(store) {
  return (await store.getTorrents()).get(INFO_HASH);
}

test('aggregation calls the adapter once with the whole upstream batch (no serial loop)', async () => {
  const store = new MemoryStore();
  const urls = ['http://a.example/announce', 'http://b.example/announce', 'http://c.example/announce', 'http://d.example/announce'];
  await addTrackers(store, urls);

  const calls = [];
  const adapter = {
    fetchPeersBatch: async (infoHash, peerParams, upstreamUrls, budgetMs) => {
      calls.push({ infoHash, upstreamUrls, budgetMs });
      return {
        results: upstreamUrls.map((url) => ({ url, ok: true, peers: [{ ip: '9.9.9.9', port: 6881 }], complete: 1, incomplete: 0 })),
        pendingUrls: [],
        unsupportedUrls: []
      };
    }
  };
  const tracker = makeTracker({ store, adapter });
  const { res, body } = await announce(tracker);

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1, 'adapter must be called once per announce, not once per upstream');
  assert.deepEqual(calls[0].upstreamUrls, urls);
  assert.equal(calls[0].budgetMs, 8000, 'default budget is 8000ms');
  assert.ok(body.peers.length > 0);
});

test('all upstreams hanging still yields a valid bencoded response within the budget', async () => {
  const store = new MemoryStore();
  await addTrackers(store, ['http://a.example/announce', 'http://b.example/announce', 'http://c.example/announce']);
  // Adapter that ignores its budget and never resolves.
  const tracker = makeTracker({ store, adapter: { fetchPeersBatch: () => new Promise(() => {}) } });

  const started = Date.now();
  const { res, body } = await announce(tracker, { budgetMs: 300 });
  const elapsed = Date.now() - started;

  assert.equal(res.status, 200);
  assert.equal(body['failure reason'], undefined, 'must not return a failure response');
  assert.ok(elapsed < 2000, `announce should return fast, took ${elapsed}ms`);
  assert.ok(Array.isArray(body.peers) || body.peers instanceof Uint8Array);
  // pending upstreams -> bootstrap interval (short) is legal
  assert.ok(body.interval >= 120 && body.interval <= 1800, `unexpected interval ${body.interval}`);
});

test('bootstrap: pending upstreams produce 120s interval until cleared, then normal interval', async () => {
  const store = new MemoryStore();
  const urls = ['http://a.example/announce', 'http://b.example/announce', 'http://c.example/announce'];
  await addTrackers(store, urls);

  let round = 0;
  const plans = [];
  const adapter = {
    fetchPeersBatch: async (infoHash, peerParams, upstreamUrls) => {
      round++;
      plans.push(upstreamUrls.slice());
      if (round === 1) {
        return {
          results: [{ url: upstreamUrls[0], ok: true, peers: [{ ip: '1.1.1.1', port: 1 }], complete: 1, incomplete: 0 }],
          pendingUrls: upstreamUrls.slice(1),
          unsupportedUrls: []
        };
      }
      return {
        results: upstreamUrls.map((url) => ({ url, ok: true, peers: [{ ip: '2.2.2.2', port: 2 }], complete: 0, incomplete: 1 })),
        pendingUrls: [],
        unsupportedUrls: []
      };
    }
  };
  const tracker = makeTracker({ store, adapter });

  const first = await announce(tracker);
  assert.equal(first.body.interval, 120, 'bootstrap interval should be 120s while upstreams are pending');
  assert.ok(first.body['min interval'] <= 120, 'advertised min interval must allow the short interval');
  const tor = await getTorrent(store);
  assert.equal(tor.pendingUpstreams.length, 2);
  assert.ok(tor.bootstrapUntil > Date.now(), 'bootstrapUntil should be in the future');

  const second = await announce(tracker);
  assert.equal(second.body.interval, 1800, 'normal interval restored once pending list is cleared');
  assert.equal(second.body['min interval'], 900);
  const torAfter = await getTorrent(store);
  assert.deepEqual(torAfter.pendingUpstreams, []);
  assert.equal(torAfter.bootstrapUntil, 0);

  // pending URLs were queried first in round 2
  assert.equal(round, 2);
  assert.deepEqual(plans[1].slice(0, 2), urls.slice(1), 'pending upstreams must be retried first');
});

test('bootstrap window expiry drops stale pending upstreams and restores normal interval', async () => {
  const store = new MemoryStore();
  await addTrackers(store, ['http://a.example/announce', 'http://b.example/announce']);
  const adapter = {
    fetchPeersBatch: async (infoHash, peerParams, upstreamUrls) => ({
      results: [],
      pendingUrls: upstreamUrls.slice(),
      unsupportedUrls: []
    })
  };
  const tracker = makeTracker({ store, adapter });

  const first = await announce(tracker);
  assert.equal(first.body.interval, 120);

  // Simulate a client that comes back after the bootstrap window expired.
  const tor = await getTorrent(store);
  tor.bootstrapUntil = Date.now() - 1000;
  await store.putTorrent(INFO_HASH, tor);

  const second = await announce(tracker);
  assert.equal(second.body.interval, 1800, 'expired bootstrap must not keep the short interval');
  assert.equal(second.body['min interval'], 900);
  const torAfter = await getTorrent(store);
  assert.deepEqual(torAfter.pendingUpstreams, []);
  assert.equal(torAfter.bootstrapUntil, 0);
});

test('tracker without adapter still serves a normal announce', async () => {
  const store = new MemoryStore();
  await addTrackers(store, ['http://a.example/announce']);
  const tracker = makeTracker({ store /* no adapter */ });
  const { res, body } = await announce(tracker);
  assert.equal(res.status, 200);
  assert.equal(body.interval, 1800);
  assert.equal(body['min interval'], 900);
});

test('only successful upstream results are marked as used', async () => {
  const store = new MemoryStore();
  const okUrl = 'http://ok.example/announce';
  const badUrl = 'http://bad.example/announce';
  await addTrackers(store, [okUrl, badUrl]);
  const tracker = makeTracker({
    store,
    adapter: {
      fetchPeersBatch: async (infoHash, peerParams, upstreamUrls) => ({
        results: upstreamUrls.map((url) => ({ url, ok: url === okUrl, peers: [] })),
        pendingUrls: [],
        unsupportedUrls: []
      })
    }
  });

  await announce(tracker);
  const trackers = await store.getTrackers();
  assert.ok(trackers.get(okUrl).lastUsedAt > 0);
  assert.equal(trackers.get(badUrl).lastUsedAt, undefined);
});

test('a throwing adapter does not break the announce response', async () => {
  const store = new MemoryStore();
  await addTrackers(store, ['http://a.example/announce']);
  const tracker = makeTracker({
    store,
    adapter: { fetchPeersBatch: async () => { throw new Error('adapter exploded'); } }
  });

  const { res, body } = await announce(tracker);
  assert.equal(res.status, 200);
  assert.equal(body['failure reason'], undefined);
  // the upstream is retried on the next announce
  const tor = await getTorrent(store);
  assert.equal(tor.pendingUpstreams.length, 1);
});

test('custom budget is forwarded to the adapter', async () => {
  const store = new MemoryStore();
  await addTrackers(store, ['http://a.example/announce']);
  let seenBudget = 0;
  const tracker = makeTracker({
    store,
    budgetMs: 1500,
    adapter: {
      fetchPeersBatch: async (infoHash, peerParams, upstreamUrls, budgetMs) => {
        seenBudget = budgetMs;
        return { results: [], pendingUrls: [], unsupportedUrls: [] };
      }
    }
  });
  await announce(tracker);
  assert.equal(seenBudget, 1500);
});
