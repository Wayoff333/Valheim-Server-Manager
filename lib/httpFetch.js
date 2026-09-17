// A hung or unresponsive host would otherwise make a bare fetch() wait
// forever — Node's fetch has no default timeout. That's what could make a
// mod import (or anything else that hits the network) look permanently
// "stuck" with no error and no way to recover short of restarting the
// manager. This wraps fetch so it fails with a clear error instead.
//
// Use a short timeout (the default) for quick API/JSON lookups, and pass a
// longer one explicitly for real file downloads (mod zips, SteamCMD).
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout };
