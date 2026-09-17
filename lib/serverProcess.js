const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { spawn, exec } = require('child_process');
const { getBus } = require('./logBus');
const { buildLaunchArgs } = require('./config');
const discord = require('./discordNotifier');
const accessLists = require('./accessLists');

const bus = getBus('server');
const events = new EventEmitter();

let child = null;
let startedAt = null;
// Set right before we intentionally kill the process (Stop or Restart), so
// the exit handler can tell an intentional stop apart from a real crash.
let stopRequested = false;

// How long to wait for a graceful shutdown (real world save) to finish
// before giving up and force-killing. A large world's save can genuinely
// take a while, so this is generous on purpose — the alternative is
// silently losing progress.
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 60000;

function status() {
  return {
    running: !!child,
    pid: child ? child.pid : null,
    startedAt: startedAt
  };
}

function getPid() {
  return child ? child.pid : null;
}

function start(config) {
  if (child) {
    throw new Error('Server is already running.');
  }

  const exePath = path.join(config.serverInstallPath, 'valheim_server.exe');
  if (!fs.existsSync(exePath)) {
    throw new Error(`valheim_server.exe not found at ${exePath}. Install/update the server first.`);
  }

  const args = buildLaunchArgs(config);
  bus.push(`Starting: ${exePath} ${args.join(' ')}`);

  // Make sure adminlist.txt / bannedlist.txt / permittedlist.txt in the save
  // directory reflect whatever was last set in the Access tab before the
  // server reads them at startup.
  try {
    accessLists.writeListFiles(config);
  } catch (err) {
    bus.push(`Warning: could not write access list files: ${err.message}`);
  }

  stopRequested = false;

  child = spawn(exePath, args, {
    cwd: config.serverInstallPath,
    // Deliberately NOT windowsHide: true. Stopping this server gracefully
    // (so it actually saves — see stop() below) requires attaching to its
    // console to deliver a real CTRL+C signal, which needs a console to
    // exist. You'll see a console window for the server itself; that's
    // expected and is also what runs if you launch Valheim's own
    // start_headless_server.bat directly.
    //
    // detached: true is what actually gives it that OWN console, per
    // Node's own documented Windows behavior. Without this, the child
    // inherits the manager's own console instead of getting a separate
    // one — so a CTRL+C aimed at "the server's console" was actually
    // landing on the manager's own cmd.exe window too, producing the
    // "Terminate batch job (Y/N)?" prompt and stalling the shutdown
    // until it eventually got force-killed by the timeout (meaning the
    // graceful save wasn't actually happening).
    detached: process.platform === 'win32',
    env: { ...process.env, SteamAppId: '892970' } // lets the server binary find its Steam context
  });
  startedAt = new Date().toISOString();

  if (config.discordNotifyServerStatus) {
    discord.notify(config.discordWebhookUrl, discord.render(config.discordMsgStarting, { serverName: config.serverName }));
  }

  child.stdout.on('data', (data) => {
    String(data).split(/\r?\n/).filter(Boolean).forEach(l => bus.push(l));
  });
  child.stderr.on('data', (data) => {
    String(data).split(/\r?\n/).filter(Boolean).forEach(l => bus.push(`[stderr] ${l}`));
  });

  child.on('exit', (code, signal) => {
    const crashed = !stopRequested;
    bus.push(`Server process exited (code=${code}, signal=${signal})${crashed ? ' — unexpected' : ''}`);
    child = null;
    startedAt = null;

    if (config.discordNotifyServerStatus) {
      const template = crashed ? config.discordMsgCrashed : config.discordMsgStopped;
      discord.notify(config.discordWebhookUrl, discord.render(template, { serverName: config.serverName, code, signal }));
    }

    stopRequested = false;
    events.emit('exit', { crashed, code, signal });
  });

  child.on('error', (err) => {
    bus.push(`Failed to start server: ${err.message}`);
    child = null;
    startedAt = null;
    const crashed = !stopRequested;
    stopRequested = false;
    events.emit('exit', { crashed, code: null, signal: null, error: err.message });
  });

  events.emit('start');
  return status();
}

