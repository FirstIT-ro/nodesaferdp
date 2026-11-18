'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./log');

// ---------------------------------------------------------------------------
// Frame wire format (agent -> server -> browser, identical on all hops):
//   [uint32 BE headerLength][header JSON utf8][tile bytes ...]
//   header = { w, h, reset?:bool, tiles: [[x, y, w, h, byteLength], ...] }
// Each tile is a JPEG. The server keeps the latest tile per position so a
// new or slow viewer can be sent a complete picture at any time.
// ---------------------------------------------------------------------------
const MAX_DIM = 16384;

function parseFrame(buf) {
  if (buf.length < 4) throw new Error('short frame');
  const hl = buf.readUInt32BE(0);
  if (hl > 1024 * 1024 || 4 + hl > buf.length) throw new Error('bad header length');
  const h = JSON.parse(buf.toString('utf8', 4, 4 + hl));
  const w = h.w | 0, hh = h.h | 0;
  if (w <= 0 || hh <= 0 || w > MAX_DIM || hh > MAX_DIM) throw new Error('bad size');
  if (!Array.isArray(h.tiles) || h.tiles.length > 20000) throw new Error('bad tiles');
  let off = 4 + hl;
  const tiles = [];
  for (const t of h.tiles) {
    if (!Array.isArray(t) || t.length !== 5) throw new Error('bad tile');
    const [x, y, tw, th, len] = t.map(n => n | 0);
    if (x < 0 || y < 0 || tw <= 0 || th <= 0 || x + tw > w || y + th > hh) throw new Error('tile out of range');
    if (len <= 0 || off + len > buf.length) throw new Error('tile length');
    tiles.push({ x, y, w: tw, h: th, data: Buffer.from(buf.subarray(off, off + len)) });
    off += len;
  }
  return { w, h: hh, reset: !!h.reset, tiles };
}

function buildFrame(w, h, reset, tiles) {
  const header = Buffer.from(JSON.stringify({
    w, h, reset, tiles: tiles.map(t => [t.x, t.y, t.w, t.h, t.data.length]),
  }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length, 0);
  return Buffer.concat([len, header, ...tiles.map(t => t.data)]);
}

const clean = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '');
const num = (v, lo, hi, def) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
const int = (v, lo, hi, def) => Math.round(num(v, lo, hi, def));
const sha = s => crypto.createHash('sha256').update(String(s)).digest();

const SEND_HIGH_WATER = 8 * 1024 * 1024; // viewer is behind: stop sending deltas
const SEND_LOW_WATER = 1024 * 1024;      // caught up: send a full picture

