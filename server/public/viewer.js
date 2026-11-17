'use strict';
/* global KEYMAP */
const $ = id => document.getElementById(id);
const agentId = new URLSearchParams(location.search).get('agent') || '';
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const stage = $('stage');

let ws = null;
let agent = null;
let me = '';
let fit = true;
let viewOnly = false;
let retry = 0;
let stopped = false;
let drawChain = Promise.resolve();
let bytesIn = 0, framesIn = 0;
const pressed = new Map(); // code -> [vk, ext]

// ---- connection --------------------------------------------------------------
function overlay(text) {
  $('overlay').hidden = !text;
  $('overlay').textContent = text || '';
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(`${proto}${location.host}/ws/view?agent=${encodeURIComponent(agentId)}`);
  ws.binaryType = 'arraybuffer';
  $('st-conn').textContent = 'connecting';
  ws.onopen = () => { retry = 0; $('st-conn').textContent = 'connected to server'; };
  ws.onmessage = ev => {
    if (typeof ev.data === 'string') onJson(JSON.parse(ev.data));
    else onFrame(ev.data);
  };
  ws.onclose = ev => {
    releaseAll();
    $('dot').className = 'dot off';
    if (ev.code === 4401) { stopped = true; overlay('Your session has expired.'); setTimeout(() => { location.href = '/login'; }, 1500); return; }
    if (stopped) return;
    retry = Math.min(retry + 1, 6);
    const wait = 500 * 2 ** retry;
    overlay(`Disconnected from server. Reconnecting in ${Math.round(wait / 1000)}s…`);
    setTimeout(connect, wait);
  };
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function onJson(m) {
  if (m.t === 'hello') { me = m.me; setAgent(m.agent); }
  else if (m.t === 'agent') setAgent(m.agent);
}

function setAgent(a) {
  agent = a;
  document.title = `${a.name} · NodeSafeRDP`;
  $('name').textContent = a.name;
  $('dot').className = 'dot ' + (a.online ? 'on' : 'off');
  $('st-conn').textContent = a.online ? `machine online via ${a.transport}` : 'machine offline';
  $('st-viewers').textContent = `Viewers: ${a.viewers.join(', ') || me}`;
  if (!a.online) overlay('The machine is offline. Waiting for its agent to reconnect…');
  else if (!canvas.dataset.got) overlay('Waiting for the first picture…');
  // settings controls
  const mon = $('monitor');
  const mons = a.meta.monitors || [];
  const want = mons.map(x => `${x.i}`).join(',');
  if (mon.dataset.list !== want) {
    mon.replaceChildren(...mons.map(x => {
      const o = document.createElement('option');
      o.value = x.i;
      o.textContent = `${x.i + 1}: ${x.w}×${x.h}${x.primary ? ' (main)' : ''}`;
      return o;
    }));
    mon.dataset.list = want;
  }
  setSelect(mon, a.settings.monitor);
  setSelect($('quality'), a.settings.q);
  setSelect($('scale'), a.settings.scale);
  setSelect($('fps'), a.settings.fps);
}

function setSelect(sel, value) {
  const v = String(value);
  if (![...sel.options].some(o => o.value === v)) {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    sel.append(o);
  }
  sel.value = v;
}

// ---- frames ------------------------------------------------------------------
function onFrame(buf) {
  bytesIn += buf.byteLength;
  framesIn++;
  const dv = new DataView(buf);
  const hl = dv.getUint32(0);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  let off = 4 + hl;
  const parts = h.tiles.map(([x, y, w, th, len]) => {
    const blob = new Blob([new Uint8Array(buf, off, len)], { type: 'image/jpeg' });
    off += len;
    return { x, y, w, h: th, bmp: createImageBitmap(blob) };
  });
  // Draw strictly in arrival order so an older tile never paints over a newer one.
  drawChain = drawChain.then(async () => {
    if (canvas.width !== h.w || canvas.height !== h.h) {
      canvas.width = h.w;
      canvas.height = h.h;
      layout();
    }
    for (const p of parts) {
      try {
        const bmp = await p.bmp;
        ctx.drawImage(bmp, p.x, p.y, p.w, p.h);
        bmp.close();
      } catch { /* skip broken tile */ }
    }
    if (!canvas.dataset.got) { canvas.dataset.got = '1'; }
    if (agent && agent.online) overlay('');
    $('st-res').textContent = `${h.w}×${h.h}`;
  });
}

setInterval(() => {
  $('st-rate').textContent = `${framesIn} fps · ${Math.round(bytesIn * 8 / 1000)} kbit/s`;
  bytesIn = 0; framesIn = 0;
}, 1000);

// ---- layout ------------------------------------------------------------------
function layout() {
  stage.classList.toggle('fit', fit);
  $('fit').textContent = fit ? 'Fit' : '1:1';
  if (!fit) {
    canvas.style.width = canvas.width / devicePixelRatio + 'px';
    canvas.style.height = canvas.height / devicePixelRatio + 'px';
    return;
  }
  const r = stage.getBoundingClientRect();
  const s = Math.min(r.width / canvas.width, r.height / canvas.height);
  canvas.style.width = Math.floor(canvas.width * s) + 'px';
  canvas.style.height = Math.floor(canvas.height * s) + 'px';
}
window.addEventListener('resize', layout);
document.addEventListener('fullscreenchange', layout);

// ---- mouse -------------------------------------------------------------------
let pendingMove = null;
function pos(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}
function flushMove() {
  if (pendingMove) { send({ t: 'mm', ...pendingMove }); pendingMove = null; }
}
const BUTTON = { 0: 0, 2: 1, 1: 2 }; // browser -> agent (0 left, 1 right, 2 middle)

canvas.addEventListener('mousemove', e => {
  if (viewOnly) return;
  if (!pendingMove) requestAnimationFrame(flushMove);
  pendingMove = pos(e);
});
canvas.addEventListener('mousedown', e => {
  canvas.focus();
  if (viewOnly || !(e.button in BUTTON)) return;
  e.preventDefault();
  pendingMove = pos(e); flushMove();
  send({ t: 'md', b: BUTTON[e.button] });
});
canvas.addEventListener('mouseup', e => {
  if (viewOnly || !(e.button in BUTTON)) return;
  e.preventDefault();
  pendingMove = pos(e); flushMove();
  send({ t: 'mu', b: BUTTON[e.button] });
});
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (viewOnly) return;
  const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1; // lines/pages -> px
  const dy = Math.round(-e.deltaY * k * 1.2);
  const dx = Math.round(e.deltaX * k * 1.2);
  if (dy || dx) send({ t: 'wh', dy, dx });
}, { passive: false });

