'use strict';

/*
 * Storage layer for the tracker.
 *
 * Store interface (all methods return Promises so both sync in-memory and
 * async KV/file backends share one API):
 *   getTorrents()          -> Map<infoHashHex, Torrent>
 *   putTorrent(infoHash, torrent)
 *   deleteTorrent(infoHash)
 *   getTrackers()          -> Map<url, TrackerConfig>
 *   putTracker(url, config)
 *   deleteTracker(url)
 *   close()
 *
 * Torrent shape:
 *   {
 *     infoHash: string,          // hex
 *     name?: string,
 *     createdAt: number,
 *     updatedAt: number,
 *     peers: Map<peerId, Peer>,  // serialized as object in JSON
 *     completed: number
 *   }
 * Peer shape:
 *   {
 *     peerId: string,
 *     ip: string,
 *     port: number,
 *     left: number,
 *     uploaded: number,
 *     downloaded: number,
 *     event: string,             // started | stopped | completed | ''
 *     lastAnnounce: number
 *   }
 * TrackerConfig shape:
 *   {
 *     url: string,
 *     enabled: boolean,
 *     addedAt: number,
 *     note?: string
 *   }
 */

import { encode, decodeSync } from './bencode.js';

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

export class Store {
  async getTorrents() { throw new Error('not implemented'); }
  async putTorrent(infoHash, torrent) { throw new Error('not implemented'); }
  async deleteTorrent(infoHash) { throw new Error('not implemented'); }
  async getTrackers() { throw new Error('not implemented'); }
  async putTracker(url, config) { throw new Error('not implemented'); }
  async deleteTracker(url) { throw new Error('not implemented'); }
  async close() { return undefined; }

  /* Usage alerts (optional) */
  async getAlerts() { return new Map(); }
  async putAlert(id, config) { return undefined; }
  async deleteAlert(id) { return undefined; }
}

/* ------------------------------------------------------------------ */
/* In-memory store (Replit dev / local testing / single instance)     */
/* ------------------------------------------------------------------ */

export class MemoryStore extends Store {
  constructor() {
    super();
    this._torrents = new Map();
    this._trackers = new Map();
    this._alerts = new Map();
  }

  async getTorrents() {
    return new Map(this._torrents);
  }
  async putTorrent(infoHash, torrent) {
    this._torrents.set(infoHash, { ...torrent, peers: { ...(torrent.peers || {}) } });
  }
  async deleteTorrent(infoHash) {
    this._torrents.delete(infoHash);
  }
  async getTrackers() {
    return new Map(this._trackers);
  }
  async putTracker(url, config) {
    this._trackers.set(url, { ...config, url });
  }
  async deleteTracker(url) {
    this._trackers.delete(url);
  }
  async getAlerts() {
    return new Map(this._alerts);
  }
  async putAlert(id, config) {
    this._alerts.set(id, { ...config, id, updatedAt: Date.now() });
  }
  async deleteAlert(id) {
    this._alerts.delete(id);
  }
}

/* ------------------------------------------------------------------ */
/* JSON file store (Node.js / Replit persistent filesystem)           */
/* ------------------------------------------------------------------ */

const fs = await import('fs');
const path = await import('path');

export class FileStore extends Store {
  constructor({ torrentsPath, trackersPath } = {}) {
    super();
    this._fs = fs;
    this._path = path;
    this._torrentsPath = torrentsPath || path.join(process.cwd(), 'data', 'torrents.json');
    this._trackersPath = trackersPath || path.join(process.cwd(), 'data', 'trackers.json');
    this._alertsPath = path.join(process.cwd(), 'data', 'alerts.json');
    this._torrents = new Map();
    this._trackers = new Map();
    this._alerts = new Map();
    this._dirty = false;
    this._flushTimer = null;
  }

  async init() {
    await this._load();
    // Periodic flush every 30s while running
    if (typeof setInterval !== 'undefined') {
      this._flushTimer = setInterval(() => this.flush(), 30000);
      if (this._flushTimer.unref) this._flushTimer.unref();
    }
  }

