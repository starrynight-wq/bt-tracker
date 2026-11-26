import test from 'node:test';
import assert from 'node:assert/strict';

import { encode } from '../src/bencode.js';
import {
  createNodeAdapter,
  NODE_DEFAULT_CONCURRENCY,
  NODE_MAX_CONCURRENCY
} from '../src/adapters/node.js';
import {
  createCloudflareAdapter,
  CF_MAX_UPSTREAMS_PER_CALL,
  CF_MAX_CONCURRENT_CONNECTIONS
} from '../src/adapters/cloudflare.js';

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567';
const PARAMS = { info_hash: INFO_HASH, peer_id: 'abcdefghijklmnopqrst', port: 6881, left: 0, compact: 1 };

function announceBody(peers = new Uint8Array([1, 2, 3, 4, 0x1f, 0x90])) {
  return new Uint8Array(encode({ complete: 1, incomplete: 0, interval: 1800, peers }));
}

function okFetch(counter = { calls: 0 }) {
  const impl = async () => {
    counter.calls++;
    return new Response(announceBody(), { status: 200 });
  };
  return { impl, counter };
}

function urls(n, scheme = 'http') {
  return Array.from({ length: n }, (_, i) => `${scheme}://tracker${i}.example/announce`);
}

test('node adapter parses compact peers from the announce response', async () => {
  const adapter = createNodeAdapter({ fetchImpl: okFetch().impl });
  const batch = await adapter.fetchPeersBatch(INFO_HASH, PARAMS, ['http://a.example/announce'], 2000);

  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0].ok, true);
  assert.deepEqual(batch.results[0].peers, [{ ip: '1.2.3.4', port: 8080, peerId: 'ext' }]);
  assert.equal(batch.results[0].complete, 1);
  assert.equal(batch.pendingUrls.length, 0);
});

test('node adapter skips udp:// trackers without fetching them', async () => {
  const { impl, counter } = okFetch();
  const adapter = createNodeAdapter({ fetchImpl: impl });
  const batch = await adapter.fetchPeersBatch(
    INFO_HASH,
    PARAMS,
    ['udp://tracker.example:1337/announce', 'http://ok.example/announce', 'UDP://upper.example:80/announce'],
    2000
  );

  assert.equal(counter.calls, 1, 'only the http tracker should be fetched');
  assert.equal(batch.unsupportedUrls.length, 2);
  assert.ok(batch.unsupportedUrls[0].startsWith('udp://'));
  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0].url, 'http://ok.example/announce');
});

test('node adapter respects its concurrency limit', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const fetchImpl = async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 30));
    concurrent--;
    return new Response(announceBody(), { status: 200 });
  };
  assert.ok(NODE_DEFAULT_CONCURRENCY >= 20 && NODE_DEFAULT_CONCURRENCY <= 30);
  const adapter = createNodeAdapter({ fetchImpl, concurrency: 3 });
  const batch = await adapter.fetchPeersBatch(INFO_HASH, PARAMS, urls(9), 3000);

  assert.equal(batch.results.length, 9);
  assert.equal(batch.pendingUrls.length, 0);
  assert.ok(maxConcurrent <= 3, `max concurrent connections was ${maxConcurrent}`);
  assert.ok(NODE_MAX_CONCURRENCY <= 30);
});

test('node adapter returns within the budget even when every upstream hangs', async () => {
  const adapter = createNodeAdapter({
    // ignores the abort signal on purpose: the adapter must still return
    fetchImpl: () => new Promise(() => {}),
    perRequestTimeoutMs: 5000
  });
  const started = Date.now();
  const batch = await adapter.fetchPeersBatch(INFO_HASH, PARAMS, urls(6), 300);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2000, `batch took ${elapsed}ms`);
  assert.equal(batch.results.length + batch.pendingUrls.length, 6);
  assert.equal(batch.queried, batch.results.length);
});

test('cloudflare adapter caps a batch at 40 upstreams and keeps the rest pending', async () => {
  const { impl, counter } = okFetch();
  const adapter = createCloudflareAdapter({ fetchImpl: impl });
  const batch = await adapter.fetchPeersBatch(INFO_HASH, PARAMS, urls(45), 4000);

  assert.equal(CF_MAX_UPSTREAMS_PER_CALL, 40);
  assert.equal(CF_MAX_CONCURRENT_CONNECTIONS, 6);
  assert.equal(counter.calls, 40);
  assert.equal(batch.results.length, 40);
  assert.equal(batch.pendingUrls.length, 5);
  assert.equal(batch.planned, 40);
});

test('cloudflare adapter bails out of the fetch loop for udp:// tracker lists', async () => {
  const { impl, counter } = okFetch();
  const adapter = createCloudflareAdapter({ fetchImpl: impl });
  const batch = await adapter.fetchPeersBatch(INFO_HASH, PARAMS, urls(3, 'udp'), 2000);

  assert.equal(counter.calls, 0);
  assert.equal(batch.unsupportedUrls.length, 3);
  assert.equal(batch.results.length, 0);
  assert.equal(batch.pendingUrls.length, 0);
});

test('a slow upstream is cut off by the per-request timeout', async () => {
  const adapter = createNodeAdapter({
    perRequestTimeoutMs: 40,
    fetchImpl: () => new Promise((resolve) => setTimeout(() => resolve(new Response(announceBody(), { status: 200 })), 500))
  });
  const batch = await adapter.fetchPeersBatch(INFO_HASH, PARAMS, ['http://slow.example/announce'], 2000);

  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0].ok, false);
  assert.match(String(batch.results[0].error), /timeout|fetch/);
});
