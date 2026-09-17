const { getBus } = require('./logBus');
const modInstaller = require('./modInstaller');
const { fetchWithTimeout } = require('./httpFetch');

const bus = getBus('mods');

// Hexium mirrors Thunderstore's experimental API 1:1 — same endpoint shapes,
// different domain. Confirmed from Gale's (the mod manager both platforms
// share) open-source client, which treats them as interchangeable
// "ThunderstoreBackend" instances differing only in base URL.
function createBackend({ source, apiBase, fallbackDownloadUrl }) {
  async function getPackageMeta(namespace, name) {
    const url = `${apiBase}/experimental/package/${namespace}/${name}/`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      throw new Error(`Could not look up ${namespace}-${name} on ${source} (HTTP ${res.status}).`);
    }
    return res.json();
  }

  // Some Thunderstore/Hexium author names contain hyphens themselves (e.g.
  // "LVH-IT"), which makes "split the combined namespace-name identifier on
  // its first hyphen" ambiguous — that heuristic (used when parsing profile
  // codes, since the identifier only gives you the combined string) breaks
  // for any such mod. When the naive split doesn't resolve, this tries
  // progressively wider namespace splits until one actually exists.
  async function resolveIdentity(fullName) {
    const parts = fullName.split('-');
    let lastErr;
    for (let i = 1; i < parts.length; i++) {
      const namespace = parts.slice(0, i).join('-');
      const name = parts.slice(i).join('-');
      try {
        await getPackageMeta(namespace, name);
        return { namespace, name };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`Could not resolve ${fullName} on ${source}.`);
  }

  async function getLatestVersion(namespace, name) {
    const meta = await getPackageMeta(namespace, name);
    if (!meta.latest || !meta.latest.version_number) {
      throw new Error(`${namespace}-${name} has no published versions on ${source}.`);
    }
    return meta.latest.version_number;
  }

  async function resolveDownloadUrl(namespace, name, version) {
    const url = `${apiBase}/experimental/package/${namespace}/${name}/${version}/`;
    const res = await fetchWithTimeout(url);
    if (res.ok) {
      const data = await res.json();
      if (data.download_url) return data.download_url;
    }
    if (fallbackDownloadUrl) {
      return fallbackDownloadUrl(namespace, name, version);
    }
    throw new Error(`No download URL found for ${namespace}-${name} v${version} on ${source}.`);
  }

  async function installMod({ namespace, name, version }, installPath) {
    try {
      if (!version) {
        version = await getLatestVersion(namespace, name);
      }
      const downloadUrl = await resolveDownloadUrl(namespace, name, version);
      return await modInstaller.installFromUrl({ source, namespace, name, version, downloadUrl }, installPath);
    } catch (err) {
      // The combined "namespace-name" identifier from a profile code is
      // ambiguous when the author's own name contains a hyphen — try wider
      // splits before giving up entirely.
      const fullName = `${namespace}-${name}`;
      const corrected = await resolveIdentity(fullName);
      const correctedVersion = version || await getLatestVersion(corrected.namespace, corrected.name);
      const downloadUrl = await resolveDownloadUrl(corrected.namespace, corrected.name, correctedVersion);
      return modInstaller.installFromUrl(
        { source, namespace: corrected.namespace, name: corrected.name, version: correctedVersion, downloadUrl },
        installPath
      );
    }
  }

  // Checks every tracked mod from this source against its latest published
  // version. Mods that fail to look up are reported with an `error` field
  // instead of throwing, so one bad mod doesn't block the rest of the scan.
  async function checkForUpdates(installPath) {
    const mods = modInstaller.listInstalledMods(installPath).filter(m => m.source === source);
    const results = [];
    for (const mod of mods) {
      let namespace = mod.namespace;
      let name = mod.name;
      try {
        let latestVersion;
        try {
          latestVersion = await getLatestVersion(namespace, name);
        } catch (firstErr) {
          // Naive split may have guessed wrong on a hyphenated author name
          // — try to self-correct before giving up.
          const fullName = `${namespace}-${name}`;
          const corrected = await resolveIdentity(fullName);
          namespace = corrected.namespace;
          name = corrected.name;
          latestVersion = await getLatestVersion(namespace, name);
          modInstaller.correctModIdentity(installPath, fullName, namespace, name);
          bus.push(`Corrected ${fullName}'s namespace/name split (was misparsed as ${mod.namespace}/${mod.name}).`);
        }
        const updateAvailable = modInstaller.isNewerVersion(mod.version, latestVersion);
        if (updateAvailable) {
          bus.push(`${namespace}-${name}: ${mod.version} → ${latestVersion} available (${source})`);
        }
        results.push({
          fullName: `${namespace}-${name}`,
          namespace,
          name,
          source,
          currentVersion: mod.version,
          latestVersion,
          updateAvailable
        });
      } catch (err) {
        bus.push(`Could not check ${namespace}-${name} on ${source}: ${err.message}`);
        results.push({
          fullName: `${namespace}-${name}`,
          namespace,
          name,
          source,
          currentVersion: mod.version,
          latestVersion: null,
          updateAvailable: false,
          error: err.message
        });
      }
    }
    return results;
  }

  async function updateMod(fullName, installPath) {
    const state = modInstaller.loadInstalledState(installPath);
    const entry = state[fullName];
    if (!entry) {
      throw new Error(`${fullName} is not tracked as installed.`);
    }
    try {
      return await installMod({ namespace: entry.namespace, name: entry.name, version: null }, installPath);
    } catch (err) {
      const corrected = await resolveIdentity(fullName);
      modInstaller.correctModIdentity(installPath, fullName, corrected.namespace, corrected.name);
      return installMod({ namespace: corrected.namespace, name: corrected.name, version: null }, installPath);
    }
  }

  // Fetches a shared r2modman/Thunderstore Mod Manager/Gale profile code
  // from this backend and returns the raw response text (caller decodes via
  // profileCode.decodeProfileResponse — same format regardless of backend).
  async function fetchProfileRaw(key) {
    const url = `${apiBase}/experimental/legacyprofile/get/${key}/`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      throw new Error(`Profile code not found on ${source} (HTTP ${res.status}).`);
    }
    return res.text();
  }

  // Uploads a profile (built via profileCode.buildProfileRequestBody) and
  // returns the resulting share code — the same mechanism Gale itself uses
  // for "export as code" (POST .../legacyprofile/create/, confirmed from
  // its source).
  async function createProfileCode(base64Body) {
    const url = `${apiBase}/experimental/legacyprofile/create/`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: base64Body
    });
    if (res.status === 413) {
      throw new Error('Profile is too large to export as a code — this is a Thunderstore/Hexium limit, not something this app controls.');
    }
    if (!res.ok) {
      throw new Error(`Export failed on ${source} (HTTP ${res.status}).`);
    }
    const data = await res.json();
    return data.key;
  }

  return {
    source,
    apiBase,
    getPackageMeta,
    getLatestVersion,
    resolveDownloadUrl,
    installMod,
    checkForUpdates,
    updateMod,
    fetchProfileRaw,
    createProfileCode
  };
}

module.exports = { createBackend };
