'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { loadConfig } = require('./config');
const { Auth } = require('./auth');
const { Hub } = require('./hub');
const log = require('./log');

const cfg = loadConfig();
const auth = new Auth(cfg);
const hub = new Hub(cfg);
const COOKIE = cfg.secureCookies ? '__Host-nsr' : 'nsr';
const PUBLIC = path.join(__dirname, '..', 'public');

// ---- static files (loaded once; [file, requiresLogin]) ---------------------
const STATIC = {
  '/login': ['login.html', false],
  '/': ['index.html', true],
  '/view': ['viewer.html', true],
  '/static/app.css': ['app.css', false],
  '/static/login.js': ['login.js', false],
  '/static/dashboard.js': ['dashboard.js', true],
  '/static/viewer.js': ['viewer.js', true],
  '/static/keymap.js': ['keymap.js', true],
  '/favicon.svg': ['favicon.svg', false],
};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const files = {};
for (const [route, [f]] of Object.entries(STATIC)) {
  files[route] = { body: fs.readFileSync(path.join(PUBLIC, f)), type: MIME[path.extname(f)] };
}

// ---- helpers ---------------------------------------------------------------
function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  if (cfg.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function clientIp(req) {
  const xr = req.headers['x-real-ip'];
  if (cfg.trustProxy && typeof xr === 'string' && xr.length < 64) return xr;
  return req.socket.remoteAddress || '?';
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function session(req) { return auth.get(cookies(req)[COOKIE]); }

function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return false;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 64 * 1024) {
  const b = await readBody(req, limit);
  try { return JSON.parse(b.toString('utf8')); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

function setSessionCookie(res, token, expires) {
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Expires=${new Date(expires).toUTCString()}`];
  if (cfg.secureCookies) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// ---- HTTP long-poll transport for agents ----------------------------------
// Used when WebSockets are blocked or mangled by a (transparent) proxy.
// Everything is plain HTTPS request/response, which virtually every proxy allows.
const POLL_WAIT_MS = 25 * 1000;
const POLL_IDLE_MS = 60 * 1000;
const polls = new Map(); // sid -> { agent, conn, queue, waiting, last }

function makePollConn(ip) {
  const p = { agent: null, queue: [], waiting: null, last: Date.now(), closed: false };
  p.conn = {
    type: 'https-poll',
    ip,
    send(obj) {
      if (p.closed) return;
      const last = p.queue[p.queue.length - 1];
      if (obj.t === 'mm' && last && last.t === 'mm') p.queue[p.queue.length - 1] = obj; // coalesce moves
      else p.queue.push(obj);
      if (p.queue.length > 2000) p.queue.splice(0, p.queue.length - 2000);
      flushPoll(p);
    },
    close() { p.closed = true; flushPoll(p, 410); },
  };
  return p;
}

function flushPoll(p, status) {
  if (!p.waiting) return;
  const { res, timer } = p.waiting;
  if (!status && !p.queue.length) return;
  p.waiting = null;
  clearTimeout(timer);
  if (status) return json(res, status, { error: 'closed' });
  json(res, 200, { cmds: p.queue.splice(0) });
}

function pollFromReq(req) {
  const sid = req.headers['x-nsr-session'];
  const p = typeof sid === 'string' ? polls.get(sid) : null;
  if (p) p.last = Date.now();
  return p;
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, p] of polls) {
    if (p.closed || now - p.last > POLL_IDLE_MS) {
      polls.delete(sid);
      p.closed = true;
      flushPoll(p, 410);
      if (p.agent) hub.detach(p.agent, p.conn);
    }
  }
  hub.enforceSessions(auth);
}, 10 * 1000).unref();

async function handleAgentHttp(req, res, pathname) {
  if (pathname === '/agent/connect' && req.method === 'POST') {
    const hello = await readJson(req);
    if (!hub.checkKey(hello.key)) {
      log(`agent auth failed ip=${clientIp(req)} via=poll`);
      return json(res, 403, { error: 'forbidden' });
    }
    const p = makePollConn(clientIp(req));
    p.agent = hub.attach(hello, p.conn);
    const sid = crypto.randomBytes(24).toString('base64url');
    polls.set(sid, p);
    return json(res, 200, { sid });
  }
  const p = pollFromReq(req);
  if (!p || p.closed) return json(res, 410, { error: 'no session' });

  if (pathname === '/agent/poll' && req.method === 'GET') {
    // a newer poll supersedes an older one still hanging (e.g. proxy dropped it)
    if (p.waiting) { clearTimeout(p.waiting.timer); json(p.waiting.res, 200, { cmds: [] }); p.waiting = null; }
    if (p.queue.length) return json(res, 200, { cmds: p.queue.splice(0) });
    const timer = setTimeout(() => { if (p.waiting && p.waiting.res === res) { p.waiting = null; json(res, 200, { cmds: [] }); } }, POLL_WAIT_MS);
    p.waiting = { res, timer };
    req.on('close', () => { if (p.waiting && p.waiting.res === res) { clearTimeout(timer); p.waiting = null; } });
    return;
  }
  if (pathname === '/agent/frame' && req.method === 'POST') {
    const body = await readBody(req, 32 * 1024 * 1024);
    hub.onFrame(p.agent, body);
    return json(res, 200, { cmds: p.waiting ? [] : p.queue.splice(0) });
  }
  if (pathname === '/agent/msg' && req.method === 'POST') {
    hub.onAgentMessage(p.agent, await readJson(req));
    return json(res, 200, { cmds: p.waiting ? [] : p.queue.splice(0) });
  }
  if (pathname === '/agent/bye' && req.method === 'POST') {
    polls.forEach((v, k) => { if (v === p) polls.delete(k); });
    p.closed = true;
    flushPoll(p, 410);
    hub.detach(p.agent, p.conn);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'not found' });
}

// ---- HTTP routing ----------------------------------------------------------
async function handle(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/healthz') return json(res, 200, { ok: true });
  if (p.startsWith('/agent/')) return handleAgentHttp(req, res, p);

  if (p === '/api/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'bad origin' });
    const ip = clientIp(req);
    const { username, password } = await readJson(req, 4096);
    if (auth.isLockedOut(ip, String(username))) {
      log(`login locked ip=${ip} user=${String(username).slice(0, 64)}`);
      return json(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const r = await auth.login(username, password, ip);
    if (!r) {
      log(`login failed ip=${ip} user=${String(username).slice(0, 64)}`);
      return json(res, 401, { error: 'Invalid username or password' });
    }
    log(`login ok ip=${ip} user=${username}`);
    setSessionCookie(res, r.token, r.expires);
    return json(res, 200, { ok: true, expires: r.expires });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'bad origin' });
    auth.logout(cookies(req)[COOKIE]);
    setSessionCookie(res, '', 0);
    return json(res, 200, { ok: true });
  }

  if (p.startsWith('/api/')) {
    const s = session(req);
    if (!s) return json(res, 401, { error: 'login required' });
    if (p === '/api/me' && req.method === 'GET') return json(res, 200, { user: s.user, expires: s.expires });
    if (p === '/api/agents' && req.method === 'GET') return json(res, 200, { agents: hub.list() });
    const m = p.match(/^\/api\/agents\/([A-Za-z0-9_-]{1,64})$/);
    if (m && req.method === 'DELETE') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'bad origin' });
      const ok = hub.remove(m[1]);
      if (ok) log(`agent removed id=${m[1]} by=${s.user}`);
      return json(res, ok ? 200 : 409, ok ? { ok } : { error: 'agent is online or in use' });
    }
    return json(res, 404, { error: 'not found' });
  }

  if (req.method === 'GET' && files[p]) {
    const needsLogin = STATIC[p][1];
    if (needsLogin && !session(req)) {
      if (p.endsWith('.js')) return json(res, 401, { error: 'login required' });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': files[p].type });
    return res.end(files[p].body);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : 'server error' });
    if (!err.status) log('error', err);
  });
});
server.keepAliveTimeout = 65 * 1000;
server.requestTimeout = 0; // long-poll requests are managed by our own timers

// ---- WebSockets -------------------------------------------------------------
const agentWss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false });
const viewWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });

function heartbeat(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
}
setInterval(() => {
  for (const wss of [agentWss, viewWss]) {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }
}, 20 * 1000).unref();

agentWss.on('connection', (ws, req) => {
  heartbeat(ws);
  const ip = clientIp(req);
  let agent = null;
  const conn = {
    type: 'websocket',
    ip,
    send(obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    close(reason) { ws.close(4000, String(reason).slice(0, 100)); },
  };
  const helloTimer = setTimeout(() => ws.close(4001, 'hello timeout'), 15 * 1000);
  ws.on('message', (data, isBinary) => {
    try {
      if (!agent) {
        const m = isBinary ? null : JSON.parse(data.toString('utf8'));
        if (!m || m.t !== 'hello' || !hub.checkKey(m.key)) {
          log(`agent auth failed ip=${ip} via=websocket`);
          return ws.close(4003, 'forbidden');
        }
        clearTimeout(helloTimer);
        agent = hub.attach(m, conn);
        conn.send({ t: 'welcome' });
        return;
      }
      if (isBinary) {
        hub.onFrame(agent, data);
        conn.send({ t: 'ack' });
      } else {
        hub.onAgentMessage(agent, JSON.parse(data.toString('utf8')));
      }
    } catch (e) {
      log(`agent message error ip=${ip}: ${e.message}`);
      if (agent) conn.send({ t: 'ack' }); // keep the agent moving
    }
  });
  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (agent) hub.detach(agent, conn);
  });
  ws.on('error', () => { /* close follows */ });
});

viewWss.on('connection', (ws, req, ctx) => {
  heartbeat(ws);
  const v = { user: ctx.session.user, sessionKey: ctx.session.key, ws, dirty: false };
  hub.addViewer(ctx.agent, v);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try { hub.onViewerMessage(ctx.agent, v, JSON.parse(data.toString('utf8'))); } catch { /* ignore bad input */ }
  });
  ws.on('close', () => hub.removeViewer(ctx.agent, v));
  ws.on('error', () => { /* close follows */ });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const reject = code => { socket.write(`HTTP/1.1 ${code} No\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if (url.pathname === '/agent/ws') {
    return agentWss.handleUpgrade(req, socket, head, ws => agentWss.emit('connection', ws, req));
  }
  if (url.pathname === '/ws/view') {
    if (!sameOrigin(req)) return reject(403);
    const s = session(req);
    if (!s) return reject(401);
    const agent = hub.get(url.searchParams.get('agent') || '');
    if (!agent) return reject(404);
    return viewWss.handleUpgrade(req, socket, head, ws => viewWss.emit('connection', ws, req, { session: s, agent }));
  }
  reject(404);
});

server.listen(cfg.port, cfg.listenHost, () => {
  log(`NodeSafeRDP server listening on http://${cfg.listenHost}:${cfg.port} (config ${cfg.file})`);
  if (!Object.keys(auth.users()).length) log('WARNING: no users exist yet. Create one with: nodesaferdp-user add <name>');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('shutting down'); process.exit(0); });
