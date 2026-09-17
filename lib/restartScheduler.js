const serverProcess = require('./serverProcess');
const discord = require('./discordNotifier');
const { getBus } = require('./logBus');

const bus = getBus('server');

// Warnings fire this many minutes before the restart. Any that don't fit
// within the requested delay are simply skipped (e.g. a 3-minute restart
// only gets the 1-minute warning). Discord-only — see README for why this
// app can't broadcast a message into the game itself.
const WARNING_MINUTES = [20, 10, 5, 1];

let scheduled = null; // { targetTime, timers: [], reason }

function isScheduled() {
  return !!scheduled;
}

function status() {
  if (!scheduled) return { scheduled: false };
  return {
    scheduled: true,
    targetTime: scheduled.targetTime.toISOString(),
    secondsRemaining: Math.max(0, Math.round((scheduled.targetTime - Date.now()) / 1000)),
    reason: scheduled.reason
  };
}

function cancel() {
  if (!scheduled) return false;
  scheduled.timers.forEach(clearTimeout);
  bus.push('Scheduled restart cancelled.');
  scheduled = null;
  return true;
}

// Schedules a restart `delayMinutes` from now, sending Discord warnings at
// whichever of the 10/5/1-minute checkpoints actually fit in that window.
// `onFire` lets a caller (e.g. auto-update) run something other than a
// plain restart at T-0 — e.g. stop, apply changes, then start, so mod
// files are never touched while the server has them open.
function scheduleRestart(delayMinutes, config, reason = 'scheduled', onFire = null) {
  if (scheduled) {
    throw new Error('A restart is already scheduled. Cancel it first.');
  }
  if (!serverProcess.status().running) {
    throw new Error('Server is not running.');
  }

  const targetTime = new Date(Date.now() + delayMinutes * 60 * 1000);
  const timers = [];

  for (const mins of WARNING_MINUTES) {
    const fireAt = delayMinutes - mins;
    if (fireAt < 0) continue; // warning checkpoint doesn't fit in this window
    const delayMs = fireAt * 60 * 1000;
    timers.push(setTimeout(() => {
      const msg = discord.render(config.discordMsgRestartWarning, {
        serverName: config.serverName,
        minutes: mins,
        s: mins === 1 ? '' : 's'
      });
      bus.push(msg);
      if (config.discordNotifyServerStatus) {
        discord.notify(config.discordWebhookUrl, msg);
      }
    }, delayMs));
  }

  timers.push(setTimeout(() => {
    bus.push(`Scheduled restart (${reason}): restarting now.`);
    scheduled = null;
    try {
      if (onFire) {
        onFire(config);
      } else {
        serverProcess.restart(config);
      }
    } catch (err) {
      bus.push(`Scheduled restart failed: ${err.message}`);
    }
  }, delayMinutes * 60 * 1000));

  scheduled = { targetTime, timers, reason };
  bus.push(`Restart scheduled for ${targetTime.toLocaleTimeString()} (${delayMinutes} min from now).`);

  return { targetTime: targetTime.toISOString() };
}

module.exports = { scheduleRestart, cancel, status, isScheduled, WARNING_MINUTES };
