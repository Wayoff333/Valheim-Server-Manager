const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const fs = require('fs');

// Windows launches everything in this folder automatically on user login —
// no admin rights needed, no Task Scheduler complexity.
function startupFolder() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function shortcutPath() {
  return path.join(startupFolder(), 'Valheim Server Manager.lnk');
}

function isEnabled() {
  return fs.existsSync(shortcutPath());
}

// Creates a .lnk shortcut pointing at start.bat, using PowerShell's
// WScript.Shell COM object (the standard, documented way to create
// shortcuts from a script on Windows — no extra dependencies needed).
function enable() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('Autostart is only available on Windows.'));
      return;
    }

    const startBat = path.join(__dirname, '..', 'start.bat');
    const workDir = path.join(__dirname, '..');
    const target = shortcutPath();

    const script = [
      '$WshShell = New-Object -ComObject WScript.Shell;',
      `$Shortcut = $WshShell.CreateShortcut('${target}');`,
      `$Shortcut.TargetPath = '${startBat}';`,
      `$Shortcut.WorkingDirectory = '${workDir}';`,
      '$Shortcut.WindowStyle = 7;', // minimized
      '$Shortcut.Description = "Valheim Server Manager";',
      '$Shortcut.Save();'
    ].join(' ');

    exec(`powershell -NoProfile -Command "${script}"`, { windowsHide: true, timeout: 10000 }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function disable() {
  const target = shortcutPath();
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
  }
}

module.exports = { isEnabled, enable, disable, shortcutPath };
