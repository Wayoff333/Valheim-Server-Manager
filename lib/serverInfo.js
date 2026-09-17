const { getBus } = require('./logBus');
const serverProcess = require('./serverProcess');

const serverBus = getBus('server');

let state = { publicIp: null, joinCode: null, joinCodeAt: null };

// Vanilla log (public IP, always printed):
//   "Found IPv6 address! Using 76.112.64.81."      <- yes, mislabeled, it's IPv4
//   "Found ipv address to be 76.112.64.81"
// Crossplay-only log (PlayFab join code, printed once the session is live):
//   "Session "My Server" registered with join code 123456"
//   "Session "My Server" with join code 123456 and IP 76.112.64.81:2456 is active..."
const RE_IP_FOUND = /Found (?:IPv6 address! Using|ipv address to be) (\d{1,3}(?:\.\d{1,3}){3})/i;
const RE_JOIN_CODE_WITH_IP = /with join code (\d{6}) and IP (\d{1,3}(?:\.\d{1,3}){3}):(\d+)/i;
const RE_JOIN_CODE = /registered with join code (\d{6})/i;

function handleLine(line) {
  let m;

  if ((m = line.match(RE_JOIN_CODE_WITH_IP))) {
    state.joinCode = m[1];
    state.publicIp = m[2];
    state.joinCodeAt = new Date().toISOString();
    return;
  }

  if ((m = line.match(RE_JOIN_CODE))) {
    state.joinCode = m[1];
    state.joinCodeAt = new Date().toISOString();
    return;
  }

  if ((m = line.match(RE_IP_FOUND))) {
    state.publicIp = m[1];
    return;
  }
}

serverBus.on('line', (entry) => handleLine(entry.line));

// A join code is only valid for the session that issued it — clear it (and
// the IP, since it can change too) whenever the server stops, so the
// dashboard never shows a stale/dead code as if it still worked.
serverProcess.events.on('exit', () => {
  state = { publicIp: null, joinCode: null, joinCodeAt: null };
});

function getInfo() {
  return { ...state };
}

module.exports = { getInfo };
