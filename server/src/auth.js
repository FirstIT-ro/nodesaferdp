'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAIL_PER_IP = 10;
const MAX_FAIL_PER_USER = 20;

function scrypt(pw, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(pw, salt, KEYLEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---- user file helpers (also used by cli.js) ----
function usersPath(cfg) { return path.join(cfg.dataDir, 'users.json'); }

function readUsers(cfg) {
  try { return JSON.parse(fs.readFileSync(usersPath(cfg), 'utf8')).users || {}; }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

function writeUsers(cfg, users) { writeJsonAtomic(usersPath(cfg), { users }); }

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt);
  return { algo: 'scrypt', salt: salt.toString('base64'), hash: hash.toString('base64') };
}

function validUsername(u) { return typeof u === 'string' && /^[A-Za-z0-9._@-]{1,64}$/.test(u); }

class Auth {
  constructor(cfg) {
    this.cfg = cfg;
    this.sessFile = path.join(cfg.dataDir, 'sessions.json');
    this.sessions = new Map(); // sha256(token) -> { user, created, expires, ip }
    this.fails = new Map();    // key -> [timestamps]
    this._users = {};
    this._usersMtime = -1;
    this._dummy = null;
    this._loadSessions();
    setInterval(() => this.sweep(), 60 * 1000).unref();
  }

  users() {
    try {
      const st = fs.statSync(usersPath(this.cfg));
      if (st.mtimeMs !== this._usersMtime) {
        this._users = readUsers(this.cfg);
        this._usersMtime = st.mtimeMs;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this._users = {};
    }
    return this._users;
  }

  _loadSessions() {
    try {
      const j = JSON.parse(fs.readFileSync(this.sessFile, 'utf8'));
      const now = Date.now();
      for (const [k, s] of Object.entries(j.sessions || {})) if (s.expires > now) this.sessions.set(k, s);
    } catch { /* none yet */ }
  }

  _saveSessions() {
    writeJsonAtomic(this.sessFile, { sessions: Object.fromEntries(this.sessions) });
  }

  _recentFails(key) {
    const now = Date.now();
    const arr = (this.fails.get(key) || []).filter(t => now - t < WINDOW_MS);
    this.fails.set(key, arr);
    return arr;
  }

  isLockedOut(ip, user) {
    return this._recentFails('ip:' + ip).length >= MAX_FAIL_PER_IP ||
      this._recentFails('u:' + user).length >= MAX_FAIL_PER_USER;
  }

  _fail(ip, user) {
    this._recentFails('ip:' + ip).push(Date.now());
    this._recentFails('u:' + user).push(Date.now());
  }

  // Returns { token, expires } or null.
  async login(username, password, ip) {
    if (!validUsername(username) || typeof password !== 'string' || password.length > 1024) return null;
    const rec = this.users()[username];
    let ok = false;
    if (rec) {
      const h = await scrypt(password, Buffer.from(rec.salt, 'base64'));
      const exp = Buffer.from(rec.hash, 'base64');
      ok = exp.length === h.length && crypto.timingSafeEqual(h, exp);
    } else {
      // constant-ish time for unknown users
      await scrypt(password, Buffer.alloc(16));
    }
    if (!ok) { this._fail(ip, username); return null; }
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const expires = now + this.cfg.sessionHours * 3600 * 1000; // absolute, not sliding
    this.sessions.set(sha256hex(token), { user: username, created: now, expires, ip });
    this._saveSessions();
    return { token, expires };
  }

  // Returns session object (with .key) or null.
  get(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    return this.getByKey(sha256hex(token));
  }

  getByKey(key) {
    const s = this.sessions.get(key);
    if (!s) return null;
    if (!this._valid(s)) {
      this.sessions.delete(key);
      this._saveSessions();
      return null;
    }
    return { ...s, key };
  }

  _valid(s, now = Date.now()) {
    const u = this.users()[s.user];
    return s.expires > now && !!u && !(u.pwChanged && s.created < u.pwChanged);
  }

  logout(token) {
    if (typeof token !== 'string') return;
    if (this.sessions.delete(sha256hex(token))) this._saveSessions();
  }

  sweep() {
    const now = Date.now();
    let changed = false;
    for (const [k, s] of this.sessions) {
      if (!this._valid(s, now)) { this.sessions.delete(k); changed = true; }
    }
    if (changed) this._saveSessions();
    for (const [k] of this.fails) this._recentFails(k).length || this.fails.delete(k);
  }
}

module.exports = { Auth, readUsers, writeUsers, hashPassword, validUsername };
