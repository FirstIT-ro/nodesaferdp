'use strict';
document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const err = document.getElementById('err');
  const btn = f.querySelector('button');
  err.textContent = '';
  btn.disabled = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: f.username.value.trim(), password: f.password.value }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { location.href = '/'; return; }
    err.textContent = j.error || 'Sign-in failed';
  } catch {
    err.textContent = 'Network error';
  } finally {
    btn.disabled = false;
  }
});