// Delivers a genuine CTRL_C_EVENT to the target process's console — the
// only signal that actually makes Valheim flush the world (and any
// in-progress player/character data) to disk before exiting. taskkill,
// with or without /F, does NOT deliver this: without /F it sends WM_CLOSE
// (which a headless console app generally ignores), and with /F it's an
// unconditional TerminateProcess with zero chance for the app to clean up
// — confirmed by multiple other Valheim server tools' own bug history
// (e.g. WindowsGSM's Valheim plugin shipped exactly this bug and had to
// patch it in). This uses the standard AttachConsole + GenerateConsoleCtrlEvent
// technique via PowerShell, since Node has no direct way to do this on Windows.
//
// Note: the PowerShell helper process itself also receives the CTRL+C
// (it's attached to the same console it just joined), so it exiting
// abnormally is expected and not itself a sign of failure — what actually
// matters is whether the *target* process goes on to exit afterward.
function sendCtrlC(pid) {
  return new Promise((resolve) => {
    const script = [
      'Add-Type -Name Win32CtrlC -Namespace Kill -MemberDefinition \'',
      '[DllImport(\\"kernel32.dll\\", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId);',
      '[DllImport(\\"kernel32.dll\\", SetLastError=true)] public static extern bool FreeConsole();',
      '[DllImport(\\"kernel32.dll\\", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr HandlerRoutine, bool Add);',
      '[DllImport(\\"kernel32.dll\\", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);',
      '\';',
      '[Kill.Win32CtrlC]::FreeConsole() | Out-Null;',
      `if (-not [Kill.Win32CtrlC]::AttachConsole(${pid})) { exit 1 };`,
      '[Kill.Win32CtrlC]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null;',
      '[Kill.Win32CtrlC]::GenerateConsoleCtrlEvent(0, 0) | Out-Null;',
      'Start-Sleep -Milliseconds 300;',
      '[Kill.Win32CtrlC]::FreeConsole() | Out-Null;'
    ].join(' ');

    exec(`powershell -NoProfile -Command "${script}"`, { windowsHide: true, timeout: 10000 }, () => {
      // Resolve regardless of this helper's own exit code/status — see the
      // note above about why that's expected and not meaningful here.
      resolve();
    });
  });
}

function forceKill(pid) {
  exec(`taskkill /PID ${pid} /T /F`, (err) => {
    if (err) bus.push(`taskkill error: ${err.message}`);
  });
}

// Stop = ask Valheim to save and exit on its own, and only force-kill if it
// doesn't within GRACEFUL_SHUTDOWN_TIMEOUT_MS. This is what actually fixes
// world/character data not being saved on stop or restart.
function stop() {
  if (!child) {
    throw new Error('Server is not running.');
  }
  const pid = child.pid;
  bus.push(`Stopping server (pid ${pid}) — requesting a save before shutdown (this can take a little while on a large world)...`);
  stopRequested = true;

  const forceTimer = setTimeout(() => {
    bus.push(`Server hasn't exited within ${GRACEFUL_SHUTDOWN_TIMEOUT_MS / 1000}s of the shutdown signal — force-stopping. Recent progress may not have saved.`);
    forceKill(pid);
  }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);

  events.once('exit', () => clearTimeout(forceTimer));

  if (process.platform === 'win32') {
    sendCtrlC(pid);
  } else {
    // Non-Windows dev/testing fallback — real SIGTERM/SIGINT work fine here.
    child.kill('SIGINT');
  }

  return { stopping: true, pid };
}

function restart(config) {
  if (child) {
    events.once('exit', () => setTimeout(() => start(config), 1000));
    stop();
    return { restarting: true };
  }
  return start(config);
}

module.exports = { start, stop, restart, status, getPid, events };
