const cfg = require('./config');
const serverProcess = require('./serverProcess');
const restartScheduler = require('./restartScheduler');
const { getBus } = require('./logBus');

const bus = getBus('server');

// The restart itself should land as close to the configured time as
// possible, but warnings need lead time — so this actually *triggers* the
// scheduled-restart sequence this many minutes before the target time,
// using the full 20-minute warning window.
const LEAD_MINUTES = 20;

let lastTriggeredDate = null; // 'YYYY-MM-DD', prevents re-triggering within the same day

function pad(n) {
  return String(n).padStart(2, '0');
}

// Pure decision logic, separated out so it can be tested without waiting on
// setInterval or needing a real running server process.
function shouldTriggerNow(config, now, lastTriggeredDateValue) {
  if (!config.dailyRestartEnabled) return false;

  const [targetH, targetM] = String(config.dailyRestartTime || '04:00').split(':').map(n => parseInt(n, 10));
  if (Number.isNaN(targetH) || Number.isNaN(targetM)) return false;

  const target = new Date(now);
  target.setHours(targetH, targetM, 0, 0);
  const triggerAt = new Date(target.getTime() - LEAD_MINUTES * 60 * 1000);

  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (lastTriggeredDateValue === today) return false;

  // Fire once we're at or past the trigger time, within a short window so a
  // missed minute (manager was busy, clock drift) doesn't skip the whole day.
  const msSinceTrigger = now - triggerAt;
  return msSinceTrigger >= 0 && msSinceTrigger < 5 * 60 * 1000;
}

function tick() {
  const config = cfg.loadConfig();
  if (!serverProcess.status().running) return; // nothing to restart
  if (restartScheduler.isScheduled()) return; // don't stack onto an existing scheduled restart

  const now = new Date();
  if (!shouldTriggerNow(config, now, lastTriggeredDate)) return;

  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  lastTriggeredDate = today;
  bus.push(`Daily restart: scheduling restart for ${config.dailyRestartTime} with warnings...`);
  try {
    restartScheduler.scheduleRestart(LEAD_MINUTES, config, 'daily-scheduled');
  } catch (err) {
    bus.push(`Daily restart: could not schedule (${err.message}).`);
  }
}

function start() {
  setInterval(tick, 60 * 1000);
}

function status() {
  const config = cfg.loadConfig();
  return {
    enabled: config.dailyRestartEnabled,
    time: config.dailyRestartTime,
    lastTriggeredDate
  };
}

module.exports = { start, status, shouldTriggerNow };
