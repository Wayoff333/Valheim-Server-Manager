const cfg = require('./config');
const mods = require('./mods');
const serverProcess = require('./serverProcess');
const restartScheduler = require('./restartScheduler');
const discord = require('./discordNotifier');
const backups = require('./backups');
const { getBus } = require('./logBus');

const bus = getBus('mods');

let lastRunAt = null;
let running = false;

// Checked every minute; only actually does work once the configured
// interval has elapsed, so the interval can be changed in Settings without
// restarting the manager.
function tick() {
  if (running) return;
  const config = cfg.loadConfig();
  if (!config.autoUpdateEnabled) return;

  const intervalMs = Math.max(1, config.autoUpdateIntervalHours) * 60 * 60 * 1000;
  const due = !lastRunAt || (Date.now() - lastRunAt) >= intervalMs;
  if (!due) return;

  runNow(config).catch(err => bus.push(`Auto-update check failed: ${err.message}`));
}

// Stops the server and resolves once it has actually exited (not just once
// the stop signal was sent) — important because writing mod files while
// the process still has them open is exactly what we're trying to avoid.
// Resolves immediately if the server isn't running. Has a timeout
// safety net in case the process never reports exiting.
function stopAndWait(timeoutMs = 30000) {
  return new Promise((resolve) => {
    if (!serverProcess.status().running) {
      resolve();
      return;
    }
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      serverProcess.events.off('exit', onExit);
      bus.push('Auto-update: server did not report exiting within 30s — proceeding anyway.');
      resolve();
    }, timeoutMs);
    serverProcess.events.once('exit', onExit);
    try {
      serverProcess.stop();
    } catch (err) {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function applyUpdates(updatable, config) {
  if (config.autoBackupBeforeUpdate) {
    try {
      const backup = backups.createBackup(config, 'pre-update');
      bus.push(`Auto-update: backed up world before applying updates (${backup.fileName}).`);
    } catch (err) {
      bus.push(`Auto-update: backup before update failed (${err.message}) — continuing anyway.`);
    }
  }

  const results = [];
  for (const mod of updatable) {
    try {
      const r = await mods.updateMod(mod.fullName, config.serverInstallPath);
      results.push({ ...r, ok: true });
    } catch (err) {
      bus.push(`Failed to update ${mod.fullName}: ${err.message}`);
      results.push({ fullName: mod.fullName, ok: false, error: err.message });
    }
  }
  return results.filter(r => r.ok);
}

async function runNow(config) {
  running = true;
  lastRunAt = Date.now();
  try {
    bus.push('Auto-update: checking for mod updates...');
    const checked = await mods.checkForUpdates(config.serverInstallPath);
    const updatable = checked.filter(m => m.updateAvailable);

    if (updatable.length === 0) {
      bus.push('Auto-update: no updates found.');
      return;
    }

    const wasRunning = serverProcess.status().running;

    if (!wasRunning) {
      // Nothing has the mod files open — safe to apply right away.
      const updated = await applyUpdates(updatable, config);
      if (updated.length > 0 && config.discordNotifyModUpdates) {
        discord.notify(config.discordWebhookUrl, discord.render(config.discordMsgModsUpdated, { serverName: config.serverName, names: updated.map(r => r.fullName).join(', '), count: updated.length }));
      }
      return;
    }

    // Server is running: warn players first, then — only once it's
    // actually stopped — apply updates and start back up. Mod files are
    // never touched while the server has them open.
    try {
      bus.push('Auto-update: scheduling updates with warnings (20/10/5/1 min) — server will stop, update, then restart...');
      restartScheduler.scheduleRestart(20, cfg.loadConfig(), 'auto-update', async (currentConfig) => {
        bus.push('Auto-update: stopping server to apply updates...');
        await stopAndWait();
        const updated = await applyUpdates(updatable, currentConfig);
        if (updated.length > 0 && currentConfig.discordNotifyModUpdates) {
          discord.notify(currentConfig.discordWebhookUrl, discord.render(currentConfig.discordMsgModsUpdated, { serverName: currentConfig.serverName, names: updated.map(r => r.fullName).join(', '), count: updated.length }));
        }
        bus.push('Auto-update: starting server back up...');
        serverProcess.start(cfg.loadConfig());
      });
    } catch (err) {
      bus.push(`Auto-update: could not schedule the update (${err.message}) — a restart is likely already scheduled. Will retry next check.`);
    }
  } finally {
    running = false;
  }
}

function start() {
  setInterval(tick, 60 * 1000);
}

function status() {
  const config = cfg.loadConfig();
  return {
    enabled: config.autoUpdateEnabled,
    intervalHours: config.autoUpdateIntervalHours,
    lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
    running
  };
}

module.exports = { start, runNow, status };
