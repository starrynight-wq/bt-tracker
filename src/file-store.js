'use strict';

/*
 * File-backed store for Node.js / Replit deployments.
 *
 * Kept in a separate module because it imports Node built-ins (`fs`, `path`),
 * which must not be pulled into the Cloudflare Workers / Pages bundle.
 * Tracker/server code uses this only on the Node side (see ./server.js).
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';

export class FileStore extends Store {
  constructor({ torrentsPath, trackersPath, alertsPath } = {}) {
    super();
    this._torrentsPath = torrentsPath || path.join(process.cwd(), 'data', 'torrents.json');
    this._trackersPath = trackersPath || path.join(process.cwd(), 'data', 'trackers.json');
    this._alertsPath = alertsPath || path.join(process.cwd(), 'data', 'alerts.json');
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

  async _loadFile(p) {
    try {
      return await fsp.readFile(p, 'utf8');
    } catch (e) {
      if (e && (e.code === 'ENOENT' || (e.message && e.message.includes('ENOENT')))) {
        return null; // first run, no data yet
      }
      console.error('[tracker] failed to load', p, e);
      return null;
    }
  }

  async _load() {
    const torrentsRaw = await this._loadFile(this._torrentsPath);
    if (torrentsRaw) {
      try {
        const obj = JSON.parse(torrentsRaw);
        if (obj && typeof obj === 'object') {
          for (const [ih, t] of Object.entries(obj)) {
            this._torrents.set(ih, { ...t, peers: t.peers || {} });
          }
        }
      } catch (e) { console.error('[tracker] bad torrents file', e); }
    }

    const trackersRaw = await this._loadFile(this._trackersPath);
    if (trackersRaw) {
      try {
        const obj = JSON.parse(trackersRaw);
        if (obj && typeof obj === 'object') {
          for (const [url, c] of Object.entries(obj)) this._trackers.set(url, c);
        }
      } catch (e) { console.error('[tracker] bad trackers file', e); }
    }

    const alertsRaw = await this._loadFile(this._alertsPath);
    if (alertsRaw) {
      try {
        const obj = JSON.parse(alertsRaw);
        if (obj && typeof obj === 'object') {
          for (const [id, a] of Object.entries(obj)) this._alerts.set(id, a);
        }
      } catch (e) { console.error('[tracker] bad alerts file', e); }
    }
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
  async touchTracker(url) {
    const cfg = this._trackers.get(url);
    if (cfg) {
      this._trackers.set(url, { ...cfg, lastUsedAt: Date.now() });
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
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    const dir = path.dirname(this._torrentsPath);
    try { await fsp.mkdir(dir, { recursive: true }); } catch {}
    const torrentsObj = {};
    for (const [ih, t] of this._torrents) torrentsObj[ih] = t;
    const trackersObj = {};
    for (const [url, c] of this._trackers) trackersObj[url] = c;
    const alertsObj = {};
    for (const [id, a] of this._alerts) alertsObj[id] = a;
    await fsp.writeFile(this._torrentsPath, JSON.stringify(torrentsObj), 'utf8');
    await fsp.writeFile(this._trackersPath, JSON.stringify(trackersObj), 'utf8');
    await fsp.writeFile(this._alertsPath, JSON.stringify(alertsObj), 'utf8');
  }

  async close() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    await this.flush();
  }
}