class Hub {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = path.join(cfg.dataDir, 'agents.json');
    this.agents = new Map();
    this.keyHash = sha(cfg.agentKey);
    this._saveTimer = null;
    this._load();
  }

  checkKey(k) {
    return typeof k === 'string' && k.length > 0 && k.length < 512 && crypto.timingSafeEqual(sha(k), this.keyHash);
  }

  _new(id, saved = {}) {
    return {
      id,
      name: saved.name || id,
      meta: saved.meta || {},
      lastSeen: saved.lastSeen || 0,
      conn: null,
      connectedAt: 0,
      viewers: new Set(),
      tiles: new Map(),
      screen: { w: 0, h: 0 },
      settings: { q: 60, scale: 1, monitor: 0, fps: 12 },
      streaming: false,
      stats: { frames: 0, bytes: 0 },
    };
  }

  _load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const a of j.agents || []) this.agents.set(a.id, this._new(a.id, a));
    } catch { /* first start */ }
  }

  _save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      const agents = [...this.agents.values()].map(a => ({
        id: a.id, name: a.name, meta: a.meta, lastSeen: a.conn ? Date.now() : a.lastSeen,
      }));
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ agents }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    }, 1000);
  }

  publicAgent(a) {
    return {
      id: a.id,
      name: a.name,
      online: !!a.conn,
      transport: a.conn ? a.conn.type : null,
      meta: a.meta,
      lastSeen: a.conn ? Date.now() : a.lastSeen,
      connectedAt: a.conn ? a.connectedAt : null,
      viewers: [...new Set([...a.viewers].map(v => v.user))],
      screen: a.screen,
      settings: a.settings,
    };
  }

  list() {
    return [...this.agents.values()].map(a => this.publicAgent(a))
      .sort((x, y) => (y.online - x.online) || x.name.localeCompare(y.name));
  }

  get(id) { return this.agents.get(id) || null; }

  remove(id) {
    const a = this.agents.get(id);
    if (!a || a.conn || a.viewers.size) return false;
    this.agents.delete(id);
    this._save();
    return true;
  }

  // ---- agent side --------------------------------------------------------
  attach(hello, conn) {
    const id = String(hello.id || '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error('bad agent id');
    let a = this.agents.get(id);
    if (!a) { a = this._new(id); this.agents.set(id, a); }
    if (a.conn && a.conn !== conn) {
      const old = a.conn;
      a.conn = null;
      try { old.close('replaced by new connection'); } catch { /* ignore */ }
    }
    const monitors = Array.isArray(hello.monitors) ? hello.monitors.slice(0, 16).map((m, i) => ({
      i, w: int(m.w, 0, MAX_DIM, 0), h: int(m.h, 0, MAX_DIM, 0), primary: !!m.primary, name: clean(m.name, 64),
    })) : [];
    a.conn = conn;
    a.name = clean(hello.name, 64) || id;
    a.meta = {
      os: clean(hello.os, 128), user: clean(hello.user, 128), version: clean(hello.version, 32),
      monitors, ip: conn.ip,
    };
    a.connectedAt = Date.now();
    a.lastSeen = Date.now();
    a.tiles.clear();
    a.screen = { w: 0, h: 0 };
    a.streaming = false;
    if (a.settings.monitor >= monitors.length) a.settings.monitor = 0;
    this._save();
    log(`agent online id=${id} name="${a.name}" via=${conn.type} ip=${conn.ip}`);
    this._broadcastJson(a, { t: 'agent', agent: this.publicAgent(a) });
    this._updateStream(a, false);
    this._sendViewerListToAgent(a);
    return a;
  }

  detach(a, conn) {
    if (a.conn !== conn) return;
    a.conn = null;
    a.lastSeen = Date.now();
    a.streaming = false;
    this._save();
    log(`agent offline id=${a.id} name="${a.name}"`);
    this._broadcastJson(a, { t: 'agent', agent: this.publicAgent(a) });
  }

  onFrame(a, buf) {
    const f = parseFrame(buf);
    if (f.reset || f.w !== a.screen.w || f.h !== a.screen.h) {
      a.tiles.clear();
      a.screen = { w: f.w, h: f.h };
    }
    // Map keeps insertion order = paint order, so re-insert updated tiles at the end
    for (const t of f.tiles) {
      const k = `${t.x},${t.y},${t.w},${t.h}`;
      a.tiles.delete(k);
      a.tiles.set(k, t);
    }
    // tiles can be merged/split differently between frames: drop cached tiles fully covered by new ones
    if (!f.reset && f.tiles.length) this._dropCovered(a, f.tiles);
    a.lastSeen = Date.now();
    a.stats.frames++;
    a.stats.bytes += buf.length;

    let full = null;
    for (const v of a.viewers) {
      const ws = v.ws;
      if (ws.readyState !== 1) continue;
      if (v.dirty || ws.bufferedAmount > SEND_HIGH_WATER) {
        v.dirty = true;
        if (ws.bufferedAmount < SEND_LOW_WATER) {
          full = full || this._composite(a);
          ws.send(full);
          v.dirty = false;
        }
        continue;
      }
      ws.send(buf);
    }
  }

  _dropCovered(a, fresh) {
    const freshKeys = new Set(fresh.map(t => `${t.x},${t.y},${t.w},${t.h}`));
    for (const [k, t] of a.tiles) {
      if (freshKeys.has(k)) continue;
      for (const n of fresh) {
        if (t.x >= n.x && t.y >= n.y && t.x + t.w <= n.x + n.w && t.y + t.h <= n.y + n.h) {
          a.tiles.delete(k);
          break;
        }
      }
    }
  }

  _composite(a) {
    return buildFrame(a.screen.w, a.screen.h, true, [...a.tiles.values()]);
  }

  onAgentMessage(a, m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hb') { a.lastSeen = Date.now(); return; }
    if (m.t === 'monitors' && Array.isArray(m.monitors)) {
      a.meta.monitors = m.monitors.slice(0, 16).map((x, i) => ({
        i, w: int(x.w, 0, MAX_DIM, 0), h: int(x.h, 0, MAX_DIM, 0), primary: !!x.primary, name: clean(x.name, 64),
      }));
      this._broadcastJson(a, { t: 'agent', agent: this.publicAgent(a) });
    }
  }

  _updateStream(a, force) {
    if (!a.conn) return;
    if (a.viewers.size > 0) {
      if (!a.streaming || force) {
        a.conn.send({ t: 'stream', on: true, ...a.settings });
        a.streaming = true;
      }
    } else if (a.streaming) {
      a.conn.send({ t: 'stream', on: false });
      a.streaming = false;
    }
  }

  _sendViewerListToAgent(a) {
    if (a.conn) a.conn.send({ t: 'viewers', users: [...new Set([...a.viewers].map(v => v.user))] });
  }

  _broadcastJson(a, obj) {
    const s = JSON.stringify(obj);
    for (const v of a.viewers) if (v.ws.readyState === 1) v.ws.send(s);
  }

  // ---- viewer side -------------------------------------------------------
  addViewer(a, v) {
    a.viewers.add(v);
    log(`viewer join user=${v.user} agent=${a.id}`);
    v.ws.send(JSON.stringify({ t: 'hello', me: v.user, agent: this.publicAgent(a) }));
    if (a.conn && a.tiles.size && a.screen.w) v.ws.send(this._composite(a));
    this._updateStream(a, false);
    this._broadcastJson(a, { t: 'agent', agent: this.publicAgent(a) });
    this._sendViewerListToAgent(a);
  }

  removeViewer(a, v) {
    if (!a.viewers.delete(v)) return;
    log(`viewer leave user=${v.user} agent=${a.id}`);
    this._updateStream(a, false);
    this._broadcastJson(a, { t: 'agent', agent: this.publicAgent(a) });
    this._sendViewerListToAgent(a);
  }

  onViewerMessage(a, v, m) {
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    const c = a.conn;
    switch (m.t) {
      case 'mm':
        if (c) c.send({ t: 'mm', x: num(m.x, 0, 1, 0), y: num(m.y, 0, 1, 0) });
        break;
      case 'md': case 'mu':
        if (c) c.send({ t: m.t, b: int(m.b, 0, 2, 0) });
        break;
      case 'wh':
        if (c) c.send({ t: 'wh', dy: int(m.dy, -2400, 2400, 0), dx: int(m.dx, -2400, 2400, 0) });
        break;
      case 'kd': case 'ku':
        if (c) c.send({ t: m.t, vk: int(m.vk, 1, 254, 0), ext: !!m.ext });
        break;
      case 'txt':
        if (c && typeof m.text === 'string' && m.text.length <= 20000) c.send({ t: 'txt', text: m.text });
        break;
      case 'set': {
        const s = a.settings;
        s.q = int(m.q, 10, 95, s.q);
        s.scale = num(m.scale, 0.25, 1, s.scale);
        s.monitor = int(m.monitor, 0, 15, s.monitor);
        s.fps = int(m.fps, 1, 30, s.fps);
        this._updateStream(a, true);
        this._broadcastJson(a, { t: 'agent', agent: this.publicAgent(a) });
        break;
      }
      case 'refresh':
        if (c) c.send({ t: 'key' });
        break;
      default:
        break;
    }
  }

  // Close viewers whose login session expired or was revoked.
  enforceSessions(auth) {
    for (const a of this.agents.values()) {
      for (const v of a.viewers) {
        if (!auth.getByKey(v.sessionKey)) {
          try { v.ws.close(4401, 'session expired'); } catch { /* ignore */ }
        }
      }
    }
  }
}

module.exports = { Hub, parseFrame, buildFrame };
