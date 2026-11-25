import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStore } from '../src/store.js';
import { Tracker } from '../src/tracker.js';

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567';
const PEER_ID = 'abcdefghijklmnopqrst';

function announceUrl(extra = '') {
  return `http://tracker.local/announce?info_hash=${INFO_HASH}&peer_id=${PEER_ID}&port=6881&left=0&compact=1${extra}`;
}

function makeTracker({ store, externalFetch }) {
  return new Tracker({
    store,
    interval: 1800,
    minInterval: 900,
    trackerId: 'test-tracker',
    externalFetch
  });
}

test('touchTracker records lastUsedAt in MemoryStore', async () => {
  const store = new MemoryStore();
  await store.putTracker('http://up.example/announce', { url: 'http://up.example/announce', enabled: true, addedAt: Date.now() });
  const before = (await store.getTrackers()).get('http://up.example/announce');
  assert.equal(before.lastUsedAt, undefined);

  await store.touchTracker('http://up.example/announce');
  const after = (await store.getTrackers()).get('http://up.example/announce');
  assert.equal(typeof after.lastUsedAt, 'number');
  assert.ok(after.lastUsedAt > 0);

  // unknown tracker is a no-op
  await store.touchTracker('http://missing.example/announce');
  assert.equal((await store.getTrackers()).has('http://missing.example/announce'), false);
});

test('getTrackerLinks marks a tracker as used today after a successful external fetch', async () => {
  const store = new MemoryStore();
  const tracker = makeTracker({
    store,
    externalFetch: async () => ({ ok: true, peers: [{ ip: '1.2.3.4', port: 51413 }], complete: 1, incomplete: 0 })
  });

  await tracker.addTracker('http://up.example/announce', true, 'upstream');

  let links = await tracker.getTrackerLinks();
  assert.equal(links.ok, true);
  assert.equal(links.trackers.length, 1);
  assert.equal(links.trackers[0].url, 'http://up.example/announce');
  assert.equal(links.trackers[0].usedToday, false);
  assert.equal(links.trackers[0].lastUsedAt, 0);

  // announce triggers the external fetch and thus touchTracker
  const res = await tracker.handleRequest({ url: announceUrl() });
  assert.equal(res.status, 200);

  links = await tracker.getTrackerLinks();
  assert.equal(links.trackers[0].usedToday, true);
  assert.ok(links.trackers[0].lastUsedAt >= startOfToday());
  assert.equal(typeof links.trackers[0].usedDate, 'string');
});

test('getTrackerLinks only returns enabled trackers', async () => {
  const store = new MemoryStore();
  const tracker = makeTracker({ store, externalFetch: async () => ({ ok: false }) });
  await tracker.addTracker('http://enabled.example/announce', true);
  await tracker.addTracker('http://disabled.example/announce', false);

  const links = await tracker.getTrackerLinks();
  assert.equal(links.trackers.length, 1);
  assert.equal(links.trackers[0].url, 'http://enabled.example/announce');
});

test('a failed external fetch does not mark the tracker as used', async () => {
  const store = new MemoryStore();
  const tracker = makeTracker({ store, externalFetch: async () => ({ ok: false }) });
  await tracker.addTracker('http://down.example/announce', true);

  const res = await tracker.handleRequest({ url: announceUrl() });
  assert.equal(res.status, 200);

  const links = await tracker.getTrackerLinks();
  assert.equal(links.trackers[0].usedToday, false);
  assert.equal(links.trackers[0].lastUsedAt, 0);
});

test('getTrackerLinks({ includeDisabled: true }) returns disabled trackers too', async () => {
  const store = new MemoryStore();
  const tracker = makeTracker({ store, externalFetch: async () => ({ ok: false }) });
  await tracker.addTracker('http://enabled.example/announce', true, 'on');
  await tracker.addTracker('http://disabled.example/announce', false, 'off');

  const links = await tracker.getTrackerLinks({ includeDisabled: true });
  assert.equal(links.trackers.length, 2);
  const byUrl = new Map(links.trackers.map((t) => [t.url, t]));
  assert.equal(byUrl.get('http://enabled.example/announce').note, 'on');
  assert.equal(byUrl.get('http://disabled.example/announce').enabled, false);
  assert.equal(byUrl.get('http://disabled.example/announce').note, 'off');
});

test('getTrackerLinks({ date }) evaluates usedToday on the requested day', async () => {
  const store = new MemoryStore();
  const tracker = makeTracker({ store, externalFetch: async () => ({ ok: true, peers: [] }) });
  await tracker.addTracker('http://up.example/announce', true);

  await tracker.handleRequest({ url: announceUrl() });

  const today = (await tracker.getTrackerLinks()).date;
  const onToday = await tracker.getTrackerLinks({ date: today });
  assert.equal(onToday.ok, true);
  assert.equal(onToday.date, today);
  assert.equal(onToday.trackers[0].usedToday, true);

  const yesterday = shiftDate(today, -1);
  const onYesterday = await tracker.getTrackerLinks({ date: yesterday });
  assert.equal(onYesterday.ok, true);
  assert.equal(onYesterday.date, yesterday);
  assert.equal(onYesterday.trackers[0].usedToday, false);
});

test('getTrackerLinks rejects an invalid date', async () => {
  const store = new MemoryStore();
  const tracker = makeTracker({ store, externalFetch: async () => ({ ok: false }) });

  for (const bad of ['2026-13-01', '2026-02-30', '20261125', 'abc']) {
    const r = await tracker.getTrackerLinks({ date: bad });
    assert.equal(r.ok, false, `date ${bad} should be rejected`);
    assert.equal(r.error, 'invalid date, expected YYYY-MM-DD');
  }
});

function shiftDate(yyyyMmDd, days) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