// basic touch: tap = left click, drag = move with button held
canvas.addEventListener('touchstart', e => {
  if (viewOnly) return;
  e.preventDefault();
  send({ t: 'mm', ...pos(e.touches[0]) });
  send({ t: 'md', b: 0 });
}, { passive: false });
canvas.addEventListener('touchmove', e => {
  if (viewOnly) return;
  e.preventDefault();
  send({ t: 'mm', ...pos(e.touches[0]) });
}, { passive: false });
canvas.addEventListener('touchend', e => {
  if (viewOnly) return;
  e.preventDefault();
  send({ t: 'mu', b: 0 });
}, { passive: false });

// ---- keyboard ----------------------------------------------------------------
function keyHandler(down) {
  return e => {
    if (document.activeElement !== canvas || viewOnly) return;
    const k = KEYMAP[e.code];
    if (!k) return;
    e.preventDefault();
    if (down) pressed.set(e.code, k); else pressed.delete(e.code);
    send({ t: down ? 'kd' : 'ku', vk: k[0], ext: k[1] });
  };
}
window.addEventListener('keydown', keyHandler(true));
window.addEventListener('keyup', keyHandler(false));
function releaseAll() {
  for (const [, k] of pressed) send({ t: 'ku', vk: k[0], ext: k[1] });
  pressed.clear();
}
canvas.addEventListener('blur', releaseAll);
window.addEventListener('blur', releaseAll);

const COMBOS = {
  win: ['MetaLeft'],
  alttab: ['AltLeft', 'Tab'],
  ctrlshiftesc: ['ControlLeft', 'ShiftLeft', 'Escape'],
  winr: ['MetaLeft', 'KeyR'],
  wind: ['MetaLeft', 'KeyD'],
  altf4: ['AltLeft', 'F4'],
  ctrlesc: ['ControlLeft', 'Escape'],
};
$('keys').addEventListener('change', e => {
  const combo = COMBOS[e.target.value];
  e.target.value = '';
  canvas.focus();
  if (!combo || viewOnly) return;
  for (const c of combo) send({ t: 'kd', vk: KEYMAP[c][0], ext: KEYMAP[c][1] });
  for (const c of [...combo].reverse()) send({ t: 'ku', vk: KEYMAP[c][0], ext: KEYMAP[c][1] });
});

// ---- toolbar -----------------------------------------------------------------
function sendSettings() {
  send({
    t: 'set',
    monitor: Number($('monitor').value || 0),
    q: Number($('quality').value),
    scale: Number($('scale').value),
    fps: Number($('fps').value),
  });
}
for (const id of ['monitor', 'quality', 'scale', 'fps']) $(id).addEventListener('change', sendSettings);
$('viewonly').addEventListener('change', e => { viewOnly = e.target.checked; releaseAll(); });
$('fit').addEventListener('click', () => { fit = !fit; layout(); });
$('refresh').addEventListener('click', () => send({ t: 'refresh' }));
$('fullscreen').addEventListener('click', async () => {
  if (document.fullscreenElement) { await document.exitFullscreen(); return; }
  await document.documentElement.requestFullscreen();
  // In Chromium this lets Esc, Alt+Tab-like and Windows-key shortcuts reach the remote machine
  if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock().catch(() => {});
  canvas.focus();
});
$('text').addEventListener('click', () => { $('dlg-text').value = ''; $('dlg').showModal(); });
$('dlg').addEventListener('close', () => {
  if ($('dlg').returnValue === 'send' && $('dlg-text').value && !viewOnly) send({ t: 'txt', text: $('dlg-text').value });
  canvas.focus();
});

if (!agentId) { overlay('No machine selected.'); } else { connect(); layout(); }
