const zlib = require('zlib');
const { fetchWithTimeout } = require('./httpFetch');
const { getBus } = require('./logBus');

const bus = getBus('mods');

// Confirmed from Gale's (the mod manager both platforms share) open-source
// client: the real package catalog isn't the classic flat v1 API (which
// turned out to be what was causing search to hang/time out) — it's a
// gzip-compressed "index" of gzip-compressed chunk URLs, identical
// mechanism for both backends, just a different base URL.
const INDEX_URLS = {
  thunderstore: 'https://thunderstore.io/c/valheim/api/v1/package-listing-index/',
  hexium: 'https://valheim.hexium.gg/api/v1/package-listing-index/'
};

const CACHE_TTL_MS = 60 * 60 * 1000; // catalog doesn't change fast enough to need less
const OVERALL_FETCH_TIMEOUT_MS = 45000; // bounds the whole catalog fetch, not just one request
const CHUNK_CONCURRENCY = 5; // fetch chunks in small batches rather than all at once — a
// smaller/newer site's server can struggle under dozens of simultaneous requests, and that
// kind of overload tends to show up as everything hanging rather than a clean error.
const cache = {}; // { thunderstore: { data, fetchedAt }, hexium: { ... } }

async function fetchGzipJson(url, timeoutMs) {
  const res = await fetchWithTimeout(url, {}, timeoutMs);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const decompressed = zlib.gunzipSync(buf);
  return JSON.parse(decompressed.toString('utf-8'));
}

// Runs `fn` over `items` with at most `limit` in flight at once, instead of
// firing everything simultaneously via Promise.all.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function withOverallTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} took longer than ${ms / 1000}s overall — giving up.`)), ms))
  ]);
}

// Fetches the full catalog for one backend: the index (a list of chunk
// URLs), then every chunk (limited concurrency, so a large/slow catalog
// can't overwhelm the server or hang indefinitely), then flattens them.
// Bounded by an overall timeout so this can never truly "get stuck" — it
// either succeeds or fails within OVERALL_FETCH_TIMEOUT_MS.
async function ensureCache(source) {
  const entry = cache[source];
  if (entry && (Date.now() - entry.fetchedAt) < CACHE_TTL_MS) {
    return entry.data;
  }

  const indexUrl = INDEX_URLS[source];
  if (!indexUrl) {
    throw new Error(`Unknown mod source: ${source}`);
  }

  return withOverallTimeout((async () => {
    bus.push(`Fetching ${source} mod catalog...`);
    const chunkUrls = await fetchGzipJson(indexUrl, 15000);
    bus.push(`${source}: ${chunkUrls.length} catalog chunk(s) to fetch...`);

    let completed = 0;
    const chunks = await mapWithConcurrency(chunkUrls, CHUNK_CONCURRENCY, async (url) => {
      const chunk = await fetchGzipJson(url, 15000);
      completed++;
      if (completed % 10 === 0 || completed === chunkUrls.length) {
        bus.push(`${source}: fetched ${completed}/${chunkUrls.length} chunks...`);
      }
      return chunk;
    });

    const packages = chunks.flat();
    bus.push(`${source}: catalog ready (${packages.length} packages).`);
    cache[source] = { data: packages, fetchedAt: Date.now() };
    return packages;
  })(), OVERALL_FETCH_TIMEOUT_MS, `${source} catalog fetch`);
}

// The catalog only gives a combined "full_name" identifier (e.g.
// "RandyKnapp-EpicLoot"), not separate owner/name fields — deriving them
// here is just for display. Actual installs re-resolve this properly
// (including the hyphenated-namespace case, e.g. "LVH-IT-...") via
// tsCompatBackend's resolveIdentity, so an imperfect split here never
// causes a wrong install.
function splitFullName(fullName) {
  const [namespace, ...rest] = String(fullName).split('-');
  return { namespace, name: rest.join('-') };
}

// The version's own full_name is "{packageFullName}-{version}" — slicing
// off the known package prefix is more reliable than pattern-matching for
// a version number, since names can contain digits/dots too.
function extractVersion(pkg, latest) {
  if (!latest || !latest.full_name || !pkg.full_name) return null;
  const prefix = `${pkg.full_name}-`;
  return latest.full_name.startsWith(prefix) ? latest.full_name.slice(prefix.length) : null;
}

async function searchOneSource(source, words, limit) {
  const packages = await ensureCache(source);
  const scored = [];

  for (const pkg of packages) {
    if (pkg.is_deprecated) continue;
    const { namespace, name } = splitFullName(pkg.full_name);
    const nameLower = name.toLowerCase();
    const nameCompact = nameLower.replace(/[_\s-]/g, '');
    const queryCompact = words.join('');
    const latest = pkg.versions && pkg.versions[0];
    const descLower = (latest?.description || '').toLowerCase();

    const allWordsMatchSomewhere = words.every(w => nameLower.includes(w) || descLower.includes(w));
    if (!allWordsMatchSomewhere) continue;

    let score = 20;
    if (nameCompact === queryCompact) score = 100;
    else if (nameCompact.startsWith(queryCompact)) score = 80;
    else if (words.every(w => nameLower.includes(w))) score = 60;

    scored.push({
      score,
      source,
      namespace,
      name,
      fullName: pkg.full_name,
      description: latest?.description || '',
      version: extractVersion(pkg, latest),
      downloads: latest?.downloads ?? 0,
      packageUrl: pkg.package_url
    });
  }

  scored.sort((a, b) => b.score - a.score || b.downloads - a.downloads);
  return scored.slice(0, limit).map(({ score, ...rest }) => rest);
}

// Returns { results, warnings } for `query`. `source` is 'thunderstore',
// 'hexium', or omitted/'all' to search both and merge by rank. `warnings`
// surfaces a per-source failure instead of silently dropping it — a search
// that "only seems to search Thunderstore" usually means Hexium's fetch is
// failing quietly, which this makes visible instead of hidden.
async function search(query, limit = 20, source = 'all') {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { results: [], warnings: [] };

  if (source === 'thunderstore' || source === 'hexium') {
    try {
      return { results: await searchOneSource(source, words, limit), warnings: [] };
    } catch (err) {
      bus.push(`Mod search on ${source} failed: ${err.message}`);
      throw err;
    }
  }

  const [ts, hex] = await Promise.allSettled([
    searchOneSource('thunderstore', words, limit),
    searchOneSource('hexium', words, limit)
  ]);

  const warnings = [];
  if (ts.status === 'rejected') {
    warnings.push(`Thunderstore search failed: ${ts.reason.message}`);
    bus.push(`Mod search on thunderstore failed: ${ts.reason.message}`);
  }
  if (hex.status === 'rejected') {
    warnings.push(`Hexium search failed: ${hex.reason.message}`);
    bus.push(`Mod search on hexium failed: ${hex.reason.message}`);
  }

  const results = [
    ...(ts.status === 'fulfilled' ? ts.value : []),
    ...(hex.status === 'fulfilled' ? hex.value : [])
  ];

  if (ts.status === 'rejected' && hex.status === 'rejected') {
    throw new Error(`Could not search either source (Thunderstore: ${ts.reason.message}; Hexium: ${hex.reason.message}).`);
  }

  results.sort((a, b) => b.downloads - a.downloads);
  return { results: results.slice(0, limit), warnings };
}

module.exports = { search };
