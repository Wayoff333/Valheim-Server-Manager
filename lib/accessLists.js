const fs = require('fs');
const path = require('path');
const { getEffectiveSaveDir } = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'access-lists.json');

const TYPES = ['admin', 'banned', 'permitted'];
const FILE_NAMES = {
  admin: 'adminlist.txt',
  banned: 'bannedlist.txt',
  permitted: 'permittedlist.txt'
};

function loadStore() {
  if (!fs.existsSync(STORE_FILE)) {
    return { admin: [], banned: [], permitted: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    return { admin: parsed.admin || [], banned: parsed.banned || [], permitted: parsed.permitted || [] };
  } catch (e) {
    return { admin: [], banned: [], permitted: [] };
  }
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function assertType(type) {
  if (!TYPES.includes(type)) {
    throw new Error(`Unknown list type: ${type}`);
  }
}

function getAll() {
  return loadStore();
}

function addEntry(type, steamId, name, config) {
  assertType(type);
  steamId = String(steamId).trim();
  if (!/^\d{17}$/.test(steamId)) {
    throw new Error('SteamID64 should be a 17-digit number (find it via steamid.io).');
  }
  const store = loadStore();
  if (!store[type].some(e => e.steamId === steamId)) {
    store[type].push({ steamId, name: (name || '').trim() });
    saveStore(store);
  }
  writeListFiles(config);
  return store[type];
}

function removeEntry(type, steamId, config) {
  assertType(type);
  const store = loadStore();
  store[type] = store[type].filter(e => e.steamId !== steamId);
  saveStore(store);
  writeListFiles(config);
  return store[type];
}

// Regenerates adminlist.txt / bannedlist.txt / permittedlist.txt in the
// server's effective save directory from our JSON source of truth. Safe to
// call any time (e.g. before every server start) since it's idempotent.
function writeListFiles(config) {
  const saveDir = getEffectiveSaveDir(config);
  fs.mkdirSync(saveDir, { recursive: true });

  const store = loadStore();
  for (const type of TYPES) {
    const filePath = path.join(saveDir, FILE_NAMES[type]);
    const lines = store[type].map(e => e.name ? `${e.steamId} // ${e.name}` : e.steamId);
    fs.writeFileSync(filePath, lines.join('\n') + (lines.length ? '\n' : ''));
  }
}

module.exports = { getAll, addEntry, removeEntry, writeListFiles };
