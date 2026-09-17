const { getBus } = require('./logBus');
const { fetchWithTimeout } = require('./httpFetch');
const { createBackend } = require('./tsCompatBackend');
const { extractProfileKey, decodeProfileResponse } = require('./profileCode');

const bus = getBus('mods');

// Confirmed from Gale's (the mod manager both Thunderstore and Hexium use)
// open-source client: Hexium runs the same experimental API as Thunderstore,
// just at hexium.gg instead of thunderstore.io, and its download CDN follows
// a deterministic owner/name/version pattern rather than needing an API
// round-trip. See backend.rs in github.com/Kesomannen/gale for the source
// this was verified against.
const backend = createBackend({
  source: 'hexium',
  apiBase: 'https://hexium.gg/api',
  fallbackDownloadUrl: (namespace, name, version) =>
    `https://cdn.hexium.gg/uploads/${namespace}/${name}/${version}.zip`
});

const HEXIUM_MOD_PAGE_BASE = 'https://valheim.hexium.gg';
const DOWNLOAD_LINK_RE = /(https:\/\/cdn\.hexium\.gg\/upload[s]?\/[^\s"'<>)]+?\/([^\s"'<>)/]+?)\.zip)/i;

// Fallback for the rare case the API lookup doesn't resolve (e.g. a mod not
// yet indexed): scrape the public mod page, which lists a direct download
// link regardless of API state. Returns both the version AND the download
// URL together, since the scraped link may not match the deterministic CDN
// pattern the API path assumes — mixing "scraped version + API-derived URL"
// caused a real bug here (verified by testing before shipping).
async function scrapeLatestDownload(namespace, name) {
  const url = `${HEXIUM_MOD_PAGE_BASE}/mods/${namespace}/${name}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`Could not find ${namespace}/${name} on Hexium (HTTP ${res.status}). Check the author/mod name.`);
  }
  const html = await res.text();
  const match = html.match(DOWNLOAD_LINK_RE);
  if (!match) {
    throw new Error(`Could not determine the latest version of ${namespace}/${name} on Hexium.`);
  }
  return { version: match[2], downloadUrl: match[1] };
}

async function getLatestVersion(namespace, name) {
  try {
    return await backend.getLatestVersion(namespace, name);
  } catch (err) {
    const scraped = await scrapeLatestDownload(namespace, name);
    return scraped.version;
  }
}

// Tries the real API end-to-end first (version lookup + download
// resolution together); only if that whole path fails does it fall back to
// scraping, also end-to-end, so the version and download URL always come
// from the same source and can't mismatch.
//
// Caveat: the scrape fallback always gets the mod page's current latest
// version — if a caller requested a specific older `version` and the API
// path fails, this installs latest instead of that pinned version. Hexium's
// mod page only surfaces a download link for the current release, so
// there's no way to scrape a specific historical version.
async function installMod({ namespace, name, version }, installPath) {
  const modInstaller = require('./modInstaller');
  try {
    if (!version) {
      version = await backend.getLatestVersion(namespace, name);
    }
    return await backend.installMod({ namespace, name, version }, installPath);
  } catch (err) {
    bus.push(`Hexium API path failed for ${namespace}-${name} (${err.message}), trying its mod page instead...`);
    const scraped = await scrapeLatestDownload(namespace, name);
    return modInstaller.installFromUrl(
      { source: 'hexium', namespace, name, version: scraped.version, downloadUrl: scraped.downloadUrl },
      installPath
    );
  }
}

async function updateMod(fullName, installPath) {
  const modInstaller = require('./modInstaller');
  const state = modInstaller.loadInstalledState(installPath);
  const entry = state[fullName];
  if (!entry) {
    throw new Error(`${fullName} is not tracked as installed.`);
  }
  return installMod({ namespace: entry.namespace, name: entry.name }, installPath);
}

// Checks every Hexium-sourced tracked mod, using the API first and falling
// back to the mod page per-mod if needed (same resilience as installMod).
async function checkForUpdates(installPath) {
  const modInstaller = require('./modInstaller');
  const mods = modInstaller.listInstalledMods(installPath).filter(m => m.source === 'hexium');
  const results = [];
  for (const mod of mods) {
    try {
      const latestVersion = await getLatestVersion(mod.namespace, mod.name);
      const updateAvailable = modInstaller.isNewerVersion(mod.version, latestVersion);
      if (updateAvailable) {
        bus.push(`${mod.namespace}-${mod.name}: ${mod.version} → ${latestVersion} available (Hexium)`);
      }
      results.push({
        fullName: `${mod.namespace}-${mod.name}`,
        namespace: mod.namespace,
        name: mod.name,
        source: 'hexium',
        currentVersion: mod.version,
        latestVersion,
        updateAvailable
      });
    } catch (err) {
      bus.push(`Could not check ${mod.namespace}-${mod.name} on Hexium: ${err.message}`);
      results.push({
        fullName: `${mod.namespace}-${mod.name}`,
        namespace: mod.namespace,
        name: mod.name,
        source: 'hexium',
        currentVersion: mod.version,
        latestVersion: null,
        updateAvailable: false,
        error: err.message
      });
    }
  }
  return results;
}

async function fetchProfileModList(codeOrUrl) {
  const key = extractProfileKey(codeOrUrl);
  bus.push(`Fetching profile ${key} from Hexium...`);
  const text = await backend.fetchProfileRaw(key);
  return decodeProfileResponse(text);
}

module.exports = {
  backend,
  getLatestVersion,
  installMod,
  updateMod,
  checkForUpdates,
  fetchProfileModList
};
