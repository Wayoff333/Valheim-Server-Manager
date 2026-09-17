const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { getBus } = require('./logBus');
const { fetchWithTimeout } = require('./httpFetch');

const bus = getBus('mods');

const BEPINEX_NAME = 'BepInExPack_Valheim';

// Files that live at the root of every Thunderstore/Hexium package zip and
// are metadata rather than mod content. Both platforms use the same package
// format, so the same extraction rules apply to mods from either source.
const METADATA_FILES = new Set(['manifest.json', 'icon.png', 'readme.md', 'changelog.md']);

function pluginsDir(installPath) {
  return path.join(installPath, 'BepInEx', 'plugins');
}

function modsStateFile(installPath) {
  return path.join(installPath, 'BepInEx', '_manager_installed.json');
}

function loadInstalledState(installPath) {
  const f = modsStateFile(installPath);
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function saveInstalledState(installPath, state) {
  const f = modsStateFile(installPath);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(state, null, 2));
}

function copyRecursiveSync(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function removeRecursiveSync(target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

// Downloads and installs a single package zip, regardless of which site it
// came from. Handles the BepInEx core pack specially (it must land at the
// server root), mods that ship their own BepInEx/ tree (config, patchers,
// plugins), and the common case of a plain plugin dropped into
// BepInEx/plugins/<namespace>-<name>/.
async function installFromUrl({ source, namespace, name, version, downloadUrl }, installPath) {
  const fullName = `${namespace}-${name}`;
  bus.push(`Installing ${fullName} v${version} (${source})...`);

  const res = await fetchWithTimeout(downloadUrl, {}, 60000);
  if (!res.ok) {
    throw new Error(`Download failed for ${fullName} (HTTP ${res.status}).`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-install-'));
  try {
    const zip = new AdmZip(buf);
    zip.extractAllTo(tmpDir, true);

    const isBepInExCore = name === BEPINEX_NAME || name.toLowerCase().startsWith('bepinexpack');

    if (isBepInExCore) {
      // The zip contains one top-level folder (e.g. BepInExPack_Valheim/) whose
      // *contents* need to sit directly in the server install directory.
      const topLevel = fs.readdirSync(tmpDir).filter(f =>
        fs.statSync(path.join(tmpDir, f)).isDirectory()
      );
      const sourceRoot = topLevel.length === 1 ? path.join(tmpDir, topLevel[0]) : tmpDir;
      for (const entry of fs.readdirSync(sourceRoot)) {
        copyRecursiveSync(path.join(sourceRoot, entry), path.join(installPath, entry));
      }
      bus.push(`${fullName} installed to server root (BepInEx core).`);
    } else if (fs.existsSync(path.join(tmpDir, 'BepInEx'))) {
      // Mod ships a full BepInEx/ tree (plugins/patchers/config) — merge it in.
      copyRecursiveSync(path.join(tmpDir, 'BepInEx'), path.join(installPath, 'BepInEx'));
      bus.push(`${fullName} installed (structured BepInEx package).`);
    } else {
      // Plain plugin: everything except metadata files goes into its own
      // folder under BepInEx/plugins/.
      const destDir = path.join(pluginsDir(installPath), fullName);
      removeRecursiveSync(destDir);
      fs.mkdirSync(destDir, { recursive: true });
      for (const entry of fs.readdirSync(tmpDir)) {
        if (METADATA_FILES.has(entry.toLowerCase())) continue;
        copyRecursiveSync(path.join(tmpDir, entry), path.join(destDir, entry));
      }
      bus.push(`${fullName} installed to BepInEx/plugins/${fullName}/`);
    }
  } finally {
    removeRecursiveSync(tmpDir);
  }

  const state = loadInstalledState(installPath);
  state[fullName] = { namespace, name, version, source, installedAt: new Date().toISOString() };
  saveInstalledState(installPath, state);

  return { fullName, version };
}

function listInstalledMods(installPath) {
  const state = loadInstalledState(installPath);
  // Mods installed before multi-source support get a default so old state
  // files keep working without a migration step.
  return Object.values(state)
    .map(m => ({ source: 'thunderstore', ...m }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function removeMod(fullName, installPath, bepinexFullName) {
  const state = loadInstalledState(installPath);
  if (!state[fullName]) {
    throw new Error(`${fullName} is not tracked as installed.`);
  }
  if (fullName === bepinexFullName) {
    throw new Error('Uninstall the BepInEx core pack manually — removing it here would not be safe to automate.');
  }
  removeRecursiveSync(path.join(pluginsDir(installPath), fullName));
  delete state[fullName];
  saveInstalledState(installPath, state);
}

// Fixes a mod's stored namespace/name split without changing its state-file
// key (the key is already the correct combined identifier regardless of
// where it was originally split — only the separate fields can be wrong).
// Used when a hyphenated author name caused the initial parse to guess the
// wrong split; self-heals so future checks don't need to retry every time.
function correctModIdentity(installPath, fullName, namespace, name) {
  const state = loadInstalledState(installPath);
  if (!state[fullName]) return;
  state[fullName].namespace = namespace;
  state[fullName].name = name;
  saveInstalledState(installPath, state);
}

// Compares two "major.minor.patch[-suffix]" strings. Returns true if
// `latest` is newer than `current`.
function isNewerVersion(current, latest) {
  const strip = v => String(v).split('-')[0];
  const c = strip(current).split('.').map(Number);
  const l = strip(latest).split('.').map(Number);
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const cv = c[i] || 0;
    const lv = l[i] || 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

module.exports = {
  installFromUrl,
  listInstalledMods,
  removeMod,
  correctModIdentity,
  isNewerVersion,
  loadInstalledState,
  saveInstalledState,
  pluginsDir,
  BEPINEX_NAME
};
