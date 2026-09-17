const { getBus } = require('./logBus');
const { createBackend } = require('./tsCompatBackend');
const { extractProfileKey, decodeProfileResponse } = require('./profileCode');

const bus = getBus('mods');

const BEPINEX_NAMESPACE = 'denikson';
const BEPINEX_NAME = 'BepInExPack_Valheim';
const BEPINEX_FULL_NAME = `${BEPINEX_NAMESPACE}-${BEPINEX_NAME}`;
const DISCORDCONNECTOR_NAMESPACE = 'nwesterhausen';
const DISCORDCONNECTOR_NAME = 'DiscordConnector';

const backend = createBackend({
  source: 'thunderstore',
  apiBase: 'https://thunderstore.io/api',
  fallbackDownloadUrl: (namespace, name, version) =>
    `https://thunderstore.io/package/download/${namespace}/${name}/${version}/`
});

async function fetchProfileModList(codeOrUrl) {
  const key = extractProfileKey(codeOrUrl);
  bus.push(`Fetching profile ${key} from Thunderstore...`);
  const text = await backend.fetchProfileRaw(key);
  return decodeProfileResponse(text);
}

let importRunning = false;

function isImportRunning() {
  return importRunning;
}

// Imports an entire shared profile code: fetches the mod list, then installs
// every mod in order (BepInEx core first if present in the list).
async function importProfile(codeOrUrl, installPath) {
  if (importRunning) {
    throw new Error('An import is already in progress.');
  }
  importRunning = true;
  try {
    const mods = await fetchProfileModList(codeOrUrl);
    mods.sort((a, b) => {
      const aCore = a.name.toLowerCase().startsWith('bepinexpack') ? 0 : 1;
      const bCore = b.name.toLowerCase().startsWith('bepinexpack') ? 0 : 1;
      return aCore - bCore;
    });

    const results = [];
    for (const mod of mods) {
      try {
        const r = await backend.installMod(mod, installPath);
        results.push({ ...r, ok: true });
      } catch (err) {
        bus.push(`Failed to install ${mod.fullName}: ${err.message}`);
        results.push({ fullName: mod.fullName, ok: false, error: err.message });
      }
    }
    bus.push(`Import complete: ${results.filter(r => r.ok).length} of ${results.length} mod(s) installed.`);
    return results;
  } finally {
    importRunning = false;
  }
}

async function installBepInEx(installPath) {
  const version = await backend.getLatestVersion(BEPINEX_NAMESPACE, BEPINEX_NAME);
  return backend.installMod({ namespace: BEPINEX_NAMESPACE, name: BEPINEX_NAME, version }, installPath);
}

// DiscordConnector hooks the game directly, so unlike our own log-scraping
// death/player tracking, it can reliably report joins/leaves/deaths/shouts
// to a Discord webhook. Make sure BepInEx is installed first.
async function installDiscordConnector(installPath) {
  const version = await backend.getLatestVersion(DISCORDCONNECTOR_NAMESPACE, DISCORDCONNECTOR_NAME);
  return backend.installMod(
    { namespace: DISCORDCONNECTOR_NAMESPACE, name: DISCORDCONNECTOR_NAME, version },
    installPath
  );
}

module.exports = {
  backend,
  fetchProfileModList,
  importProfile,
  installMod: backend.installMod,
  installBepInEx,
  installDiscordConnector,
  checkForUpdates: backend.checkForUpdates,
  updateMod: backend.updateMod,
  isImportRunning,
  BEPINEX_FULL_NAME
};
