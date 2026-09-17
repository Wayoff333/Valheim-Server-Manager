const { getBus } = require('./logBus');
const { fetchWithTimeout } = require('./httpFetch');

const bus = getBus('server');

// Fills {placeholders} in a user-customizable message template. Unknown
// placeholders are left as literal empty strings rather than throwing, so a
// typo in a custom template degrades gracefully instead of breaking
// notifications entirely.
function render(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => (vars[key] !== undefined ? vars[key] : ''));
}

// Posts a plain message to a Discord webhook URL. Silently no-ops if no
// webhook is configured. Never throws — a Discord hiccup should never take
// down the manager or the game server.
async function notify(webhookUrl, content) {
  if (!webhookUrl) return;
  try {
    const res = await fetchWithTimeout(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (!res.ok) {
      bus.push(`Discord webhook returned HTTP ${res.status}`);
    }
  } catch (err) {
    bus.push(`Discord webhook failed: ${err.message}`);
  }
}

module.exports = { notify, render };
