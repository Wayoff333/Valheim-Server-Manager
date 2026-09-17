const modInstaller = require('./modInstaller');
const thunderstore = require('./thunderstore');
const hexium = require('./hexium');
const profileCode = require('./profileCode');
const { getBus } = require('./logBus');

const bus = getBus('mods');

function listInstalledMods(installPath) {
  return modInstaller.listInstalledMods(installPath);
}

function removeMod(fullName, installPath) {
  return modInstaller.removeMod(fullName, installPath, thunderstore.BEPINEX_FULL_NAME);
}

// Removes every tracked mod except the BepInEx core pack (never
// auto-removed — see modInstaller.removeMod). Useful for isolating a
// broken/outdated mod: strip everything, confirm the server starts clean,
// then reinstall in batches.
function removeAllMods(installPath) {
  const allMods = listInstalledMods(installPath);
  const results = [];
  for (const mod of allMods) {
    const fullName = `${mod.namespace}-${mod.name}`;
    if (fullName === thunderstore.BEPINEX_FULL_NAME) continue;
    try {
      removeMod(fullName, installPath);
      results.push({ fullName, ok: true });
    } catch (err) {
      results.push({ fullName, ok: false, error: err.message });
    }
  }
  return results;
}

// Checks every tracked mod for updates, routing each to whichever source it
// was installed from.
async function checkForUpdates(installPath) {
  const [tsResults, hexResults] = await Promise.all([
    thunderstore.checkForUpdates(installPath),
    hexium.checkForUpdates(installPath)
  ]);
  return [...tsResults, ...hexResults];
}

async function updateMod(fullName, installPath) {
  const state = modInstaller.loadInstalledState(installPath);
  const entry = state[fullName];
  if (!entry) {
    throw new Error(`${fullName} is not tracked as installed.`);
  }
  return entry.source === 'hexium'
    ? hexium.updateMod(fullName, installPath)
    : thunderstore.updateMod(fullName, installPath);
}

async function updateAllMods(installPath) {
  const checked = await checkForUpdates(installPath);
  const results = [];
  for (const mod of checked.filter(m => m.updateAvailable)) {
    try {
      const r = await updateMod(mod.fullName, installPath);
      results.push({ ...r, ok: true });
    } catch (err) {
      bus.push(`Failed to update ${mod.fullName}: ${err.message}`);
      results.push({ fullName: mod.fullName, ok: false, error: err.message });
    }
  }
  return results;
}

async function installHexiumMod(namespace, name, installPath) {
  return hexium.installMod({ namespace, name }, installPath);
}

// --- Unified profile-code import (Thunderstore + Hexium + Gale) -----------
//
// Gale can export a profile code to either backend depending on where the
// mods in it came from, and the resulting code looks the same either way —
// there's no way to tell from the code itself which backend has it. Gale's
// own client handles this by requesting the code from both backends at
// once and using whichever responds successfully; if a profile mixes mods
// from both platforms, it also falls back per-mod to the other backend if
// one doesn't have it. This mirrors that exact strategy.

let importRunning = false;

function isImportRunning() {
  return importRunning;
}

async function fetchProfileFromEitherBackend(codeOrUrl) {
  // Promise.any resolves as soon as either backend succeeds, without
  // waiting for the other — important because a slow/unresponsive host
  // could otherwise stall the whole import even when the other backend
  // already has the answer. Only throws if BOTH fail.
  try {
    return await Promise.any([
      thunderstore.fetchProfileModList(codeOrUrl),
      hexium.fetchProfileModList(codeOrUrl)
    ]);
  } catch (err) {
    throw new Error('Profile code not found on Thunderstore or Hexium — it may be expired or invalid.');
  }
}

