const cfg = require('./config');
const serverProcess = require('./serverProcess');
const discord = require('./discordNotifier');
const { getBus } = require('./logBus');

const bus = getBus('server');

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_WINDOW_MINUTES = 10;
const RESTART_DELAY_MS = 10000;

// Timestamps of recent crash-triggered restarts. Only counting crashes
// within a rolling time window (rather than an absolute lifetime total)
// means a one-off crash months apart from another doesn't count against
// it — but three crashes in quick succession correctly looks like a real
// problem and stops the loop.
let crashTimestamps = [];

function recentCrashCount(windowMinutes) {
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  crashTimestamps = crashTimestamps.filter(t => t > cutoff);
  return crashTimestamps.length;
}

function start() {
  serverProcess.events.on('exit', ({ crashed }) => {
    if (!crashed) return;

    const config = cfg.loadConfig();
    if (!config.autoRestartOnCrash) return;

    const maxAttempts = config.crashMaxAttempts || DEFAULT_MAX_ATTEMPTS;
    const windowMinutes = config.crashWindowMinutes || DEFAULT_WINDOW_MINUTES;

    const count = recentCrashCount(windowMinutes);
    if (count >= maxAttempts) {
      bus.push(`Auto-restart: ${count} crashes in the last ${windowMinutes} minutes — giving up. Fix the underlying issue (check the console above, or try Remove all on the Mods tab to isolate a bad mod) and restart manually.`);
      if (config.discordNotifyServerStatus) {
        discord.notify(config.discordWebhookUrl, discord.render(config.discordMsgCrashGivingUp, { serverName: config.serverName, count, windowMinutes }));
      }
      return;
    }

    crashTimestamps.push(Date.now());
    bus.push(`Auto-restart: server crashed, restarting in ${RESTART_DELAY_MS / 1000}s (attempt ${count + 1}/${maxAttempts} in this window)...`);

    setTimeout(() => {
      try {
        serverProcess.start(cfg.loadConfig());
      } catch (err) {
        bus.push(`Auto-restart failed: ${err.message}`);
      }
    }, RESTART_DELAY_MS);
  });
}

function status() {
  const config = cfg.loadConfig();
  const windowMinutes = config.crashWindowMinutes || DEFAULT_WINDOW_MINUTES;
  return {
    enabled: config.autoRestartOnCrash,
    recentCrashes: recentCrashCount(windowMinutes),
    maxAttempts: config.crashMaxAttempts || DEFAULT_MAX_ATTEMPTS,
    windowMinutes
  };
}

module.exports = { start, status };
