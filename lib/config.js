const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'config.json');

const DEFAULTS = {
  // Paths
  steamCmdPath: 'C:\\steamcmd\\steamcmd.exe',
  serverInstallPath: 'C:\\valheim_server',

  // Server identity
  serverName: 'My Valheim Server',
  worldName: 'Dedicated',
  password: 'changeme',

  // Networking
  port: 2456,
  public: true,
  crossplay: true,

  // Save / backup behavior (seconds)
  saveIntervalSeconds: 1800,
  backupCount: 4,
  backupShort: 7200,
  backupLong: 43200,

  // Mods
  bepinexInstalled: false,

  // Auto mod-update
  autoUpdateEnabled: false,
  autoUpdateIntervalHours: 24,
  autoBackupBeforeUpdate: true,

  // Crash detection / auto-restart
  autoRestartOnCrash: true,
  crashMaxAttempts: 3,
  crashWindowMinutes: 10,

  // Daily scheduled restart, with the same 20/10/5/1 warnings as any other
  // scheduled restart.
  dailyRestartEnabled: false,
  dailyRestartTime: '04:00', // 24h HH:mm, local time on the machine running the manager

  // Discord webhook (manager-level notifications: start/stop, mod updates)
  discordWebhookUrl: '',
  discordNotifyServerStatus: true,
  discordNotifyModUpdates: true,

  // Customizable message templates. {placeholders} get filled in — see
  // README for the full list available per message.
  discordMsgStarting: '🟢 **{serverName}** is starting up...',
  discordMsgStopped: '🔴 **{serverName}** has stopped.',
  discordMsgCrashed: '⚠️ **{serverName}** stopped unexpectedly (code={code}).',
  discordMsgRestartWarning: '⏰ **{serverName}** restarting in {minutes} minute(s).',
  discordMsgModsUpdated: '🔧 Auto-updated mods on **{serverName}**: {names}',
  discordMsgCrashGivingUp: '🛑 **{serverName}** crashed {count} times in {windowMinutes} minutes — auto-restart has stopped trying. Manual attention needed.',

  // Optional: resolve Steam persona names for the Players tab
  // (get a free key at https://steamcommunity.com/dev/apikey)
  steamApiKey: '',

  // The dashboard has no login by default. Defaults to localhost-only so
  // it's never reachable from your LAN or the internet even by accident.
  // Only flip this on if you understand the risk (see README) — and never
  // forward the dashboard's port on your router regardless of this setting.
  allowNetworkAccess: false,

  // Optional login — required if allowNetworkAccess is on (or any time you
  // want it, even locally). authPasswordHash/authPasswordSalt are never
  // sent back to the frontend — see server.js's GET /api/config handler.
  authEnabled: false,
  authUsername: '',
  authPasswordHash: '',
  authPasswordSalt: '',

  // Difficulty / world modifier preset (normal, casual, easy, hard,
  // hardcore, immersive, hammer). Empty/'normal' omits the flag entirely.
  preset: 'normal',

  // Individual world modifiers (-modifier flag). Empty string = leave at
  // whatever the preset/default gives; only non-empty values get passed.
  // Valid values per the Valheim dedicated server reference:
  //   combat: veryeasy, easy, hard, veryhard (default = unset)
  //   deathpenalty: casual, veryeasy, easy, hard, hardcore (default = unset)
  //   resources: most, muchmore, more, less, muchless (default = unset)
  //   raids: none, muchless, less, more, muchmore (default = unset)
  //   portals: casual, hard, veryhard (default = unset)
  modifierCombat: '',
  modifierDeathpenalty: '',
  modifierResources: '',
  modifierRaids: '',
  modifierPortals: '',

  // Checkbox world modifiers (-setkey flag).
  setKeyNoBuildCost: false,
  setKeyPlayerEvents: false,
  setKeyPassiveMobs: false,
  setKeyNoMap: false,

  // Optional overrides. Blank = let the server use its own defaults.
  saveDir: '',
  logFilePath: '',

  // Anything advanced the user wants appended verbatim
  extraLaunchArgs: ''
};

function ensureConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
  }
}

function loadConfig() {
  ensureConfigFile();
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = {};
  }
  return { ...DEFAULTS, ...parsed };
}

function saveConfig(partial) {
  const current = loadConfig();
  const updated = { ...current, ...partial };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2));
  return updated;
}

// Builds the argument array passed to valheim_server.exe
function buildLaunchArgs(config) {
  const args = [
    '-nographics',
    '-batchmode',
    '-name', config.serverName,
    '-port', String(config.port),
    '-world', config.worldName,
    '-password', config.password,
    '-public', config.public ? '1' : '0',
    '-saveinterval', String(config.saveIntervalSeconds),
    '-backups', String(config.backupCount),
    '-backupshort', String(config.backupShort),
    '-backuplong', String(config.backupLong)
  ];

  if (config.crossplay) {
    args.push('-crossplay');
  }

  if (config.preset && config.preset.trim() && config.preset.trim().toLowerCase() !== 'normal') {
    args.push('-preset', config.preset.trim());
  }

  // Individual modifiers go after -preset so they override it, per the
  // dedicated server's own documented behavior (presets overwrite anything
  // set before them on the line).
  const modifierMap = {
    combat: config.modifierCombat,
    deathpenalty: config.modifierDeathpenalty,
    resources: config.modifierResources,
    raids: config.modifierRaids,
    portals: config.modifierPortals
  };
  for (const [name, value] of Object.entries(modifierMap)) {
    if (value && value.trim()) {
      args.push('-modifier', name, value.trim());
    }
  }

  const setKeyMap = {
    nobuildcost: config.setKeyNoBuildCost,
    playerevents: config.setKeyPlayerEvents,
    passivemobs: config.setKeyPassiveMobs,
    nomap: config.setKeyNoMap
  };
  for (const [name, enabled] of Object.entries(setKeyMap)) {
    if (enabled) {
      args.push('-setkey', name);
    }
  }

  if (config.saveDir && config.saveDir.trim()) {
    args.push('-savedir', config.saveDir.trim());
  }

  if (config.logFilePath && config.logFilePath.trim()) {
    args.push('-logFile', config.logFilePath.trim());
  }

  if (config.extraLaunchArgs && config.extraLaunchArgs.trim().length > 0) {
    // Naive split respecting simple quoted segments
    const extra = config.extraLaunchArgs.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    args.push(...extra.map(a => a.replace(/^"|"$/g, '')));
  }

  return args;
}

// Where the server actually keeps its saves — and therefore where
// adminlist.txt / bannedlist.txt / permittedlist.txt need to live. If the
// user hasn't set a custom -savedir, Valheim uses its normal per-account
// location under LocalLow.
function getEffectiveSaveDir(config) {
  if (config.saveDir && config.saveDir.trim()) {
    return config.saveDir.trim();
  }
  return path.join(os.homedir(), 'AppData', 'LocalLow', 'IronGate', 'Valheim');
}

module.exports = { loadConfig, saveConfig, buildLaunchArgs, getEffectiveSaveDir, CONFIG_PATH, DEFAULTS };
