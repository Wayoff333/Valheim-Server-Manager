const express = require('express');
const path = require('path');
const fs = require('fs');

const cfg = require('./lib/config');
const steamcmd = require('./lib/steamcmd');
const serverProcess = require('./lib/serverProcess');
const thunderstore = require('./lib/thunderstore');
const playerTracker = require('./lib/playerTracker');
const deathTracker = require('./lib/deathTracker');
const autoUpdate = require('./lib/autoUpdate');
const discord = require('./lib/discordNotifier');
const accessLists = require('./lib/accessLists');
const serverInfo = require('./lib/serverInfo');
const mods = require('./lib/mods');
const modSearch = require('./lib/modSearch');
const backups = require('./lib/backups');
const crashRecovery = require('./lib/crashRecovery');
const systemStats = require('./lib/systemStats');
const restartScheduler = require('./lib/restartScheduler');
const dailyRestart = require('./lib/dailyRestart');
const autostart = require('./lib/autostart');
const { getBus } = require('./lib/logBus');
const auth = require('./lib/auth');

const app = express();
app.use(express.json());
// Auth gate goes BEFORE static file serving, so index.html/app.js also
// require a session when auth is enabled — not just the API calls. The
// login page itself (and its own tiny script) are in auth's public-path
// allowlist so they're still reachable.
app.use(auth.authMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// ---- Auth ---------------------------------------------------------------

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!auth.verifyCredentials(username, password)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const token = auth.createSession();
  // No Secure flag: this app only serves over plain HTTP (see README on
  // why it's not exposed to the internet) — Secure would just break the
  // cookie on that http:// origin, not add protection.
  res.setHeader('Set-Cookie', `${auth.SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 60 * 60}`);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = auth.parseCookies(req.headers.cookie);
  auth.destroySession(cookies[auth.SESSION_COOKIE_NAME]);
  res.setHeader('Set-Cookie', `${auth.SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/auth/status', (req, res) => {
  const config = cfg.loadConfig();
  const cookies = auth.parseCookies(req.headers.cookie);
  res.json({
    authEnabled: config.authEnabled,
    username: config.authEnabled ? config.authUsername : null,
    loggedIn: !config.authEnabled || auth.isValidSession(cookies[auth.SESSION_COOKIE_NAME])
  });
});

// Setting up or changing credentials always requires being on an
// authenticated session already if auth is currently enabled — the
// middleware above already enforces that for this path (it's not in the
// public-path allowlist), so no extra check is needed here.
app.post('/api/auth/setup', (req, res) => {
  const { username, password, enable } = req.body || {};

  if (enable === false) {
    auth.disable();
    return res.json({ ok: true, authEnabled: false });
  }

  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'Username and a password of at least 8 characters are required.' });
  }
  auth.setCredentials(username, password);
  res.json({ ok: true, authEnabled: true });
});

const PORT = process.env.MANAGER_PORT || 4656;
// Bind to localhost only unless the user explicitly opts into LAN access in
// Settings — this dashboard has no authentication, so it should never be
// reachable off the local machine by default. See README for why forwarding
// this port on a router is not safe even with the opt-in on.
const HOST = cfg.loadConfig().allowNetworkAccess ? '0.0.0.0' : '127.0.0.1';

// ---- Config ---------------------------------------------------------------

app.get('/api/config', (req, res) => {
  // Never send auth secrets back to the frontend — they're write-only,
  // set via /api/auth/setup, never round-tripped through the normal
  // settings form.
  const { authPasswordHash, authPasswordSalt, ...safeConfig } = cfg.loadConfig();
  res.json(safeConfig);
});

app.post('/api/config', (req, res) => {
  try {
    // Auth fields only change via /api/auth/setup, which hashes the
    // password properly — never accept them directly through the general
    // settings form, even if someone included them in the payload.
    const { authEnabled, authUsername, authPasswordHash, authPasswordSalt, ...safeUpdates } = req.body || {};
    const updated = cfg.saveConfig(safeUpdates);
    const { authPasswordHash: _h, authPasswordSalt: _s, ...safeResponse } = updated;
    res.json(safeResponse);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Server install / update (SteamCMD) -----------------------------------

app.post('/api/install', async (req, res) => {
  const config = cfg.loadConfig();
  if (steamcmd.isInstallRunning()) {
    return res.status(409).json({ error: 'Install already in progress.' });
  }
  res.json({ started: true });
  try {
    await steamcmd.ensureSteamCmd(config.steamCmdPath);
    await steamcmd.installOrUpdateServer(config.steamCmdPath, config.serverInstallPath);
  } catch (err) {
    getBus('install').push(`Install failed: ${err.message}`);
  }
});

app.get('/api/install/status', (req, res) => {
  res.json({ running: steamcmd.isInstallRunning() });
});

// ---- Server process ---------------------------------------------------------

app.get('/api/server/status', (req, res) => {
  res.json(serverProcess.status());
});

app.get('/api/server/connect-info', (req, res) => {
  const config = cfg.loadConfig();
  const info = serverInfo.getInfo();
  res.json({
    address: info.publicIp ? `${info.publicIp}:${config.port}` : null,
    password: config.password,
    joinCode: info.joinCode,
    crossplayEnabled: config.crossplay
  });
});

app.get('/api/server/stats', async (req, res) => {
  try {
    const stats = await systemStats.getServerStats(serverProcess.getPid());
    res.json(stats); // null if unavailable (not running, non-Windows, first sample)
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/crash-recovery/status', (req, res) => {
  res.json(crashRecovery.status());
});

app.get('/api/daily-restart/status', (req, res) => {
  res.json(dailyRestart.status());
});

app.get('/api/autostart/status', (req, res) => {
  res.json({ enabled: autostart.isEnabled() });
});

app.post('/api/autostart', async (req, res) => {
  const { enabled } = req.body || {};
  try {
    if (enabled) {
      await autostart.enable();
    } else {
      autostart.disable();
    }
    res.json({ enabled: autostart.isEnabled() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- World backups ----------------------------------------------------

app.get('/api/worlds', (req, res) => {
  const config = cfg.loadConfig();
  try {
    res.json(backups.listAvailableWorlds(config));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/worlds/open-folder', (req, res) => {
  const config = cfg.loadConfig();
  const { getEffectiveSaveDir } = require('./lib/config');
  const worldsDir = path.join(getEffectiveSaveDir(config), 'worlds_local');
  if (process.platform !== 'win32') {
    return res.status(400).json({ error: 'Opening a folder in File Explorer only works on Windows.' });
  }
  require('child_process').exec(`explorer "${worldsDir}"`, (err) => {
    // explorer.exe returns a nonzero exit code on success in some Windows
    // versions even when it opens fine — only report a real failure if the
    // folder itself doesn't exist.
    if (err && !fs.existsSync(worldsDir)) {
      return res.status(400).json({ error: `Folder not found: ${worldsDir}` });
    }
    res.json({ opened: worldsDir });
  });
});

app.get('/api/backups', (req, res) => {
  try {
    res.json(backups.listBackups());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/backups', (req, res) => {
  const config = cfg.loadConfig();
  try {
    const result = backups.createBackup(config, 'manual');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/backups/:fileName/restore', (req, res) => {
  const config = cfg.loadConfig();
  if (serverProcess.status().running) {
    return res.status(409).json({ error: 'Stop the server before restoring a backup — restoring into a running world\'s files would corrupt them.' });
  }
  try {
    backups.restoreBackup(req.params.fileName, config);
    res.json({ restored: req.params.fileName });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/backups/:fileName', (req, res) => {
  try {
    backups.deleteBackup(req.params.fileName);
    res.json({ deleted: req.params.fileName });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/server/start', (req, res) => {
  try {
    const config = cfg.loadConfig();
    res.json(serverProcess.start(config));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/server/stop', (req, res) => {
  try {
    res.json(serverProcess.stop());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/server/restart', (req, res) => {
  try {
    const config = cfg.loadConfig();
    res.json(serverProcess.restart(config));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/server/schedule-restart', (req, res) => {
  const config = cfg.loadConfig();
  const minutes = Number(req.body?.minutes);
  if (!minutes || minutes <= 0) {
    return res.status(400).json({ error: 'Enter a number of minutes greater than 0.' });
  }
  try {
    const result = restartScheduler.scheduleRestart(minutes, config, 'manual');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/server/cancel-scheduled-restart', (req, res) => {
  res.json({ cancelled: restartScheduler.cancel() });
});

app.get('/api/server/scheduled-restart', (req, res) => {
  res.json(restartScheduler.status());
});

// ---- Mods (Thunderstore + Hexium) -------------------------------------------

app.get('/api/mods', (req, res) => {
  const config = cfg.loadConfig();
  try {
    res.json(mods.listInstalledMods(config.serverInstallPath));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/mods/bepinex', async (req, res) => {
  const config = cfg.loadConfig();
  try {
    const result = await thunderstore.installBepInEx(config.serverInstallPath);
    cfg.saveConfig({ bepinexInstalled: true });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/mods/discordconnector', async (req, res) => {
  const config = cfg.loadConfig();
  try {
    const result = await thunderstore.installDiscordConnector(config.serverInstallPath);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Installs a specific mod directly from Hexium by author/mod name — for
// when a friend says "grab X from Hexium" rather than sharing a whole
// profile code. See lib/hexium.js for how this works (HTML scraping, since
// Hexium's JSON API blocks automated access).
app.post('/api/mods/hexium', async (req, res) => {
  const config = cfg.loadConfig();
  const { namespace, name } = req.body || {};
  if (!namespace || !name) {
    return res.status(400).json({ error: 'Provide both the author (namespace) and mod name.' });
  }
  try {
    const result = await mods.installHexiumMod(namespace, name, config.serverInstallPath);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/mods/thunderstore', async (req, res) => {
  const config = cfg.loadConfig();
  const { namespace, name } = req.body || {};
  if (!namespace || !name) {
    return res.status(400).json({ error: 'Provide both the author (namespace) and mod name.' });
  }
  try {
    const result = await thunderstore.installMod({ namespace, name }, config.serverInstallPath);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/mods/import', async (req, res) => {
  const config = cfg.loadConfig();
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Missing profile code.' });
  if (mods.isImportRunning()) {
    return res.status(409).json({ error: 'An import is already in progress.' });
  }

  res.json({ started: true });
  try {
    await mods.importProfile(code, config.serverInstallPath);
    cfg.saveConfig({ bepinexInstalled: true });
  } catch (err) {
    getBus('mods').push(`Import failed: ${err.message}`);
  }
});

app.get('/api/mods/import/status', (req, res) => {
  res.json({ running: mods.isImportRunning() });
});

app.post('/api/mods/export', async (req, res) => {
  const config = cfg.loadConfig();
  const backend = req.body?.backend; // 'thunderstore' | 'hexium' | undefined (auto)
  try {
    const result = await mods.exportProfileCode(config.serverInstallPath, backend);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/mods/search', async (req, res) => {
  const q = req.query.q || '';
  const source = req.query.source || 'all'; // 'thunderstore' | 'hexium' | 'all'
  try {
    const { results, warnings } = await modSearch.search(q, 20, source);
    res.json({ results, warnings });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/mods/updates', async (req, res) => {
  const config = cfg.loadConfig();
  try {
    const results = await mods.checkForUpdates(config.serverInstallPath);
    res.json(results);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/mods/:fullName/update', async (req, res) => {
  const config = cfg.loadConfig();
  try {
    const result = await mods.updateMod(req.params.fullName, config.serverInstallPath);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/mods/update-all', async (req, res) => {
  const config = cfg.loadConfig();
  res.json({ started: true });
  try {
    await mods.updateAllMods(config.serverInstallPath);
  } catch (err) {
    getBus('mods').push(`Update-all failed: ${err.message}`);
  }
});

app.delete('/api/mods/:fullName', (req, res) => {
  const config = cfg.loadConfig();
  try {
    mods.removeMod(req.params.fullName, config.serverInstallPath);
    res.json({ removed: req.params.fullName });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/mods/remove-all', (req, res) => {
  const config = cfg.loadConfig();
  try {
    const results = mods.removeAllMods(config.serverInstallPath);
    getBus('mods').push(`Removed ${results.filter(r => r.ok).length} mod(s). BepInEx core was kept.`);
    res.json(results);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Players --------------------------------------------------------------

app.get('/api/players/online', async (req, res) => {
  const config = cfg.loadConfig();
  try {
    res.json(await playerTracker.getOnline(config.steamApiKey));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/players/history', (req, res) => {
  res.json(playerTracker.getHistory(150));
});

// ---- Deaths (best-effort; vanilla logs don't include deaths — see README) -

app.get('/api/deaths', (req, res) => {
  res.json(deathTracker.getHistory(150));
});

// ---- Auto-update status + manual trigger -----------------------------------

app.get('/api/autoupdate/status', (req, res) => {
  res.json(autoUpdate.status());
});

app.post('/api/autoupdate/run', async (req, res) => {
  res.json({ started: true });
  try {
    await autoUpdate.runNow(cfg.loadConfig());
  } catch (err) {
    getBus('mods').push(`Manual auto-update run failed: ${err.message}`);
  }
});

// ---- Discord ----------------------------------------------------------------

app.post('/api/discord/test', async (req, res) => {
  const config = cfg.loadConfig();
  if (!config.discordWebhookUrl) {
    return res.status(400).json({ error: 'Set a Discord webhook URL in Settings first.' });
  }
  try {
    await discord.notify(config.discordWebhookUrl, `👋 Test message from the ${config.serverName} manager.`);
    res.json({ sent: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Access lists (admin / banned / permitted SteamIDs) --------------------

app.get('/api/access-lists', (req, res) => {
  res.json(accessLists.getAll());
});

app.post('/api/access-lists/:type', (req, res) => {
  const config = cfg.loadConfig();
  const { steamId, name } = req.body || {};
  if (!steamId) return res.status(400).json({ error: 'Missing steamId.' });
  try {
    const list = accessLists.addEntry(req.params.type, steamId, name, config);
    res.json(list);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/access-lists/:type/:steamId', (req, res) => {
  const config = cfg.loadConfig();
  try {
    const list = accessLists.removeEntry(req.params.type, req.params.steamId, config);
    res.json(list);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Live log streaming (SSE) ----------------------------------------------
// channel is one of: server | install | mods

app.get('/api/logs/:channel/stream', (req, res) => {
  const bus = getBus(req.params.channel);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  for (const entry of bus.history()) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const onLine = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
  bus.on('line', onLine);

  req.on('close', () => {
    bus.off('line', onLine);
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Valheim Server Manager running at http://localhost:${PORT} (bound to ${HOST})`);
});

// Auto mod-update scheduler (checks every minute, acts once the configured
// interval has elapsed — see lib/autoUpdate.js).
autoUpdate.start();

// Restarts the server automatically after an unexpected exit (crash), with
// a cooldown so a permanently broken mod can't trigger an infinite loop.
crashRecovery.start();

// Triggers a daily scheduled restart at a configured time, if enabled.
dailyRestart.start();

// Best-effort death detection by tailing BepInEx's log file, in addition to
// the live process stdout that deathTracker already listens to directly.
setInterval(() => {
  const config = cfg.loadConfig();
  deathTracker.pollLogFile(config.serverInstallPath);
}, 5000);
