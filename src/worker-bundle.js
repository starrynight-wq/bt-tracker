/*
 * bt-tracker — Single-file Cloudflare Worker bundle.
 *
 * Deploy WITHOUT the CLI:
 *   1. Copy the entire contents of this file.
 *   2. Cloudflare dashboard → Workers & Pages → Create → Create a Worker
 *   3. Paste this code into the editor, click Deploy.
 *   4. Add KV namespace bindings: BT_TORRENTS, BT_TRACKERS, BT_ALERTS
 *   5. Add environment variables (optional): BT_INTERVAL, BT_MIN_INTERVAL, BT_TRACKER_ID
 *   6. Open https://<your-worker>.workers.dev/dashboard
 *
 * Bundles: bencode.js + store.js + tracker.js + worker.js
 */

'use strict';

/* ============================ bencode.js ============================ */

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function isBytes(v) { return v instanceof Uint8Array; }
function toBytes(v) {
  if (isBytes(v)) return v;
  if (typeof v === 'string') return ENC.encode(v);
  throw new Error('bencode: expected string or Uint8Array');
}
function asString(v) {
  if (typeof v === 'string') return v;
  return DEC.decode(v);
}
function cmpBytes(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
function encodeStr(s) { return ENC.encode(s); }

function encode(val) {
  if (val === null || val === undefined) throw new Error('bencode: cannot encode null/undefined');
  if (typeof val === 'number') {
    if (!Number.isInteger(val)) throw new Error('bencode: integer expected');
    return concat([encodeStr('i'), ENC.encode(val.toString(10)), encodeStr('e')]);
  }
  if (typeof val === 'string' || isBytes(val)) {
    const b = toBytes(val);
    return concat([encodeStr(b.length.toString(10)), encodeStr(':'), b]);
  }
  if (Array.isArray(val)) {
    const parts = [encodeStr('l')];
    for (const item of val) parts.push(encode(item));
    parts.push(encodeStr('e'));
    return concat(parts);
  }
  if (typeof val === 'object') {
    const entries = [];
    for (const key of Object.keys(val)) {
      entries.push({ key: toBytes(key), val: val[key] });
    }
    entries.sort((a, b) => cmpBytes(a.key, b.key));
    const parts = [encodeStr('d')];
    for (const e of entries) {
      parts.push(encodeStr(e.key.length.toString(10)));
      parts.push(encodeStr(':'));
      parts.push(e.key);
      parts.push(encode(e.val));
    }
    parts.push(encodeStr('e'));
    return concat(parts);
  }
  throw new Error('bencode: unsupported type ' + typeof val);
}

function decode(input, pos = 0) {
  const bytes = isBytes(input) ? input : ENC.encode(input);
  if (pos >= bytes.length) throw new Error('bencode: unexpected end of input');
  const c = bytes[pos];

  if (c >= 0x30 && c <= 0x39) {
    let end = pos;
    while (end < bytes.length && bytes[end] !== 0x3A) end++;
    if (end === bytes.length) throw new Error('bencode: bad string');
    const n = Number(asString(bytes.slice(pos, end)));
    if (!Number.isInteger(n) || n < 0) throw new Error('bencode: bad length');
    const start = end + 1;
    if (start + n > bytes.length) throw new Error('bencode: string exceeds input');
    return { value: bytes.slice(start, start + n), pos: start + n };
  }

  if (c === 0x69) {
    let end = pos + 1;
    while (end < bytes.length && bytes[end] !== 0x65) end++;
    if (end === bytes.length) throw new Error('bencode: bad integer');
    const n = Number(asString(bytes.slice(pos + 1, end)));
    if (!Number.isInteger(n)) throw new Error('bencode: bad integer');
    return { value: n, pos: end + 1 };
  }

  if (c === 0x6C) {
    const list = [];
    let p = pos + 1;
    while (bytes[p] !== 0x65) {
      const item = decode(bytes, p);
      list.push(item.value);
      p = item.pos;
    }
    return { value: list, pos: p + 1 };
  }

  if (c === 0x64) {
    const dict = {};
    let p = pos + 1;
    while (bytes[p] !== 0x65) {
      const keyItem = decode(bytes, p);
      p = keyItem.pos;
      if (!isBytes(keyItem.value)) throw new Error('bencode: dict key must be a string');
      const valItem = decode(bytes, p);
      p = valItem.pos;
      dict[asString(keyItem.value)] = valItem.value;
    }
    return { value: dict, pos: p + 1 };
  }

  throw new Error('bencode: unknown marker ' + String.fromCharCode(c));
}

function decodeSync(input) {
  return decode(input).value;
}

function bytesToHex(b) {
  let s = '';
  for (const x of b) s += (x < 16 ? '0' : '') + x.toString(16);
  return s;
}

/* ============================ store.js ============================ */

function now() { return Date.now(); }

function emptyTorrent(infoHash) {
  return {
    infoHash,
    createdAt: now(),
    updatedAt: now(),
    peers: {},
    completed: 0
  };
}

class Store {
  async getTorrents() { throw new Error('not implemented'); }
  async putTorrent(infoHash, torrent) { throw new Error('not implemented'); }
  async deleteTorrent(infoHash) { throw new Error('not implemented'); }
  async getTrackers() { throw new Error('not implemented'); }
  async putTracker(url, config) { throw new Error('not implemented'); }
  async deleteTracker(url) { throw new Error('not implemented'); }
  async close() { return undefined; }
  async getAlerts() { return new Map(); }
  async putAlert(id, config) { return undefined; }
  async deleteAlert(id) { return undefined; }
}

class MemoryStore extends Store {
  constructor() {
    super();
    this._torrents = new Map();
    this._trackers = new Map();
    this._alerts = new Map();
  }
  async getTorrents() { return new Map(this._torrents); }
  async putTorrent(infoHash, torrent) {
    this._torrents.set(infoHash, { ...torrent, peers: { ...(torrent.peers || {}) } });
  }
  async deleteTorrent(infoHash) { this._torrents.delete(infoHash); }
  async getTrackers() { return new Map(this._trackers); }
  async putTracker(url, config) { this._trackers.set(url, { ...config, url }); }
  async deleteTracker(url) { this._trackers.delete(url); }
  async getAlerts() { return new Map(this._alerts); }
  async putAlert(id, config) { this._alerts.set(id, { ...config, id, updatedAt: Date.now() }); }
  async deleteAlert(id) { this._alerts.delete(id); }
}

class KvStore extends Store {
  constructor({ torrentsNamespace, trackersNamespace, alertsNamespace, prefix = 'bt:' }) {
    super();
    this._torrentsNS = torrentsNamespace;
    this._trackersNS = trackersNamespace;
    this._alertsNS = alertsNamespace;
    this._prefix = prefix;
  }
  _k(key) { return this._prefix + key; }
  async getTorrents() {
    const map = new Map();
    const list = await this._torrentsNS.list({ prefix: this._prefix });
    for (const key of list.keys) {
      const raw = await this._torrentsNS.get(key.name);
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw);
        const ih = key.name.slice(this._prefix.length);
        map.set(ih, obj);
      } catch (e) { console.error('[tracker] bad KV torrent entry', key.name, e); }
    }
    return map;
  }
  async putTorrent(infoHash, torrent) {
    await this._torrentsNS.put(this._k(infoHash), JSON.stringify(torrent));
  }
  async deleteTorrent(infoHash) {
    await this._torrentsNS.delete(this._k(infoHash));
  }
  async getTrackers() {
    const map = new Map();
    const list = await this._trackersNS.list({ prefix: this._prefix });
    for (const key of list.keys) {
      const raw = await this._trackersNS.get(key.name);
      if (!raw) continue;
      try { map.set(key.name.slice(this._prefix.length), JSON.parse(raw)); } catch {}
    }
    return map;
  }
  async putTracker(url, config) {
    await this._trackersNS.put(this._k(url), JSON.stringify(config));
  }
  async deleteTracker(url) {
    await this._trackersNS.delete(this._k(url));
  }
  async getAlerts() {
    const map = new Map();
    if (!this._alertsNS) return map;
    const list = await this._alertsNS.list({ prefix: this._prefix });
    for (const key of list.keys) {
      const raw = await this._alertsNS.get(key.name);
      if (!raw) continue;
      try { map.set(key.name.slice(this._prefix.length), JSON.parse(raw)); } catch {}
    }
    return map;
  }
  async putAlert(id, config) {
    if (!this._alertsNS) return;
    await this._alertsNS.put(this._k(id), JSON.stringify({ ...config, id, updatedAt: Date.now() }));
  }
  async deleteAlert(id) {
    if (!this._alertsNS) return;
    await this._alertsNS.delete(this._k(id));
  }
}

