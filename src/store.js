'use strict';

/*
 * Storage layer for the tracker (runtime-agnostic).
 *
 * This module must stay free of Node.js-only imports so it can be bundled
 * for Cloudflare Workers and Pages Functions. The Node/Replit file store
 * lives in ./file-store.js instead.
 *
 * Store interface (all methods return Promises so both sync in-memory and
 * async KV/file backends share one API):
 *   getTorrents()          -> Map<infoHashHex, Torrent>
 *   putTorrent(infoHash, torrent)
 *   deleteTorrent(infoHash)
 *   getTrackers()          -> Map<url, TrackerConfig>
 *   putTracker(url, config)
 *   deleteTracker(url)
 *   touchTracker(url)      -> update lastUsedAt of an existing tracker (no-op if missing)
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
 *     note?: string,
 *     lastUsedAt?: number   // timestamp of last successful external fetch (ms)
 *   }
 */

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
  async touchTracker(url) { return undefined; }
  async close() { return undefined; }

  /* Usage alerts (optional) */
  async getAlerts() { return new Map(); }
  async putAlert(id, config) { return undefined; }
  async deleteAlert(id) { return undefined; }
}

/* ------------------------------------------------------------------ */
/* In-memory store (tests / single instance)                          */
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
  async getTrackers() { return new Map(this._trackers); }
  async putTracker(url, config) {
    this._trackers.set(url, { ...config, url });
  }
  async deleteTracker(url) {
    this._trackers.delete(url);
  }
  async touchTracker(url) {
    const cfg = this._trackers.get(url);
    if (cfg) this._trackers.set(url, { ...cfg, lastUsedAt: Date.now() });
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
    if (!this._torrentsNS) return map;
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
    if (!this._trackersNS) return map;
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
  async touchTracker(url) {
    if (!this._trackersNS) return;
    const raw = await this._trackersNS.get(this._k(url));
    if (!raw) return;
    try {
      const cfg = JSON.parse(raw);
      cfg.lastUsedAt = Date.now();
      await this._trackersNS.put(this._k(url), JSON.stringify(cfg));
    } catch {}
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
