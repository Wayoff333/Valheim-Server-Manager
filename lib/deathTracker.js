const fs = require('fs');
const path = require('path');
const { getBus } = require('./logBus');

const serverBus = getBus('server');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'deaths.json');
const MAX_HISTORY = 500;

// Vanilla Valheim's dedicated server console never logs player deaths — this
// is a hard limitation of the base game, not something parseable around.
// These patterns only catch mods that print a death line for their own
// debugging (many do, but it's not guaranteed). For reliable, named death
// events, install the DiscordConnector mod instead (see lib/thunderstore.js
// DISCORDCONNECTOR_* constants) and point it at a Discord webhook.
const DEATH_PATTERNS = [
  /^\[?[\w.: -]*\]?\s*Player ([A-Za-z0-9_ '-]{1,24}) died\b/i,
  /^\[?[\w.: -]*\]?\s*([A-Za-z0-9_ '-]{1,24}) (?:has )?died\b/i,
  /^\[?[\w.: -]*\]?\s*([A-Za-z0-9_ '-]{1,24}) was slain\b/i
];

let filePollState = { path: null, offset: 0 };

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function saveHistory(history) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-MAX_HISTORY), null, 2));
}

function recordDeath(name, raw) {
  const history = loadHistory();
  history.push({ name, raw, at: new Date().toISOString() });
  saveHistory(history);
  serverBus.push(`💀 Death detected: ${name}`);
}

function scanLine(line) {
  for (const re of DEATH_PATTERNS) {
    const m = line.match(re);
    if (m) {
      recordDeath(m[1].trim(), line.trim());
      return;
    }
  }
}

serverBus.on('line', (entry) => scanLine(entry.line));

// Polls BepInEx/LogOutput.log for new lines since many mods log there
// instead of (or in addition to) the main process stdout.
function pollLogFile(installPath) {
  const logPath = path.join(installPath, 'BepInEx', 'LogOutput.log');
  if (!fs.existsSync(logPath)) return;

  const stat = fs.statSync(logPath);

  if (filePollState.path !== logPath || stat.size < filePollState.offset) {
    // New file (server (re)started, or a different install path) — start
    // from the current end so we don't replay an entire old session.
    filePollState = { path: logPath, offset: stat.size };
    return;
  }

  if (stat.size === filePollState.offset) return; // nothing new

  const stream = fs.createReadStream(logPath, { start: filePollState.offset, end: stat.size });
  let buf = '';
  stream.on('data', (chunk) => { buf += chunk; });
  stream.on('end', () => {
    filePollState.offset = stat.size;
    buf.split(/\r?\n/).filter(Boolean).forEach(scanLine);
  });
}

function getHistory(limit = 100) {
  return loadHistory().slice(-limit).reverse();
}

module.exports = { getHistory, pollLogFile };
