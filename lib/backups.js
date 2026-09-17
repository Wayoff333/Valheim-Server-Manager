const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { getEffectiveSaveDir } = require('./config');
const { getBus } = require('./logBus');

const bus = getBus('mods'); // reuse the mods/activity log channel for backup events

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

// Valheim 1.0 replaced the old <world>.db + <world>.fwl file pair with a
// folder named after the world (containing chunked data). Which format a
// given world is currently in depends on whether it's been opened since
// 1.0 launched, and Valheim's own automatic backup folders for the new
// format aren't documented anywhere yet — so rather than guess at that,
// this backs up whatever actually exists under worlds_local/ that starts
// with the world's name: the folder (1.0), the .db/.fwl pair (pre-1.0),
// or both if a conversion is in progress. Copying the whole match is the
// one rule every source agrees on regardless of which format applies.
function findWorldEntries(config) {
  const saveDir = getEffectiveSaveDir(config);
  const worldsDir = path.join(saveDir, 'worlds_local');
  if (!fs.existsSync(worldsDir)) {
    return { worldsDir, entries: [] };
  }
  const worldName = config.worldName;
  const entries = fs.readdirSync(worldsDir).filter(name => {
    // Exact folder match, or "<worldName>." prefix for the .db/.fwl/.old files —
    // avoids accidentally matching a different world that happens to share a prefix.
    return name === worldName || name.startsWith(`${worldName}.`);
  });
  return { worldsDir, entries };
}

// Lists every distinct world found in the save folder, regardless of which
// one is currently configured — for a "select world" dropdown. Handles
// both Valheim 1.0's folder-per-world format and the legacy .db/.fwl pair,
// deduplicating so a legacy pair (world.db + world.fwl) counts as one world.
function listAvailableWorlds(config) {
  const saveDir = getEffectiveSaveDir(config);
  const worldsDir = path.join(saveDir, 'worlds_local');
  if (!fs.existsSync(worldsDir)) {
    return { worldsDir, worlds: [] };
  }

  const names = new Set();
  for (const entry of fs.readdirSync(worldsDir)) {
    // Strip a trailing .db/.fwl/.db.old/.fwl.old to get the base world name;
    // a bare folder (1.0 format) has no extension to strip.
    const base = entry.replace(/\.(db|fwl)(\.old)?$/i, '');
    names.add(base);
  }

  return { worldsDir, worlds: Array.from(names).sort() };
}

function ensureBackupsDir() {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

function listBackups() {
  ensureBackupsDir();
  return fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.endsWith('.zip'))
    .map(f => {
      const full = path.join(BACKUPS_DIR, f);
      const stat = fs.statSync(full);
      return {
        fileName: f,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString()
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Creates a timestamped zip of the current world under our own backups
// folder (kept separate from Valheim's save directory on purpose, so it's
// never confused with or overwritten by Valheim's own backup behavior).
// `reason` is just a label included in the filename and log line.
function createBackup(config, reason = 'manual') {
  const { worldsDir, entries } = findWorldEntries(config);

  if (entries.length === 0) {
    throw new Error(`No world files found for "${config.worldName}" in ${worldsDir} — has the server been started at least once?`);
  }

  ensureBackupsDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeReason = reason.replace(/[^a-zA-Z0-9_-]/g, '');
  const fileName = `${config.worldName}_${safeReason}_${timestamp}.zip`;
  const zipPath = path.join(BACKUPS_DIR, fileName);

  const zip = new AdmZip();
  for (const entry of entries) {
    const fullPath = path.join(worldsDir, entry);
    if (fs.statSync(fullPath).isDirectory()) {
      zip.addLocalFolder(fullPath, entry);
    } else {
      zip.addLocalFile(fullPath);
    }
  }
  zip.writeZip(zipPath);

  const stat = fs.statSync(zipPath);
  bus.push(`Backup created: ${fileName} (${(stat.size / 1024 / 1024).toFixed(1)} MB, ${entries.length} item(s))`);

  return { fileName, sizeBytes: stat.size };
}

// Restores a backup by extracting it over the current world files. Caller
// is responsible for making sure the server is stopped first — restoring
// into a live world's files while the server has them open would corrupt
// things, not just fail cleanly.
function restoreBackup(fileName, config) {
  const zipPath = path.join(BACKUPS_DIR, fileName);
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Backup ${fileName} not found.`);
  }

  const { worldsDir } = findWorldEntries(config);
  fs.mkdirSync(worldsDir, { recursive: true });

  // Remove whatever's currently there for this world first, so a restore
  // from an older/differently-shaped backup doesn't leave stale chunk
  // files mixed in with the restored ones.
  const { entries: currentEntries } = findWorldEntries(config);
  for (const entry of currentEntries) {
    fs.rmSync(path.join(worldsDir, entry), { recursive: true, force: true });
  }

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(worldsDir, true);

  bus.push(`Restored backup: ${fileName}`);
}

function deleteBackup(fileName) {
  const zipPath = path.join(BACKUPS_DIR, fileName);
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Backup ${fileName} not found.`);
  }
  fs.unlinkSync(zipPath);
}

module.exports = { listBackups, createBackup, restoreBackup, deleteBackup, findWorldEntries, listAvailableWorlds };
