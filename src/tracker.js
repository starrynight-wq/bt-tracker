'use strict';

/*
 * BitTorrent tracker core (HTTP/HTTPS announce + scrape).
 *
 * Works in Node.js (Replit) and Cloudflare Workers.
 *
 * Announce request query parameters (standard):
 *   info_hash (20 bytes), peer_id (20 bytes), ip, port,
 *   uploaded, downloaded, left, event (started|stopped|completed|empty),
 *   compact (0/1), numwant, no_peer_id (0/1), supportcrypto, ipv6
 *
 * Response (bencoded dict):
 *   d
 *     complete: <int>      // seeders count
 *     incomplete: <int>    // leechers count
 *     interval: <int>      // announce interval seconds
 *     min interval: <int>
 *     tracker id: <str>    (optional)
 *     peers: <compact bytes> or <list of dicts>
 *   e
 */

import { encode, encodeStr } from './bencode.js';
import { serializeTorrent, deserializeTorrent } from './store.js';

const DEFAULT_INTERVAL = 1800;   // 30 min
const DEFAULT_MIN_INTERVAL = 900; // 15 min
const MAX_NUMWANT = 200;
const DEFAULT_NUMWANT = 50;
const PEER_TTL_MS = 30 * 60 * 1000; // peers expire after 30 min silence
const COMPACT_PEER = 6;   // 4 ip + 2 port

function isCompact(val) {
  // compact=1 means compact peer list
  return val === 1 || val === '1' || val === true;
}

function parseQuery(urlStr) {
  const u = new URL(urlStr);
  const q = {};
  for (const [k, v] of u.searchParams) {
    if (!(k in q)) q[k] = v;
    else if (Array.isArray(q[k])) q[k].push(v);
    else q[k] = [q[k], v];
  }
  return { url: u, query: q };
}

function hexInfoHash(raw) {
  // raw may be Uint8Array (20 bytes) or string (hex or raw)
  if (raw instanceof Uint8Array) {
    let s = '';
    for (const b of raw) s += (b < 16 ? '0' : '') + b.toString(16);
    return s;
  }
  if (typeof raw === 'string') {
    // allow already-hex or raw latin-1
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
  // IPv4 dotted -> 4 bytes; IPv6 -> 16 bytes; else null
  const parts = ip.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) {
    return new Uint8Array(parts.map(Number));
  }
  // very light IPv6 support: accept colon-containing, return 16 zero bytes placeholder
  // (full inet_pton not implemented; callers should only compact IPv4 unless sure)
  if (ip.includes(':')) return null;
  return null;
}

function peersToCompact(peers) {
  // peers: array of {ip, port}
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

/*
 * Tracker class. One instance per runtime.
 * store: Store instance
 * externalFetch: (url, params) => Promise<{ok, peers?: [], complete?, incomplete?}>  (injected)
 * options: { interval, minInterval, trackerId }
 */
export class Tracker {
  constructor({ store, externalFetch, interval = DEFAULT_INTERVAL,
               minInterval = DEFAULT_MIN_INTERVAL, trackerId = 'bt-tracker' } = {}) {
    this._store = store;
    this._externalFetch = externalFetch;
    this._interval = interval;
    this._minInterval = minInterval;
    this._trackerId = trackerId;
    this._stats = { announces: 0, scrapes: 0, errors: 0, startedAt: Date.now() };
  }

  /* ----------------------- public API ----------------------- */

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

  /* ----------------------- announce ----------------------- */

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

      // handle stop event: remove peer
      if (event === 'stopped') {
        await this._removePeer(infoHash, peerId);
        return this._bencodeOk({ complete: 0, incomplete: 0, interval: this._interval, minInterval: this._minInterval, peers: compact ? new Uint8Array(0) : [] });
      }

      const isCompleted = event === 'completed';
      const isStarted = event === 'started';

      // upsert peer
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

      // gather local peers (exclude self, only interested peers with left > 0 unless completed)
      const peers = this._selectPeers(torrent, peerId, numwant, compact);

      // fetch from external trackers and merge
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

      // merge external peers (compact bytes -> parse)
      const extCompact = peersToCompact(extPeers.map(p => ({ ip: p.ip, port: p.port })));
      // dedupe by ip:port against local
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

      // compute counts
      let complete = 0, incomplete = 0;
      for (const [, p] of Object.entries(torrent.peers || {})) {
        if (p.left === 0) complete++; else incomplete++;
      }
      complete += extComplete;
      incomplete += extIncomplete;

      const peersBody = compact ? peersToCompact(merged) : merged;
      // fire-and-forget alert evaluation (does not block the response)
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

  /* ----------------------- scrape ----------------------- */

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

  /* ----------------------- stats ----------------------- */

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

  /* ----------------------- admin: trackers ----------------------- */

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

  /* ----------------------- admin: import / export ----------------------- */

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

  /* ----------------------- admin: usage alerts ----------------------- */

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
      metric: config.metric,            // 'torrents' | 'peers' | 'announces' | 'scrapes'
      threshold: Number(config.threshold) || 0,
      comparison: config.comparison || 'gt', // 'gt' | 'gte' | 'lt' | 'lte' | 'eq'
      enabled: config.enabled !== false,
      webhookUrl: config.webhookUrl || '',
      email: config.email || '',
      cooldownMs: Number(config.cooldownMs) || 3600000, // default 1h
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

  /* Evaluate all enabled alerts against current stats and send notifications */
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
      // cooldown
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
    // Webhook notification
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
    // Email placeholder (mailto link or log)
    if (alert.email) {
      console.error(`[tracker] ALERT: ${alert.id} metric=${alert.metric} value=${ctx.value} threshold=${alert.threshold} -> notify ${alert.email}`);
    }
  }

  /* ----------------------- internals ----------------------- */

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
      // update fields
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
      // expire stale peers
      if (now - p.lastAnnounce > PEER_TTL_MS) continue;
      // only peers still downloading (left > 0) unless completed (left === 0)
      // We include all active peers; clients filter as needed.
      peers.push({ ip: p.ip, port: p.port, peerId: pid });
    }
    // shuffle for randomness
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
