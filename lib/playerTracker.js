const fs = require('fs');
const path = require('path');
const { getBus } = require('./logBus');
const serverProcess = require('./serverProcess');
const { fetchWithTimeout } = require('./httpFetch');

const serverBus = getBus('server');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'players.json');
const MAX_HISTORY = 500;

// online: Map<clientId, { clientId, name, connectedAt }>
const online = new Map();

const steamNameCache = new Map(); // steamId -> personaname

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

function appendHistory(entry) {
  const history = loadHistory();
  history.push(entry);
  saveHistory(history);
}

// --- Log line parsing ------------------------------------------------------
// Current (1.0.12+) dedicated server console format — confirmed against a
// real server's log, since the format changed from older pre-1.0 samples
// this was originally built against (that older format used numeric
// "Got connection SteamID X" lines, which no longer appear at all — this
// silently broke online tracking entirely until caught):
//   "MM/DD/YYYY HH:MM:SS: Got handshake from client playfab/<id>"
//   "MM/DD/YYYY HH:MM:SS: Got character ZDOID from <name> : <ownerId>:<n>"
//   "MM/DD/YYYY HH:MM:SS: Closing socket <id>"  (assumed still current —
//   not yet confirmed against a real disconnect line; the periodic
//   reconciliation below acts as a safety net if this one is also stale)
// The client identifier is now an opaque string (e.g. "playfab/AB12..." for
// crossplay clients), not necessarily a numeric SteamID, so it's tracked
// generically as clientId rather than assuming a particular format.
// The character-name line doesn't repeat the client id, so it's matched to
// the most recently connected player who doesn't have a name yet — a
// heuristic that works well for players joining one at a time, but could
// mismatch if several unnamed joins land in the same instant.

const RE_CONNECT = /Got handshake from client (\S+)/;
const RE_CHARACTER = /Got character ZDOID from (.+?) :/;
const RE_DISCONNECT = /Closing socket (\S+)/;
// Confirmed from a real disconnect: "Closing socket" doesn't actually
// appear at all in the current format. What does show up is a line naming
// the live player count directly — more reliable than trying to match a
// specific departing player, and it's what actually fixes single-player
// disconnects not being detected (the connect-side fix alone wasn't
// enough, since disconnects were never being registered either).
const RE_CONNECTION_LOST = /Player connection lost.*now (\d+) player/;
// The server also periodically logs its own actual connection count — a
// second, independent reconciliation signal, useful if a drop happens
// silently enough that even the above doesn't fire (e.g. a hard crash).
const RE_CONNECTION_COUNT = /Connections (\d+) ZDOS:/;

function clearAllOnline(reason) {
  if (online.size === 0) return;
  serverBus.push(`Player tracker: ${reason} — clearing ${online.size} stale "online" entr${online.size === 1 ? 'y' : 'ies'}.`);
  for (const entry of online.values()) {
    appendHistory({
      event: 'leave',
      clientId: entry.clientId,
      name: entry.name || null,
      at: new Date().toISOString(),
      reason: 'reconciled — silent disconnect'
    });
  }
  online.clear();
}

function handleLine(line) {
  let m;

  if ((m = line.match(RE_CONNECTION_LOST))) {
    const actualCount = parseInt(m[1], 10);
    if (actualCount === 0) {
      clearAllOnline('game reports 0 players after a disconnect');
    }
    return;
  }

  if ((m = line.match(RE_CONNECTION_COUNT))) {
    const actualCount = parseInt(m[1], 10);
    if (actualCount === 0) {
      clearAllOnline('game reports 0 connections');
    }
    return;
  }

  if ((m = line.match(RE_CONNECT))) {
    const clientId = m[1];
    if (!online.has(clientId)) {
      online.set(clientId, { clientId, name: null, connectedAt: new Date().toISOString() });
    }
    return;
  }

  if ((m = line.match(RE_CHARACTER))) {
    const name = m[1].trim();
    // Assign to the most recently connected entry that's still unnamed.
    let target = null;
    for (const entry of online.values()) {
      if (!entry.name && (!target || entry.connectedAt > target.connectedAt)) {
        target = entry;
      }
    }
    if (target) {
      target.name = name;
      appendHistory({ event: 'join', clientId: target.clientId, name, at: new Date().toISOString() });
    } else {
      // No pending unnamed connection matched this — most likely because
      // RE_CONNECT didn't fire for this session (e.g. yet another log
      // format change). Register them directly so they still show as
      // online even though we missed the handshake line.
      const fallbackId = `character:${name}`;
      online.set(fallbackId, { clientId: fallbackId, name, connectedAt: new Date().toISOString() });
      appendHistory({ event: 'join', clientId: fallbackId, name, at: new Date().toISOString() });
    }
    return;
  }

  if ((m = line.match(RE_DISCONNECT))) {
    const clientId = m[1];
    const entry = online.get(clientId);
    if (entry) {
      online.delete(clientId);
      appendHistory({
        event: 'leave',
        clientId,
        name: entry.name || null,
        at: new Date().toISOString()
      });
    }
    return;
  }
}

serverBus.on('line', (entry) => handleLine(entry.line));

// If the server process dies, everyone still marked "online" is stale — log
// them as left so the roster doesn't lie after a crash/restart.
serverProcess.events.on('exit', () => {
  for (const entry of online.values()) {
    appendHistory({
      event: 'leave',
      clientId: entry.clientId,
      name: entry.name || null,
      at: new Date().toISOString(),
      reason: 'server stopped'
    });
  }
  online.clear();
});

// --- Optional Steam persona name resolution --------------------------------
// Only meaningful for numeric SteamID64 clients — PlayFab-identified
// crossplay clients don't have a SteamID to resolve at all, so this is
// skipped for those (they already have a character name by the time it'd
// matter anyway, in the common case).

async function resolveSteamName(steamId, apiKey) {
  if (!apiKey) return null;
  if (steamNameCache.has(steamId)) return steamNameCache.get(steamId);
  try {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${steamId}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    const persona = data?.response?.players?.[0]?.personaname || null;
    if (persona) steamNameCache.set(steamId, persona);
    return persona;
  } catch (e) {
    return null;
  }
}

async function getOnline(steamApiKey) {
  const list = Array.from(online.values());
  if (steamApiKey) {
    for (const entry of list) {
      if (!entry.name && /^\d{17}$/.test(entry.clientId)) {
        entry.steamName = await resolveSteamName(entry.clientId, steamApiKey);
      }
    }
  }
  return list;
}

function getHistory(limit = 100) {
  return loadHistory().slice(-limit).reverse();
}

module.exports = { getOnline, getHistory };
