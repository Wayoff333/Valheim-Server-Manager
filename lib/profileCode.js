const AdmZip = require('adm-zip');
const yaml = require('js-yaml');

const PROFILE_DATA_PREFIX = '#r2modman\n';

// Accepts a bare code or a full share-code URL and returns the UUID-looking key.
function extractProfileKey(codeOrUrl) {
  const trimmed = codeOrUrl.trim();
  const match = trimmed.match(/[0-9a-fA-F-]{20,}/);
  return match ? match[0] : trimmed;
}

// Decodes the raw "#r2modman\n<base64>" response body (from either
// Thunderstore's or Hexium's identical legacyprofile API) into
// [{ namespace, name, fullName, version }].
function decodeProfileResponse(text) {
  if (!text.startsWith(PROFILE_DATA_PREFIX)) {
    throw new Error('Unexpected profile data format.');
  }
  const base64 = text.slice(PROFILE_DATA_PREFIX.length);
  const zipBuffer = Buffer.from(base64, 'base64');

  const zip = new AdmZip(zipBuffer);
  const r2xEntry = zip.getEntries().find(e => e.entryName.toLowerCase() === 'export.r2x');
  if (!r2xEntry) {
    throw new Error('Profile archive did not contain export.r2x.');
  }

  const doc = yaml.load(r2xEntry.getData().toString('utf-8'));
  const modList = (doc && doc.mods) || [];

  return modList
    .filter(m => m.enabled !== false)
    .map(m => {
      const [namespace, ...rest] = String(m.name).split('-');
      const name = rest.join('-');
      const version = m.version
        ? `${m.version.major}.${m.version.minor}.${m.version.patch}`
        : null;
      return { namespace, name, fullName: m.name, version };
    });
}

// Builds the "#r2modman\n<base64>" request body from our own installed-mod
// list — the inverse of decodeProfileResponse, used to export a shareable
// code for the current mod list.
function buildProfileRequestBody(modsList) {
  const doc = {
    mods: modsList.map(m => {
      const [major, minor, patch] = String(m.version).split('.').map(n => parseInt(n, 10) || 0);
      return {
        name: `${m.namespace}-${m.name}`,
        version: { major, minor, patch },
        enabled: true
      };
    })
  };

  const zip = new AdmZip();
  zip.addFile('export.r2x', Buffer.from(yaml.dump(doc), 'utf-8'));
  return PROFILE_DATA_PREFIX + zip.toBuffer().toString('base64');
}

module.exports = { extractProfileKey, decodeProfileResponse, buildProfileRequestBody, PROFILE_DATA_PREFIX };
