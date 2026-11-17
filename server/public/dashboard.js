'use strict';
const $ = id => document.getElementById(id);

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts });
  if (r.status === 401) { location.href = '/login'; throw new Error('login required'); }
  return r;
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleString();
}

let sessionExpires = 0;
function tickExpiry() {
  const left = sessionExpires - Date.now();
  if (left <= 0) { location.href = '/login'; return; }
  const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
  $('expiry').textContent = `· session ends in ${h}h ${m}m`;
}

function render(agents) {
  const rows = $('rows');
  rows.replaceChildren();
  $('empty').hidden = agents.length > 0;
  const online = agents.filter(a => a.online).length;
  $('summary').textContent = `${online} of ${agents.length} machine(s) online`;
  for (const a of agents) {
    const status = el('span', {}, el('span', { className: 'dot ' + (a.online ? 'on' : 'off') }), a.online ? 'Online' : 'Offline');
    const open = el('button', { className: 'primary', textContent: 'Connect', disabled: !a.online });
    open.addEventListener('click', () => window.open('/view?agent=' + encodeURIComponent(a.id), '_blank', 'noopener'));
    const actions = el('div', { className: 'actions' }, open);
    if (!a.online) {
      const rm = el('button', { className: 'danger', textContent: 'Remove' });
      rm.addEventListener('click', async () => {
        if (!confirm(`Remove "${a.name}" from the list? It will reappear if its agent connects again.`)) return;
        await api('/api/agents/' + encodeURIComponent(a.id), { method: 'DELETE' });
        refresh();
      });
      actions.append(rm);
    }
    const machine = el('div', {}, el('div', { textContent: a.name }), el('div', { className: 'muted', textContent: a.meta.os || '' }));
    rows.append(el('tr', {},
      el('td', {}, machine),
      el('td', {}, status),
      el('td', { textContent: a.meta.user || '' }),
      el('td', { textContent: a.online ? `${a.transport} · ${a.meta.ip || ''}` : '' }),
      el('td', { textContent: a.viewers.length ? a.viewers.join(', ') : '—' }),
      el('td', { textContent: a.online ? `connected ${ago(a.connectedAt)}` : ago(a.lastSeen) }),
      el('td', {}, actions)));
  }
}

async function refresh() {
  try {
    const r = await api('/api/agents');
    render((await r.json()).agents);
  } catch { /* keep last view */ }
}

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  location.href = '/login';
});

(async () => {
  const me = await (await api('/api/me')).json();
  $('who').textContent = `Signed in as ${me.user}`;
  sessionExpires = me.expires;
  tickExpiry();
  setInterval(tickExpiry, 30000);
  refresh();
  setInterval(refresh, 3000);
})();