// Cheaply checks (no file writes, just a version lookup) which backend
// actually has a mod, racing both so a slow/unresponsive one never blocks
// the fast one from winning. This is what actually fixes the "sits for a
// long time on a big Hexium-heavy modpack" problem — the old version tried
// Thunderstore fully (up to its full timeout) before even starting the
// Hexium attempt, for every single mod.
async function resolveModBackend(mod) {
  const attempts = [
    thunderstore.backend.getLatestVersion(mod.namespace, mod.name).then(() => 'thunderstore'),
    hexium.backend.getLatestVersion(mod.namespace, mod.name).then(() => 'hexium')
  ];
  try {
    return await Promise.any(attempts);
  } catch (err) {
    return null; // not found on either — let the real install attempt below produce the real error
  }
}

async function installModTryingBothBackends(mod, installPath) {
  bus.push(`Resolving ${mod.fullName}...`);
  const winner = await resolveModBackend(mod);

  if (winner === 'hexium') {
    const r = await hexium.installMod(mod, installPath);
    bus.push(`${mod.fullName} found on Hexium.`);
    return r;
  }

  // Either Thunderstore won the race, or neither did (fall through to the
  // normal sequential attempt so the error message is accurate either way).
  try {
    return await thunderstore.installMod(mod, installPath);
  } catch (tsErr) {
    try {
      const r = await hexium.installMod(mod, installPath);
      bus.push(`${mod.fullName} found on Hexium.`);
      return r;
    } catch (hexErr) {
      throw new Error(`Not found on Thunderstore (${tsErr.message}) or Hexium (${hexErr.message}).`);
    }
  }
}

async function importProfile(codeOrUrl, installPath) {
  if (importRunning) {
    throw new Error('An import is already in progress.');
  }
  importRunning = true;
  try {
    const modsList = await fetchProfileFromEitherBackend(codeOrUrl);
    modsList.sort((a, b) => {
      const aCore = a.name.toLowerCase().startsWith('bepinexpack') ? 0 : 1;
      const bCore = b.name.toLowerCase().startsWith('bepinexpack') ? 0 : 1;
      return aCore - bCore;
    });

    const results = [];
    for (const mod of modsList) {
      try {
        const r = await installModTryingBothBackends(mod, installPath);
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

// Exports every installed mod as a shareable profile code — the inverse of
// importProfile. Picks Thunderstore or Hexium the same way Gale itself
// does: Hexium only if the profile actually contains a Hexium-sourced mod,
// otherwise Thunderstore (so a normal profile stays maximally compatible
// with plain Thunderstore Mod Manager / r2modman too).
// Exports every installed mod as a shareable profile code. `preferredBackend`
// ('thunderstore' | 'hexium' | undefined) lets the caller force which
// platform to upload to; left unset, it picks the same way Gale itself
// does: Hexium only if the profile actually contains a Hexium-sourced mod,
// otherwise Thunderstore (maximally compatible with plain Thunderstore Mod
// Manager / r2modman too). Forcing Hexium works even for an all-Thunderstore
// modlist — useful if your friends' Gale is pointed at Hexium and you want
// the code to land there regardless.
async function exportProfileCode(installPath, preferredBackend) {
  const installedMods = modInstaller.listInstalledMods(installPath);
  if (installedMods.length === 0) {
    throw new Error('No mods installed to export.');
  }

  const body = profileCode.buildProfileRequestBody(installedMods);

  let backend;
  if (preferredBackend === 'hexium') {
    backend = hexium.backend;
  } else if (preferredBackend === 'thunderstore') {
    backend = thunderstore.backend;
  } else {
    const usesHexium = installedMods.some(m => m.source === 'hexium');
    backend = usesHexium ? hexium.backend : thunderstore.backend;
  }

  const key = await backend.createProfileCode(body);
  bus.push(`Exported ${installedMods.length} mod(s) as a profile code (${backend.source}): ${key}`);
  return { code: key, backend: backend.source, modCount: installedMods.length };
}

module.exports = {
  listInstalledMods,
  removeMod,
  removeAllMods,
  checkForUpdates,
  updateMod,
  updateAllMods,
  installHexiumMod,
  importProfile,
  exportProfileCode,
  isImportRunning
};
