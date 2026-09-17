const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { getBus } = require('./logBus');
const { fetchWithTimeout } = require('./httpFetch');

const VALHEIM_DEDICATED_SERVER_APPID = '896660';
const STEAMCMD_WINDOWS_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';

const bus = getBus('install');

let installRunning = false;

function isInstallRunning() {
  return installRunning;
}

// Downloads and unzips steamcmd.exe into the given directory if it isn't there yet.
async function ensureSteamCmd(steamCmdPath) {
  if (fs.existsSync(steamCmdPath)) {
    bus.push(`steamcmd already present at ${steamCmdPath}`);
    return;
  }

  const dir = path.dirname(steamCmdPath);
  fs.mkdirSync(dir, { recursive: true });

  bus.push('Downloading SteamCMD...');
  const res = await fetchWithTimeout(STEAMCMD_WINDOWS_URL, {}, 120000);
  if (!res.ok) {
    throw new Error(`Failed to download steamcmd.zip (HTTP ${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const zipPath = path.join(dir, 'steamcmd.zip');
  fs.writeFileSync(zipPath, buf);

  bus.push('Extracting SteamCMD...');
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(dir, true);
  fs.unlinkSync(zipPath);

  if (!fs.existsSync(steamCmdPath)) {
    throw new Error('steamcmd.exe not found after extraction — check steamCmdPath in settings.');
  }
  bus.push('SteamCMD ready.');
}

// Runs `steamcmd +force_install_dir <installPath> +login anonymous +app_update 896660 validate +quit`
// Streams output to the 'install' log bus. Resolves when steamcmd exits.
function installOrUpdateServer(steamCmdPath, installPath) {
  return new Promise((resolve, reject) => {
    if (installRunning) {
      reject(new Error('An install/update is already in progress.'));
      return;
    }
    installRunning = true;

    fs.mkdirSync(installPath, { recursive: true });

    const args = [
      '+force_install_dir', installPath,
      '+login', 'anonymous',
      '+app_update', VALHEIM_DEDICATED_SERVER_APPID, 'validate',
      '+quit'
    ];

    bus.push(`Launching: ${steamCmdPath} ${args.join(' ')}`);
    const child = spawn(steamCmdPath, args, { windowsHide: true });

    child.stdout.on('data', (data) => {
      String(data).split(/\r?\n/).filter(Boolean).forEach(l => bus.push(l));
    });
    child.stderr.on('data', (data) => {
      String(data).split(/\r?\n/).filter(Boolean).forEach(l => bus.push(`[stderr] ${l}`));
    });

    child.on('error', (err) => {
      installRunning = false;
      bus.push(`Failed to start steamcmd: ${err.message}`);
      reject(err);
    });

    child.on('exit', (code) => {
      installRunning = false;
      bus.push(`steamcmd exited with code ${code}`);

      // SteamCMD is well known to return a non-zero exit code even after a
      // genuinely successful install/update — this isn't rare or exotic,
      // it's a long-standing quirk seen across many games and platforms.
      // Trusting the exit code alone produces false failures right after a
      // log that clearly shows "Update complete, launching ...". The
      // reliable check is whether the game binary actually landed on disk.
      const exePath = path.join(installPath, 'valheim_server.exe');
      if (fs.existsSync(exePath)) {
        if (code !== 0) {
          bus.push(`Note: steamcmd's exit code (${code}) suggested failure, but valheim_server.exe is present — treating this as a successful update.`);
        }
        resolve();
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`steamcmd exited with code ${code} and valheim_server.exe was not found — this looks like a real failure.`));
      }
    });
  });
}

module.exports = {
  ensureSteamCmd,
  installOrUpdateServer,
  isInstallRunning,
  VALHEIM_DEDICATED_SERVER_APPID
};
