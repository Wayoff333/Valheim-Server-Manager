const crypto = require('crypto');
const cfg = require('./config');

const SESSION_COOKIE_NAME = 'vsm_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const sessions = new Map(); // token -> { createdAt }

// Routes reachable without a session, even when auth is enabled — the
// login page itself, the endpoint that checks credentials, and a status
// check the login page needs before it knows anything else.
const PUBLIC_PATHS = new Set(['/login.html', '/login.js', '/api/auth/login', '/api/auth/status']);

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function setCredentials(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  cfg.saveConfig({ authEnabled: true, authUsername: username, authPasswordHash: hash, authPasswordSalt: salt });
  sessions.clear(); // old sessions shouldn't survive a credential change
}

function disable() {
  cfg.saveConfig({ authEnabled: false, authUsername: '', authPasswordHash: '', authPasswordSalt: '' });
  sessions.clear();
}

function verifyCredentials(username, password) {
  const config = cfg.loadConfig();
  if (!config.authEnabled) return true; // nothing to check against
  if (!username || !password) return false;
  if (username !== config.authUsername) return false;
  if (!config.authPasswordHash || !config.authPasswordSalt) return false;

  const candidate = Buffer.from(hashPassword(password, config.authPasswordSalt), 'hex');
  const stored = Buffer.from(config.authPasswordHash, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored); // timing-safe: avoids leaking hash-match info via response time
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function destroySession(token) {
  sessions.delete(token);
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch (e) {
      cookies[key] = value;
    }
  });
  return cookies;
}

function authMiddleware(req, res, next) {
  const config = cfg.loadConfig();
  if (!config.authEnabled) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();

  const cookies = parseCookies(req.headers.cookie);
  if (isValidSession(cookies[SESSION_COOKIE_NAME])) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  res.redirect('/login.html');
}

module.exports = {
  setCredentials,
  disable,
  verifyCredentials,
  createSession,
  isValidSession,
  destroySession,
  parseCookies,
  authMiddleware,
  SESSION_COOKIE_NAME
};