  async _load() {
    const fs = this._fs;
    try {
      const raw = fs.promises ? await fs.promises.readFile(this._torrentsPath, 'utf8') : await this._readFile(this._torrentsPath);
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        for (const [ih, t] of Object.entries(obj)) {
          this._torrents.set(ih, { ...t, peers: t.peers || {} });
        }
      }
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.message && e.message.includes('ENOENT'))) {
        // first run, no data yet
      } else {
        console.error('[tracker] failed to load torrents:', e);
      }
    }
    try {
      const raw = fs.promises ? await fs.promises.readFile(this._trackersPath, 'utf8') : await this._readFile(this._trackersPath);
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        for (const [url, c] of Object.entries(obj)) {
          this._trackers.set(url, c);
        }
      }
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.message && e.message.includes('ENOENT'))) {
        // first run
      } else {
        console.error('[tracker] failed to load trackers:', e);
      }
    }
    // load alerts
    try {
      const raw = fs.promises ? await fs.promises.readFile(this._alertsPath, 'utf8') : await this._readFile(this._alertsPath);
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        for (const [id, a] of Object.entries(obj)) {
          this._alerts.set(id, a);
        }
      }
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.message && e.message.includes('ENOENT'))) {
        // first run
      } else {
        console.error('[tracker] failed to load alerts:', e);
      }
    }
  }

  _readFile(p) {
    return new Promise((res, rej) => {
      this._fs.readFile(p, 'utf8', (err, data) => err ? rej(err) : res(data));
    });
  }

  async getTorrents() {
    return new Map(this._torrents);
  }
  async putTorrent(infoHash, torrent) {
    this._torrents.set(infoHash, { ...torrent, peers: { ...(torrent.peers || {}) } });
    this._dirty = true;
    this._scheduleFlush();
  }
  async deleteTorrent(infoHash) {
    if (this._torrents.delete(infoHash)) {
      this._dirty = true;
      this._scheduleFlush();
    }
  }
  async getTrackers() {
    return new Map(this._trackers);
  }
  async putTracker(url, config) {
    this._trackers.set(url, { ...config, url });
    this._dirty = true;
    this._scheduleFlush();
  }
  async deleteTracker(url) {
    if (this._trackers.delete(url)) {
      this._dirty = true;
      this._scheduleFlush();
    }
  }
  async getAlerts() {
    return new Map(this._alerts);
  }
  async putAlert(id, config) {
    this._alerts.set(id, { ...config, id, updatedAt: Date.now() });
    this._dirty = true;
    this._scheduleFlush();
  }
  async deleteAlert(id) {
    if (this._alerts.delete(id)) {
      this._dirty = true;
      this._scheduleFlush();
    }
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => this.flush(), 1000);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  async flush() {
    if (!this._dirty) return;
    this._dirty = false;
    this._flushTimer = null;
    const fs = this._fs;
    const dir = this._path.dirname(this._torrentsPath);
    try { fs.promises ? await fs.promises.mkdir(dir, { recursive: true }) : await this._mkdir(dir); } catch {}
    const torrentsObj = {};
    for (const [ih, t] of this._torrents) torrentsObj[ih] = t;
    const trackersObj = {};
    for (const [url, c] of this._trackers) trackersObj[url] = c;
    const alertsObj = {};
    for (const [id, a] of this._alerts) alertsObj[id] = a;
    const write = (p, obj) => fs.promises
      ? fs.promises.writeFile(p, JSON.stringify(obj), 'utf8')
      : new Promise((res, rej) => this._fs.writeFile(p, JSON.stringify(obj), 'utf8', err => err ? rej(err) : res()));
    await write(this._torrentsPath, torrentsObj);
    await write(this._trackersPath, trackersObj);
    await write(this._alertsPath, alertsObj);
  }

  async _mkdir(p) {
    return new Promise((res, rej) => this._fs.mkdir(p, { recursive: true }, err => err ? rej(err) : res()));
  }

  async close() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    await this.flush();
  }
}

/* ------------------------------------------------------------------ */
/* Cloudflare KV store                                                */
/* ------------------------------------------------------------------ */

export class KvStore extends Store {
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
    // KV has no list-by-prefix in Workers without KV list; we list the namespace
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

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/* Serialize/deserialize peers map for JSON round trips */
export function serializeTorrent(t) {
  return {
    infoHash: t.infoHash,
    name: t.name,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    peers: t.peers || {},
    completed: t.completed
  };
}
export function deserializeTorrent(obj) {
  return {
    infoHash: obj.infoHash,
    name: obj.name,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    peers: obj.peers || {},
    completed: obj.completed || 0
  };
}