function serializeTorrent(t) {
  return {
    infoHash: t.infoHash,
    name: t.name,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    peers: t.peers || {},
    completed: t.completed
  };
}
function deserializeTorrent(obj) {
  return {
    infoHash: obj.infoHash,
    name: obj.name,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    peers: obj.peers || {},
    completed: obj.completed || 0
  };
}

/* ============================ tracker.js ============================ */

const DEFAULT_INTERVAL = 1800;
const DEFAULT_MIN_INTERVAL = 900;
const MAX_NUMWANT = 200;
const DEFAULT_NUMWANT = 50;
const PEER_TTL_MS = 30 * 60 * 1000;
const COMPACT_PEER = 6;

function isCompact(val) {
  return val === 1 || val === '1' || val === true;
}

function hexInfoHash(raw) {
  if (raw instanceof Uint8Array) {
    let s = '';
    for (const b of raw) s += (b < 16 ? '0' : '') + b.toString(16);
    return s;
  }
  if (typeof raw === 'string') {
    if (/^[0-9a-fA-F]{40}$/.test(raw)) return raw.toLowerCase();
    let s = '';
    for (let i = 0; i < raw.length; i++) {
      const b = raw.charCodeAt(i);
      s += (b < 16 ? '0' : '') + b.toString(16);
    }
    return s;
  }
  return '';
}

