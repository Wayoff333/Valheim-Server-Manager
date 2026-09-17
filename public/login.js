async function attemptLogin() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('loginError');
  const btn = document.getElementById('btnLogin');

  errorEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Signing in...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Sign in failed.');
    }
    window.location.href = '/';
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

document.getElementById('btnLogin').addEventListener('click', attemptLogin);
document.getElementById('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') attemptLogin();
});

// If auth turned out not to be enabled (e.g. someone navigated here
// directly without it on), just bounce to the dashboard.
fetch('/api/auth/status').then(r => r.json()).then(status => {
  if (!status.authEnabled) window.location.href = '/';
});
