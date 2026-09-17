const os = require('os');
const { exec } = require('child_process');

// Windows only has Get-Process's cumulative CPU-seconds-since-start, not an
// instant percentage — so this tracks the previous sample and computes a
// delta-based percentage (normalized against core count, matching how Task
// Manager's overall CPU% works) each time it's polled.
let lastSample = null; // { pid, cpuSeconds, timestamp }

function queryProcess(pid) {
  return new Promise((resolve, reject) => {
    const cmd = `powershell -NoProfile -Command "Get-Process -Id ${pid} | Select-Object Id,CPU,WorkingSet64 | ConvertTo-Json"`;
    exec(cmd, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        resolve({ pid: data.Id, cpuSeconds: data.CPU || 0, memoryBytes: data.WorkingSet64 || 0 });
      } catch (parseErr) {
        reject(new Error('Could not parse process stats.'));
      }
    });
  });
}

// Returns { cpuPercent, memoryMB, totalMemoryMB, memoryPercent } or null if
// unavailable (server not running, non-Windows, or this is the very first
// sample — a percentage needs two samples over time to compute a rate).
// totalMemoryMB/memoryPercent are for the whole machine (Node's os module
// reports the actual host, not just this process), so the dashboard can
// show RAM usage relative to what's actually available.
async function getServerStats(pid) {
  if (!pid || process.platform !== 'win32') {
    return null;
  }

  let sample;
  try {
    sample = await queryProcess(pid);
  } catch (err) {
    return null;
  }

  const now = Date.now();
  const memoryMB = Math.round(sample.memoryBytes / 1024 / 1024);
  const totalMemoryMB = Math.round(os.totalmem() / 1024 / 1024);
  const memoryPercent = totalMemoryMB > 0 ? Math.round((memoryMB / totalMemoryMB) * 1000) / 10 : null;

  let cpuPercent = null;
  if (lastSample && lastSample.pid === pid) {
    const cpuDelta = sample.cpuSeconds - lastSample.cpuSeconds;
    const wallDeltaSeconds = (now - lastSample.timestamp) / 1000;
    if (wallDeltaSeconds > 0) {
      const cores = os.cpus().length || 1;
      cpuPercent = Math.max(0, Math.min(100, (cpuDelta / wallDeltaSeconds) * 100 / cores));
    }
  }

  lastSample = { pid, cpuSeconds: sample.cpuSeconds, timestamp: now };

  return {
    cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent * 10) / 10,
    memoryMB,
    totalMemoryMB,
    memoryPercent
  };
}

function reset() {
  lastSample = null;
}

module.exports = { getServerStats, reset };