function ipToBytes(ip) {
  const parts = ip.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) {
    return new Uint8Array(parts.map(Number));
  }
  if (ip.includes(':')) return null;
  return null;
}

function peersToCompact(peers) {
  const parts = [];
  for (const p of peers) {
    const b = ipToBytes(p.ip);
    if (!b) continue;
    const port = Number(p.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const chunk = new Uint8Array(COMPACT_PEER);
    chunk.set(b, 0);
    chunk[4] = (port >> 8) & 0xff;
    chunk[5] = port & 0xff;
    parts.push(chunk);
  }
  if (parts.length === 0) return new Uint8Array(0);
  return parts.reduce((a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  });
}

class Tracker {
  constructor({ store, externalFetch, interval = DEFAULT_INTERVAL,
               minInterval = DEFAULT_MIN_INTERVAL, trackerId = 'bt-tracker' } = {}) {
    this._store = store;
    this._externalFetch = externalFetch;
    this._interval = interval;
    this._minInterval = minInterval;
    this._trackerId = trackerId;
    this._stats = { announces: 0, scrapes: 0, errors: 0, startedAt: Date.now() };
  }

  async handleRequest(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const query = {};
    for (const [k, v] of url.searchParams) query[k] = v;

    if (path === '/announce' || path === '/announce/') {
      return this.announce(query);
    }
    if (path === '/scrape' || path === '/scrape/') {
      return this.scrape(query);
    }
    if (path === '/stats' || path === '/stats/') {
      return this.stats();
    }
    return this._json({ error: 'not found' }, 404);
  }

  async announce(query) {
    this._stats.announces++;
    try {
      const infoHashRaw = query.info_hash;
      const peerId = query.peer_id || '';
      const ip = query.ip || '';
      const port = Number(query.port);
      const uploaded = Number(query.uploaded) || 0;
      const downloaded = Number(query.downloaded) || 0;
      const left = Number(query.left);
      const event = query.event || '';
      const compact = isCompact(query.compact);
      const numwant = Math.min(Math.max(Number(query.numwant) || DEFAULT_NUMWANT, 1), MAX_NUMWANT);

      if (!infoHashRaw) return this._bencodeError('missing info_hash');
      if (!peerId) return this._bencodeError('missing peer_id');
      if (!Number.isFinite(port) || port < 1 || port > 65535) return this._bencodeError('invalid port');

      const infoHash = hexInfoHash(infoHashRaw);

      if (event === 'stopped') {
        await this._removePeer(infoHash, peerId);
        return this._bencodeOk({ complete: 0, incomplete: 0, interval: this._interval, minInterval: this._minInterval, peers: compact ? new Uint8Array(0) : [] });
      }

      const isCompleted = event === 'completed';

      const peer = {
        peerId,
        ip: ip || '0.0.0.0',
        port,
        uploaded,
        downloaded,
        left: left >= 0 ? left : 0,
        event,
        lastAnnounce: Date.now()
      };
      const torrent = await this._upsertPeer(infoHash, peer, isCompleted);

      const peers = this._selectPeers(torrent, peerId, numwant, compact);

      let extPeers = [];
      let extComplete = 0;
      let extIncomplete = 0;
      const trackers = await this._store.getTrackers();
      for (const [url, cfg] of trackers) {
        if (!cfg.enabled) continue;
        try {
          const res = await this._fetchExternal(url, {
            info_hash: infoHashRaw,
            peer_id: peerId,
            ip, port, uploaded, downloaded, left,
            event, compact: 1, numwant
          });
          if (res.ok) {
            extPeers = extPeers.concat(res.peers || []);
            if (res.complete !== undefined) extComplete += res.complete;
            if (res.incomplete !== undefined) extIncomplete += res.incomplete;
          }
        } catch (e) {
          console.error('[tracker] external tracker error', url, e);
        }
      }

      const localSet = new Set();
      const localPeers = [];
      for (const p of peers) {
        const key = p.ip + ':' + p.port;
        if (!localSet.has(key)) { localSet.add(key); localPeers.push(p); }
      }
      const merged = [...localPeers];
      for (const p of extPeers) {
        const key = p.ip + ':' + p.port;
        if (!localSet.has(key)) { localSet.add(key); merged.push({ ip: p.ip, port: p.port, peerId: 'ext' }); }
      }
      if (merged.length > numwant) merged.length = numwant;

      let complete = 0, incomplete = 0;
      for (const [, p] of Object.entries(torrent.peers || {})) {
        if (p.left === 0) complete++; else incomplete++;
      }
      complete += extComplete;
      incomplete += extIncomplete;

      const peersBody = compact ? peersToCompact(merged) : merged;
      this.checkAlerts().catch(() => {});
      return this._bencodeOk({
        complete, incomplete, interval: this._interval, minInterval: this._minInterval,
        peers: peersBody
      });
    } catch (e) {
      this._stats.errors++;
      console.error('[tracker] announce error', e);
      return this._bencodeError('internal error');
    }
  }

  async scrape(query) {
    this._stats.scrapes++;
    try {
      const infoHashRaw = query.info_hash;
      let infos;
      if (infoHashRaw) {
        const ih = hexInfoHash(infoHashRaw);
        const t = await this._store.getTorrents();
        const tor = t.get(ih);
        infos = [{ info_hash: infoHashRaw, complete: 0, incomplete: 0, downloaded: 0 }];
        if (tor) {
          let c = 0, inc = 0;
          for (const [, p] of Object.entries(tor.peers || {})) {
            if (p.left === 0) c++; else inc++;
          }
          infos[0] = { info_hash: infoHashRaw, complete: c, incomplete: inc, downloaded: tor.completed };
        }
      } else {
        const t = await this._store.getTorrents();
        infos = [];
        for (const [ih, tor] of t) {
          let c = 0, inc = 0;
          for (const [, p] of Object.entries(tor.peers || {})) {
            if (p.left === 0) c++; else inc++;
          }
          infos.push({ info_hash: ih, complete: c, incomplete: inc, downloaded: tor.completed });
        }
      }
      return this._bencodeOk({ files: infos });
    } catch (e) {
      this._stats.errors++;
      return this._bencodeError('internal error');
    } finally {
      this.checkAlerts().catch(() => {});
    }
  }

  async stats() {
    const t = await this._store.getTorrents();
    const tr = await this._store.getTrackers();
    let peers = 0, complete = 0, incomplete = 0;
    for (const [, tor] of t) {
      for (const [, p] of Object.entries(tor.peers || {})) {
        peers++;
        if (p.left === 0) complete++; else incomplete++;
      }
    }
    return this._json({
      ok: true,
      trackerId: this._trackerId,
      interval: this._interval,
      stats: this._stats,
      torrents: t.size,
      peers, complete, incomplete,
      trackers: tr.size,
      uptime: Date.now() - this._stats.startedAt
    });
  }

  async listTrackers() {
    const tr = await this._store.getTrackers();
    return { ok: true, trackers: [...tr.values()] };
  }
  async addTracker(url, enabled = true, note) {
    await this._store.putTracker(url, { url, enabled, addedAt: Date.now(), note });
    return { ok: true };
  }
  async removeTracker(url) {
    await this._store.deleteTracker(url);
    return { ok: true };
  }
  async setTracker(url, { enabled, note } = {}) {
    const tr = await this._store.getTrackers();
    const cfg = tr.get(url);
    if (!cfg) return { ok: false, error: 'not found' };
    if (enabled !== undefined) cfg.enabled = enabled;
    if (note !== undefined) cfg.note = note;
    await this._store.putTracker(url, cfg);
    return { ok: true };
  }

  async exportTorrents() {
    const t = await this._store.getTorrents();
    const out = { version: 1, exportedAt: Date.now(), torrents: [...t.values()].map(serializeTorrent) };
    return { ok: true, data: out };
  }
  async importTorrents(data, { merge = true } = {}) {
    if (!data || !Array.isArray(data.torrents)) return { ok: false, error: 'invalid format' };
    let imported = 0, skipped = 0;
    const t = await this._store.getTorrents();
    for (const tor of data.torrents) {
      if (!tor || !tor.infoHash) { skipped++; continue; }
      const existing = t.get(tor.infoHash);
      if (existing && !merge) { skipped++; continue; }
      const merged = merge && existing ? { ...existing, ...tor, peers: { ...existing.peers, ...tor.peers } } : tor;
      await this._store.putTorrent(tor.infoHash, merged);
      imported++;
    }
    return { ok: true, imported, skipped };
  }

  async listAlerts() {
    const a = await this._store.getAlerts();
    return { ok: true, alerts: [...a.values()] };
  }
  async addAlert(config) {
    if (!config || !config.id || !config.metric) {
      return { ok: false, error: 'id and metric required' };
    }
    const a = {
      id: config.id,
      metric: config.metric,
      threshold: Number(config.threshold) || 0,
      comparison: config.comparison || 'gt',
      enabled: config.enabled !== false,
      webhookUrl: config.webhookUrl || '',
      email: config.email || '',
      cooldownMs: Number(config.cooldownMs) || 3600000,
      lastTriggered: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await this._store.putAlert(a.id, a);
    return { ok: true, alert: a };
  }
  async updateAlert(id, patch) {
    const a = await this._store.getAlerts();
    const cur = a.get(id);
    if (!cur) return { ok: false, error: 'not found' };
    const updated = { ...cur, ...patch, id, updatedAt: Date.now() };
    await this._store.putAlert(id, updated);
    return { ok: true, alert: updated };
  }
  async deleteAlert(id) {
    await this._store.deleteAlert(id);
    return { ok: true };
  }

  async checkAlerts() {
    const stats = await this._gatherStats();
    const a = await this._store.getAlerts();
    const results = [];
    const now = Date.now();
    for (const [, alert] of a) {
      if (!alert.enabled) continue;
      const value = stats[alert.metric];
      if (value === undefined) continue;
      let triggered = false;
      switch (alert.comparison) {
        case 'gte': triggered = value >= alert.threshold; break;
        case 'lt': triggered = value < alert.threshold; break;
        case 'lte': triggered = value <= alert.threshold; break;
        case 'eq': triggered = value === alert.threshold; break;
        case 'gt':
        default: triggered = value > alert.threshold; break;
      }
      if (!triggered) continue;
      if (now - (alert.lastTriggered || 0) < alert.cooldownMs) continue;
      alert.lastTriggered = now;
      await this._store.putAlert(alert.id, alert);
      results.push({ alert: alert.id, metric: alert.metric, value, threshold: alert.threshold });
      await this._sendAlert(alert, { value, threshold, stats });
    }
    return { ok: true, triggered: results };
  }

  async _gatherStats() {
    const t = await this._store.getTorrents();
    let peers = 0, complete = 0, incomplete = 0;
    for (const [, tor] of t) {
      for (const [, p] of Object.entries(tor.peers || {})) {
        peers++;
        if (p.left === 0) complete++; else incomplete++;
      }
    }
    return {
      torrents: t.size,
      peers,
      complete,
      incomplete,
      announces: this._stats.announces,
      scrapes: this._stats.scrapes,
      errors: this._stats.errors,
      uptime: Date.now() - this._stats.startedAt
    };
  }

  async _sendAlert(alert, ctx) {
    const payload = {
      trackerId: this._trackerId,
      alert: alert.id,
      metric: alert.metric,
      value: ctx.value,
      threshold: alert.threshold,
      comparison: alert.comparison,
      stats: ctx.stats,
      triggeredAt: Date.now()
    };
    if (alert.webhookUrl) {
      try {
        await fetch(alert.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (e) {
        console.error('[tracker] alert webhook failed', alert.webhookUrl, e);
      }
    }
    if (alert.email) {
      console.error(`[tracker] ALERT: ${alert.id} metric=${alert.metric} value=${ctx.value} threshold=${alert.threshold} -> notify ${alert.email}`);
    }
  }

  async _upsertPeer(infoHash, peer, isCompleted) {
    const t = await this._store.getTorrents();
    let tor = t.get(infoHash);
    if (!tor) {
      tor = { infoHash, createdAt: Date.now(), updatedAt: Date.now(), peers: {}, completed: 0 };
    }
    tor.peers = tor.peers || {};
    const key = peer.peerId;
    const existing = tor.peers[key];
    if (existing) {
      tor.peers[key] = { ...existing, ...peer, lastAnnounce: Date.now() };
    } else {
      tor.peers[key] = { ...peer, lastAnnounce: Date.now() };
    }
    if (isCompleted && peer.left === 0) tor.completed = (tor.completed || 0) + 1;
    tor.updatedAt = Date.now();
    await this._store.putTorrent(infoHash, tor);
    return tor;
  }

  async _removePeer(infoHash, peerId) {
    const t = await this._store.getTorrents();
    const tor = t.get(infoHash);
    if (!tor || !tor.peers) return;
    delete tor.peers[peerId];
    tor.updatedAt = Date.now();
    await this._store.putTorrent(infoHash, tor);
  }

  _selectPeers(torrent, selfPeerId, numwant, compact) {
    const peers = [];
    const now = Date.now();
    const peersMap = torrent.peers || {};
    for (const [pid, p] of Object.entries(peersMap)) {
      if (pid === selfPeerId) continue;
      if (now - p.lastAnnounce > PEER_TTL_MS) continue;
      peers.push({ ip: p.ip, port: p.port, peerId: pid });
    }
    for (let i = peers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [peers[i], peers[j]] = [peers[j], peers[i]];
    }
    return peers.slice(0, numwant);
  }

  async _fetchExternal(url, params) {
    if (!this._externalFetch) return { ok: false };
    return this._externalFetch(url, params);
  }

  _bencodeOk(extra = {}) {
    const body = {
      complete: extra.complete ?? 0,
      incomplete: extra.incomplete ?? 0,
      interval: extra.interval ?? this._interval,
      'min interval': extra.minInterval ?? this._minInterval
    };
    if (extra.peers !== undefined) body.peers = extra.peers;
    if (this._trackerId) body['tracker id'] = this._trackerId;
    if (extra.files !== undefined) body.files = extra.files;
    return new Response(encode(body), {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=binary' }
    });
  }
  _bencodeError(reason) {
    return new Response(encode({ 'failure reason': reason }), {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=binary' }
    });
  }
  _json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}

/* ============================ worker.js ============================ */

const INTERVAL = Number(__BT_INTERVAL__ || 1800);
const MIN_INTERVAL = Number(__BT_MIN_INTERVAL__ || 900);
const TRACKER_ID = __BT_TRACKER_ID__ || 'bt-tracker';

function makeStore(torrentsNs, trackersNs, alertsNs) {
  return new KvStore({ torrentsNamespace: torrentsNs, trackersNamespace: trackersNs, alertsNamespace: alertsNs });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BT Tracker 管理面板</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans SC', sans-serif; background: #f5f7fa; color: #1f2937; line-height: 1.5; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #e5e7eb; }
  .logo { font-size: 20px; font-weight: 700; color: #2563eb; letter-spacing: -0.5px; }
  .tagline { color: #6b7280; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  .card h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 10px; }
  .big { font-size: 34px; font-weight: 700; color: #111827; }
  .muted { color: #6b7280; font-size: 14px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
  .badge-ok { background: #dcfce7; color: #166534; }
  .badge-warn { background: #fef3c7; color: #92400e; }
  .badge-bad { background: #fee2e2; color: #991b1b; }
  .section { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  .section-title { font-size: 16px; font-weight: 700; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 10px 8px; text-align: left; border-bottom: 1px solid #f3f4f6; }
  th { font-weight: 600; color: #374151; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  tr:hover { background: #f9fafb; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border: 1px solid #e5e7eb; background: #fff; color: #111827; border-radius: 8px; font-size: 13px; cursor: pointer; transition: all 0.15s; }
  .btn:hover { border-color: #2563eb; color: #2563eb; background: #f0f7ff; }
  .btn-primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  .btn-primary:hover { background: #1d4ed8; }
  .btn-danger { background: #fee2e2; color: #991b1b; border-color: #fecaca; }
  .btn-danger:hover { background: #fecaca; color: #991b1b; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
  .form-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; align-items: end; margin-bottom: 12px; }
  input, select { padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 13px; width: 100%; background: #fff; }
  input:focus, select:focus { outline: 2px solid #2563eb; border-color: #2563eb; }
  label { font-size: 12px; color: #6b7280; display: block; margin-bottom: 4px; }
  .switch { position: relative; display: inline-block; width: 44px; height: 24px; }
  .switch input { opacity: 0; width: 0; height: 0; position: absolute; }
  .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: #ccc; transition: .2s; border-radius: 24px; }
  .slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background: #fff; transition: .2s; border-radius: 50%; }
  input:checked + .slider { background: #2563eb; }
  input:checked + .slider:before { transform: translateX(20px); }
  .empty { color: #9ca3af; font-size: 14px; text-align: center; padding: 30px; }
  .status-good { color: #166534; }
  .status-bad { color: #991b1b; }
  .hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #4b5563; word-break: break-all; max-width: 160px; }
  .alert-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #f3f4f6; }
  .alert-row:last-child { border-bottom: none; }
  .toast { position: fixed; bottom: 24px; right: 24px; background: #111827; color: #fff; padding: 10px 16px; border-radius: 8px; font-size: 13px; display: none; z-index: 50; }
  .toast.show { display: block; }
</style>
</head>
<body>

<div class="container">
  <header>
    <div class="logo">🌐 BT Tracker</div>
    <div class="tagline">BitTorrent Tracker 管理面板 &bull; 外部 Tracker 联邦 &bull; 用量提醒</div>
  </header>

  <div class="grid">
    <div class="card">
      <h3>种子总数</h3>
      <div class="big" id="statTorrents">-</div>
      <div class="muted">活跃 / 归档</div>
    </div>
    <div class="card">
      <h3>Peer 总数</h3>
      <div class="big" id="statPeers">-</div>
      <div class="muted">种子 + 下载者</div>
    </div>
    <div class="card">
      <h3>上报次数</h3>
      <div class="big" id="statAnnounces">-</div>
      <div class="muted">累计 announce</div>
    </div>
    <div class="card">
      <h3>抓取次数</h3>
      <div class="big" id="statScrapes">-</div>
      <div class="muted">累计 scrape</div>
    </div>
    <div class="card">
      <h3>外部 Tracker</h3>
      <div class="big" id="statTrackers">-</div>
      <div class="muted">已启用 / 已禁用</div>
    </div>
    <div class="card">
      <h3>运行时间</h3>
      <div class="big" id="statUptime">-</div>
      <div class="muted">自启动以来</div>
    </div>
  </div>

  <section class="section">
    <div class="section-title">🔗 外部 Tracker 管理</div>
    <div class="form-row" style="margin-bottom:16px;">
      <input type="text" id="trackerUrl" placeholder="http://tracker.example.com:6969/announce">
      <input type="text" id="trackerNote" placeholder="备注（可选）">
      <button class="btn btn-primary" onclick="addTracker()">添加</button>
    </div>
    <div id="trackerList" class="loading">加载中...</div>
  </section>

  <section class="section">
    <div class="section-title">🔔 用量提醒 (Alerts)</div>
    <p class="muted" style="margin-bottom:12px;">当指标超过阈值时触发通知（Webhook 或日志）。</p>
    <div class="form-row" style="margin-bottom:16px;">
      <input type="text" id="alertId" placeholder="提醒 ID（如 peers-high）">
      <select id="alertMetric">
        <option value="peers">Peer 数量</option>
        <option value="torrents">种子数量</option>
        <option value="announces">上报次数</option>
        <option value="scrapes">抓取次数</option>
      </select>
      <input type="number" id="alertThreshold" placeholder="阈值">
      <select id="alertComparison">
        <option value="gt">大于</option>
        <option value="gte">大于等于</option>
        <option value="lt">小于</option>
        <option value="lte">小于等于</option>
        <option value="eq">等于</option>
      </select>
      <input type="text" id="alertWebhook" placeholder="Webhook URL（可选）">
      <button class="btn btn-primary" onclick="addAlert()">添加提醒</button>
    </div>
    <div id="alertList" class="loading">加载中...</div>
  </section>

  <section class="section">
    <div class="section-title" style="justify-content:space-between;">
      <span>📦 种子列表</span>
      <button class="btn btn-sm" onclick="loadTorrents()">刷新</button>
    </div>
    <div id="torrentList" class="loading">加载中...</div>
  </section>

  <div id="toast" class="toast"></div>
</div>

<script>
const BASE = '';
function toast(msg, ok = true) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show';
  setTimeout(() => t.className = 'toast', 2500);
}
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json', ...opts.headers }, ...opts });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
async function loadStats() {
  try {
    const s = await api('/stats');
    document.getElementById('statTorrents').textContent = s.torrents ?? 0;
    document.getElementById('statPeers').textContent = s.peers ?? 0;
    document.getElementById('statAnnounces').textContent = s.stats?.announces ?? 0;
    document.getElementById('statScrapes').textContent = s.stats?.scrapes ?? 0;
    document.getElementById('statTrackers').textContent = s.trackers ?? 0;
    const ms = s.uptime ?? 0;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    document.getElementById('statUptime').textContent = h + 'h ' + m + 'm';
  } catch (e) { console.error(e); }
}
async function loadTrackers() {
  try {
    const r = await api('/admin/trackers');
    const el = document.getElementById('trackerList');
    const trs = r.trackers || [];
    if (trs.length === 0) { el.innerHTML = '<div class="empty">暂无外部 tracker，添加一个以上联邦同步 peer。</div>'; return; }
    let html = '<table><thead><tr><th>URL</th><th>备注</th><th>状态</th><th>操作</th></tr></thead><tbody>';
    for (const tr of trs) {
      const enabledCls = tr.enabled ? 'badge-ok' : 'badge-bad';
      const enabledTxt = tr.enabled ? '启用' : '禁用';
      const urlDisplay = tr.url.length > 60 ? tr.url.slice(0, 57) + '...' : tr.url;
      html += `<tr>
        <td><span class="hash" title="${tr.url}">${urlDisplay}</span></td>
        <td>${tr.note || '-'}</td>
        <td><span class="badge ${enabledCls}">${enabledTxt}</span></td>
        <td>
          <button class="btn btn-sm" onclick="toggleTracker('${escapeHtml(tr.url)}', ${!tr.enabled})">${tr.enabled ? '禁用' : '启用'}</button>
          <button class="btn btn-sm btn-danger" onclick="deleteTracker('${escapeHtml(tr.url)}')">删除</button>
        </td>
      </tr>`;
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch (e) {
    document.getElementById('trackerList').innerHTML = '<div class="empty status-bad">加载失败: ' + e.message + '</div>';
  }
}
async function addTracker() {
  const url = document.getElementById('trackerUrl').value.trim();
  const note = document.getElementById('trackerNote').value.trim();
  if (!url) { toast('请输入 tracker URL', false); return; }
  try {
    await api('/admin/trackers', { method: 'POST', body: JSON.stringify({ url, enabled: true, note }) });
    document.getElementById('trackerUrl').value = '';
    document.getElementById('trackerNote').value = '';
    loadTrackers();
    loadStats();
    toast('已添加外部 tracker');
  } catch (e) { toast('添加失败: ' + e.message, false); }
}
async function toggleTracker(url, enabled) {
  try {
    await api('/admin/trackers/' + encodeURIComponent(url), { method: 'PATCH', body: JSON.stringify({ enabled }) });
    loadTrackers();
    loadStats();
  } catch (e) { toast('操作失败: ' + e.message, false); }
}
async function deleteTracker(url) {
  if (!confirm('确定删除该外部 tracker？')) return;
  try {
    await api('/admin/trackers/' + encodeURIComponent(url), { method: 'DELETE' });
    loadTrackers();
    loadStats();
    toast('已删除');
  } catch (e) { toast('删除失败: ' + e.message, false); }
}
async function loadAlerts() {
  try {
    const r = await api('/admin/alerts');
    const el = document.getElementById('alertList');
    const alerts = r.alerts || [];
    if (alerts.length === 0) { el.innerHTML = '<div class="empty">暂无提醒规则，添加一个以上监控用量。</div>'; return; }
    let html = '';
    for (const a of alerts) {
      const enabledCls = a.enabled ? 'badge-ok' : 'badge-bad';
      html += `<div class="alert-row">
        <div style="flex:1;">
          <div style="font-weight:600;">${escapeHtml(a.id)}</div>
          <div class="muted" style="font-size:12px;">${a.metric} ${a.comparison} ${a.threshold} &bull; 冷却 ${Math.round(a.cooldownMs/1000/60)} 分钟 &bull; 最后触发 ${a.lastTriggered ? new Date(a.lastTriggered).toLocaleString() : '从未'}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <label class="switch" style="margin:0;"><input type="checkbox" ${a.enabled ? 'checked' : ''} onchange="toggleAlert('${escapeHtml(a.id)}', ${!a.enabled})"><div class="slider"></div></label>
          <button class="btn btn-sm btn-danger" onclick="deleteAlert('${escapeHtml(a.id)}')">删除</button>
        </div>
      </div>`;
    }
    el.innerHTML = html;
  } catch (e) {
    document.getElementById('alertList').innerHTML = '<div class="empty status-bad">加载失败: ' + e.message + '</div>';
  }
}
async function addAlert() {
  const id = document.getElementById('alertId').value.trim();
  const metric = document.getElementById('alertMetric').value;
  const threshold = document.getElementById('alertThreshold').value.trim();
  const comparison = document.getElementById('alertComparison').value;
  const webhook = document.getElementById('alertWebhook').value.trim();
  if (!id || !threshold) { toast('请填写 ID 和阈值', false); return; }
  try {
    await api('/admin/alerts', { method: 'POST', body: JSON.stringify({ id, metric, threshold, comparison, webhookUrl: webhook }) });
    document.getElementById('alertId').value = '';
    document.getElementById('alertThreshold').value = '';
    document.getElementById('alertWebhook').value = '';
    loadAlerts();
    toast('已添加提醒规则');
  } catch (e) { toast('添加失败: ' + e.message, false); }
}
async function toggleAlert(id, enabled) {
  try {
    await api('/admin/alerts/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled }) });
    loadAlerts();
  } catch (e) { toast('操作失败: ' + e.message, false); }
}
async function deleteAlert(id) {
  if (!confirm('确定删除该提醒规则？')) return;
  try {
    await api('/admin/alerts/' + encodeURIComponent(id), { method: 'DELETE' });
    loadAlerts();
    toast('已删除');
  } catch (e) { toast('删除失败: ' + e.message, false); }
}
async function loadTorrents() {
  try {
    const r = await api('/admin/export');
    const torrents = r.torrents || [];
    const el = document.getElementById('torrentList');
    if (torrents.length === 0) { el.innerHTML = '<div class="empty">暂无种子记录。</div>'; return; }
    let html = '<table><thead><tr><th>Info Hash</th><th>Peer 数</th><th>已完成</th><th>创建时间</th><th>更新时间</th></tr></thead><tbody>';
    for (const t of torrents) {
      const peers = t.peers ? Object.keys(t.peers).length : 0;
      const created = t.createdAt ? new Date(t.createdAt).toLocaleString() : '-';
      const updated = t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '-';
      html += `<tr>
        <td><span class="hash" title="${t.infoHash}">${t.infoHash}</span></td>
        <td>${peers}</td>
        <td>${t.completed || 0}</td>
        <td>${created}</td>
        <td>${updated}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch (e) {
    document.getElementById('torrentList').innerHTML = '<div class="empty status-bad">加载失败: ' + e.message + '</div>';
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]));
}
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadTrackers();
  loadAlerts();
  loadTorrents();
  setInterval(loadStats, 15000);
  setInterval(loadTrackers, 30000);
  setInterval(loadAlerts, 30000);
});
</script>

</body>
</html>
`;

export default {
  async fetch(request, env, ctx) {
    const store = makeStore(env.BT_TORRENTS, env.BT_TRACKERS, env.BT_ALERTS);
    const tracker = new Tracker({
      store,
      interval: INTERVAL,
      minInterval: MIN_INTERVAL,
      trackerId: TRACKER_ID,
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
          });
          if (!res.ok) return { ok: false };
          const ab = await res.arrayBuffer();
          const body = new Uint8Array(ab);
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

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/dashboard' || path === '/dashboard/') {
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (path === '/announce' || path === '/scrape' || path === '/stats') {
      return tracker.handleRequest(request);
    }

    if (path.startsWith('/admin/')) {
      return adminHandler(request, tracker, url);
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
    return json({ ok: false, error: 'not found' }, 404);
  } catch (e) {
    console.error('[tracker] admin error', e);
    return json({ ok: false, error: 'internal error' }, 500);
  }
}
