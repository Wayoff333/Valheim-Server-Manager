// ---- Tabs -------------------------------------------------------------

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---- Helpers ------------------------------------------------------------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Batches incoming log lines into one DOM write per animation frame instead
// of one per line — a burst of hundreds of lines (which the game server can
// genuinely produce, e.g. a repeating exception) was appending to the page
// one at a time and forcing a reflow/rescroll each time, which is what was
// locking up the tab after Start.
//
// Optionally takes a filterElementId: when given, only lines containing the
// filter text (case-insensitive) are shown, without discarding the rest of
// the buffer — clearing the filter brings everything back.
function streamLog(channel, elementId, maxLines = 500, filterElementId = null) {
  const el = document.getElementById(elementId);
  const filterEl = filterElementId ? document.getElementById(filterElementId) : null;
  let buffer = [];
  let pending = [];
  let scheduled = false;

  function render() {
    const term = filterEl ? filterEl.value.trim().toLowerCase() : '';
    const lines = term ? buffer.filter(l => l.toLowerCase().includes(term)) : buffer;
    el.textContent = lines.join('\n') + (lines.length ? '\n' : '');
    el.scrollTop = el.scrollHeight;
  }

  function flush() {
    scheduled = false;
    if (pending.length === 0) return;
    buffer.push(...pending);
    pending = [];
    if (buffer.length > maxLines) {
      buffer = buffer.slice(-maxLines);
    }
    render();
  }

  function schedule() {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(flush);
    }
  }

  if (filterEl) {
    filterEl.addEventListener('input', render);
  }

  const es = new EventSource(`/api/logs/${channel}/stream`);
  es.onmessage = (e) => {
    const entry = JSON.parse(e.data);
    pending.push(entry.line);
    schedule();
  };
  return es;
}

streamLog('server', 'logServer', 500, 'serverLogFilter');
streamLog('install', 'logInstall');
streamLog('mods', 'logMods');

// ---- Server status / controls -------------------------------------------

function statBarLevel(percent) {
  if (percent === null) return 'ok';
  if (percent >= 85) return 'danger';
  if (percent >= 60) return 'warn';
  return 'ok';
}

function renderStats(stats) {
  const statsEl = document.getElementById('serverStats');
  if (!stats) {
    statsEl.innerHTML = '';
    return;
  }

  const cpuPercent = stats.cpuPercent;
  const cpuLevel = statBarLevel(cpuPercent);
  const cpuWidth = cpuPercent === null ? 0 : Math.min(100, cpuPercent);
  const cpuLabel = cpuPercent === null ? '…' : `${cpuPercent}%`;

  const memPercent = stats.memoryPercent;
  const memLevel = statBarLevel(memPercent);
  const memWidth = memPercent === null ? 0 : Math.min(100, memPercent);
  const memLabel = memPercent === null
    ? `${stats.memoryMB} MB`
    : `${(stats.memoryMB / 1024).toFixed(1)} / ${(stats.totalMemoryMB / 1024).toFixed(1)} GB`;

  statsEl.innerHTML = `
    <div class="stat-bars">
      <div class="stat-row">
        <span class="stat-label">CPU</span>
        <div class="stat-track"><div class="stat-fill ${cpuLevel}" style="width:${cpuWidth}%"></div></div>
        <span class="stat-value">${cpuLabel}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">RAM</span>
        <div class="stat-track"><div class="stat-fill ${memLevel}" style="width:${memWidth}%"></div></div>
        <span class="stat-value">${memLabel}</span>
      </div>
    </div>
  `;
}

async function refreshStatus() {
  const pill = document.getElementById('statusPill');
  const meta = document.getElementById('serverMeta');
  try {
    const s = await api('GET', '/api/server/status');
    if (s.running) {
      pill.textContent = `Running (PID ${s.pid})`;
      pill.className = 'pill pill-running';
      meta.textContent = `Started ${new Date(s.startedAt).toLocaleString()}`;

      try {
        const stats = await api('GET', '/api/server/stats');
        renderStats(stats);
      } catch (e) {
        renderStats(null);
      }
    } else {
      pill.textContent = 'Stopped';
      pill.className = 'pill pill-stopped';
      meta.textContent = 'Server is not running.';
      renderStats(null);
    }
  } catch (e) {
    pill.textContent = 'Unknown';
  }
}
refreshStatus();
setInterval(refreshStatus, 4000);

// ---- Share info (IP:port, password, crossplay join code) ------------------

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch (e) {
    alert(`Copy failed — here's the value:\n${text}`);
  }
}

async function refreshShareInfo() {
  const el = document.getElementById('shareInfo');
  try {
    const info = await api('GET', '/api/server/connect-info');
    const status = await api('GET', '/api/server/status');

    if (!status.running) {
      el.innerHTML = '<p class="meta">Start the server to get connection details.</p>';
      return;
    }
    if (!info.address) {
      el.innerHTML = '<p class="meta">Detecting address... (usually ready within a few seconds of starting)</p>';
      return;
    }

    let html = `
      <div class="share-row">
        <span><strong>Address:</strong> <span class="mono">${info.address}</span></span>
        <button class="btn share-copy" data-value="${info.address}">Copy</button>
      </div>
      <div class="share-row">
        <span><strong>Password:</strong> <span class="mono">${info.password}</span></span>
        <button class="btn share-copy" data-value="${info.password}">Copy</button>
      </div>
    `;

    if (info.crossplayEnabled) {
      html += info.joinCode
        ? `
          <div class="share-row">
            <span><strong>Join code</strong> (Xbox/PS/Switch): <span class="mono">${info.joinCode}</span></span>
            <button class="btn share-copy" data-value="${info.joinCode}">Copy</button>
          </div>
          <p class="meta">Join codes reset on every restart — reshare after restarting.</p>
        `
        : '<p class="meta">Crossplay is on — waiting for a join code (appears shortly after startup).</p>';
    }

    el.innerHTML = html;
    el.querySelectorAll('.share-copy').forEach(btn => {
      btn.addEventListener('click', () => copyToClipboard(btn.dataset.value, btn));
    });
  } catch (e) {
    el.innerHTML = `<p class="meta">Error: ${e.message}</p>`;
  }
}
refreshShareInfo();
setInterval(refreshShareInfo, 5000);

document.getElementById('btnStart').addEventListener('click', async () => {
  try { await api('POST', '/api/server/start'); refreshStatus(); }
  catch (e) { alert(e.message); }
});
document.getElementById('btnStop').addEventListener('click', async () => {
  try { await api('POST', '/api/server/stop'); refreshStatus(); }
  catch (e) { alert(e.message); }
});
document.getElementById('btnRestart').addEventListener('click', async () => {
  try { await api('POST', '/api/server/restart'); refreshStatus(); }
  catch (e) { alert(e.message); }
});

// ---- Install / update -----------------------------------------------------

document.getElementById('btnInstall').addEventListener('click', async () => {
  const btn = document.getElementById('btnInstall');
  btn.disabled = true;
  document.getElementById('logInstall').textContent = '';
  try {
    await api('POST', '/api/install');
  } catch (e) {
    alert(e.message);
  } finally {
    setTimeout(() => { btn.disabled = false; }, 2000);
  }
});

// ---- Settings ---------------------------------------------------------

const cfgFields = {
  cfgSteamCmdPath: 'steamCmdPath',
  cfgServerInstallPath: 'serverInstallPath',
  cfgServerName: 'serverName',
  cfgWorldName: 'worldName',
  cfgPassword: 'password',
  cfgPort: 'port',
  cfgPublic: 'public',
  cfgCrossplay: 'crossplay',
  cfgSaveInterval: 'saveIntervalSeconds',
  cfgBackupCount: 'backupCount',
  cfgBackupShort: 'backupShort',
  cfgBackupLong: 'backupLong',
  cfgExtraArgs: 'extraLaunchArgs',
  cfgAutoUpdateEnabled: 'autoUpdateEnabled',
  cfgAutoUpdateIntervalHours: 'autoUpdateIntervalHours',
  cfgDiscordWebhookUrl: 'discordWebhookUrl',
  cfgDiscordNotifyServerStatus: 'discordNotifyServerStatus',
  cfgDiscordNotifyModUpdates: 'discordNotifyModUpdates',
  cfgSteamApiKey: 'steamApiKey',
  cfgAutoBackupBeforeUpdate: 'autoBackupBeforeUpdate',
  cfgAutoRestartOnCrash: 'autoRestartOnCrash',
  cfgCrashMaxAttempts: 'crashMaxAttempts',
  cfgCrashWindowMinutes: 'crashWindowMinutes',
  cfgDailyRestartEnabled: 'dailyRestartEnabled',
  cfgDailyRestartTime: 'dailyRestartTime',
  cfgDiscordMsgStarting: 'discordMsgStarting',
  cfgDiscordMsgStopped: 'discordMsgStopped',
  cfgDiscordMsgCrashed: 'discordMsgCrashed',
  cfgDiscordMsgRestartWarning: 'discordMsgRestartWarning',
  cfgDiscordMsgModsUpdated: 'discordMsgModsUpdated',
  cfgDiscordMsgCrashGivingUp: 'discordMsgCrashGivingUp',
  cfgPreset: 'preset',
  cfgModifierCombat: 'modifierCombat',
  cfgModifierDeathpenalty: 'modifierDeathpenalty',
  cfgModifierResources: 'modifierResources',
  cfgModifierRaids: 'modifierRaids',
  cfgModifierPortals: 'modifierPortals',
  cfgSetKeyNoBuildCost: 'setKeyNoBuildCost',
  cfgSetKeyPlayerEvents: 'setKeyPlayerEvents',
  cfgSetKeyPassiveMobs: 'setKeyPassiveMobs',
  cfgSetKeyNoMap: 'setKeyNoMap',
  cfgSaveDir: 'saveDir',
  cfgLogFilePath: 'logFilePath',
  cfgAllowNetworkAccess: 'allowNetworkAccess'
};

async function loadConfigIntoForm() {
  const config = await api('GET', '/api/config');
  for (const [elId, key] of Object.entries(cfgFields)) {
    const el = document.getElementById(elId);
    if (el.type === 'checkbox') el.checked = !!config[key];
    else el.value = config[key];
  }
}
loadConfigIntoForm();

async function saveAllSettings() {
  const payload = {};
  for (const [elId, key] of Object.entries(cfgFields)) {
    const el = document.getElementById(elId);
    payload[key] = el.type === 'checkbox' ? el.checked
      : el.type === 'number' ? Number(el.value)
      : el.value;
  }
  const status = document.getElementById('saveStatus');
  try {
    await api('POST', '/api/config', payload);
    status.textContent = 'Saved.';
    setTimeout(() => { status.textContent = ''; }, 2000);
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
  }
}

// Settings are split across a few cards for readability, but they all save
// together — every "Save settings" button writes the whole form.
['btnSaveConfig', 'btnSaveConfig2', 'btnSaveConfig3'].forEach(id => {
  const btn = document.getElementById(id);
  if (btn) btn.addEventListener('click', saveAllSettings);
});

// ---- Mods ---------------------------------------------------------------

let currentMods = [];
let updateInfo = {}; // fullName -> { latestVersion, updateAvailable, error }

async function refreshModList() {
  try {
    currentMods = await api('GET', '/api/mods');
  } catch (e) {
    document.getElementById('modList').innerHTML = `<li class="meta">Error loading mods: ${e.message}</li>`;
    return;
  }
  renderModList();
}

function renderModList() {
  const list = document.getElementById('modList');
  list.innerHTML = '';

  if (currentMods.length === 0) {
    list.innerHTML = '<li class="meta">No mods installed yet.</li>';
    return;
  }

  for (const mod of currentMods) {
    const fullName = `${mod.namespace}-${mod.name}`;
    const info = updateInfo[fullName];
    const li = document.createElement('li');

    const badge = info && info.updateAvailable
      ? `<span class="badge badge-ok">Update → v${info.latestVersion}</span>`
      : info && info.error
        ? `<span class="badge badge-danger">Check failed</span>`
        : '';

    const updateBtn = info && info.updateAvailable
      ? `<button class="btn-update" data-name="${fullName}">Update</button>`
      : '';

    const sourceBadge = mod.source === 'hexium'
      ? `<span class="badge badge-accent">Hexium</span>`
      : `<span class="badge badge-neutral">Thunderstore</span>`;

    li.innerHTML = `
      <span>${mod.name} <span class="mod-version">v${mod.version} · ${mod.namespace}</span> ${sourceBadge} ${badge}</span>
      <span class="mod-actions">
        ${updateBtn}
        <button class="btn-remove" data-name="${fullName}">Remove</button>
      </span>
    `;

    li.querySelector('.btn-remove').addEventListener('click', async () => {
      try {
        await api('DELETE', `/api/mods/${encodeURIComponent(fullName)}`);
        delete updateInfo[fullName];
        refreshModList();
      } catch (e) { alert(e.message); }
    });

    const updateEl = li.querySelector('.btn-update');
    if (updateEl) {
      updateEl.addEventListener('click', async () => {
        updateEl.disabled = true;
        updateEl.textContent = 'Updating...';
        try {
          await api('POST', `/api/mods/${encodeURIComponent(fullName)}/update`);
          delete updateInfo[fullName];
          refreshModList();
        } catch (e) {
          alert(e.message);
          updateEl.disabled = false;
          updateEl.textContent = 'Update';
        }
      });
    }

    list.appendChild(li);
  }
}
refreshModList();

document.getElementById('btnCheckUpdates').addEventListener('click', async () => {
  const btn = document.getElementById('btnCheckUpdates');
  btn.disabled = true;
  btn.textContent = 'Checking...';
  try {
    await refreshModList(); // make sure the list reflects everything actually installed first
    const results = await api('GET', '/api/mods/updates');
    updateInfo = {};
    let anyUpdatable = false;
    for (const r of results) {
      updateInfo[r.fullName] = r;
      if (r.updateAvailable) anyUpdatable = true;
    }
    document.getElementById('btnUpdateAll').style.display = anyUpdatable ? '' : 'none';
    renderModList();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Check for updates';
  }
});

document.getElementById('btnUpdateAll').addEventListener('click', async () => {
  const btn = document.getElementById('btnUpdateAll');
  btn.disabled = true;
  btn.textContent = 'Updating...';
  try {
    await api('POST', '/api/mods/update-all');
    setTimeout(async () => {
      await refreshModList();
      updateInfo = {};
      btn.style.display = 'none';
      btn.disabled = false;
      btn.textContent = 'Update all';
    }, 4000);
  } catch (e) {
    alert(e.message);
    btn.disabled = false;
    btn.textContent = 'Update all';
  }
});

document.getElementById('btnRemoveAll').addEventListener('click', async () => {
  if (!confirm('Remove ALL installed mods? BepInEx itself is kept, but every other mod will be deleted. This cannot be undone from here.')) {
    return;
  }
  const btn = document.getElementById('btnRemoveAll');
  btn.disabled = true;
  btn.textContent = 'Removing...';
  try {
    await api('POST', '/api/mods/remove-all');
    updateInfo = {};
    document.getElementById('btnUpdateAll').style.display = 'none';
    await refreshModList();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Remove all';
  }
});

document.getElementById('btnImport').addEventListener('click', async () => {
  const code = document.getElementById('profileCode').value.trim();
  if (!code) return alert('Paste a profile code first.');
  const btn = document.getElementById('btnImport');
  document.getElementById('logMods').textContent = '';
  btn.disabled = true;
  btn.textContent = 'Importing...';
  try {
    await api('POST', '/api/mods/import', { code });
    // Importing a full profile can mean dozens of sequential downloads —
    // poll until the server says it's actually done rather than guessing
    // with a fixed delay.
    while (true) {
      await new Promise(r => setTimeout(r, 2000));
      const { running } = await api('GET', '/api/mods/import/status');
      if (!running) break;
    }
    await refreshModList();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import';
  }
});

document.getElementById('btnBepinex').addEventListener('click', async () => {
  document.getElementById('logMods').textContent = '';
  try {
    await api('POST', '/api/mods/bepinex');
    refreshModList();
  } catch (e) {
    alert(e.message);
  }
});

document.getElementById('btnToggleDiscordTemplates').addEventListener('click', () => {
  const section = document.getElementById('discordTemplatesSection');
  const btn = document.getElementById('btnToggleDiscordTemplates');
  const showing = section.style.display !== 'none';
  section.style.display = showing ? 'none' : '';
  btn.textContent = showing ? 'Customize message text' : 'Hide message text';
});

document.getElementById('btnExportProfile').addEventListener('click', async () => {
  const btn = document.getElementById('btnExportProfile');
  const resultEl = document.getElementById('exportResult');
  btn.disabled = true;
  btn.textContent = 'Exporting...';
  try {
    const backend = document.getElementById('exportBackendChoice').value || undefined;
    const result = await api('POST', '/api/mods/export', { backend });
    resultEl.innerHTML = `
      <div class="share-row">
        <span><strong>Code</strong> (${result.backend}, ${result.modCount} mods): <span class="mono">${result.code}</span></span>
        <button class="btn share-copy" data-value="${result.code}">Copy</button>
      </div>
    `;
    resultEl.querySelector('.share-copy').addEventListener('click', (e) => copyToClipboard(result.code, e.target));
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Export current mods as code';
  }
});

document.getElementById('btnInstallHexium').addEventListener('click', async () => {
  const namespace = document.getElementById('hexiumNamespace').value.trim();
  const name = document.getElementById('hexiumName').value.trim();
  if (!namespace || !name) return alert('Enter both the author and mod name.');
  const btn = document.getElementById('btnInstallHexium');
  btn.disabled = true;
  btn.textContent = 'Installing...';
  document.getElementById('logMods').textContent = '';
  try {
    await api('POST', '/api/mods/hexium', { namespace, name });
    document.getElementById('hexiumNamespace').value = '';
    document.getElementById('hexiumName').value = '';
    refreshModList();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Install';
  }
});

document.getElementById('btnDiscordConnector').addEventListener('click', async () => {
  document.getElementById('logMods').textContent = '';
  try {
    await api('POST', '/api/mods/discordconnector');
    refreshModList();
    alert('DiscordConnector installed. Configure its webhook in BepInEx/config/nwesterhausen.discordconnector.cfg (created after the server is started once with it installed), then restart the server.');
  } catch (e) {
    alert(e.message);
  }
});

document.getElementById('btnDiscordTest').addEventListener('click', async () => {
  const btn = document.getElementById('btnDiscordTest');
  btn.disabled = true;
  try {
    await api('POST', '/api/discord/test');
    btn.textContent = 'Sent ✓';
  } catch (e) {
    alert(e.message);
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Send test message'; }, 2000);
  }
});

// ---- Players --------------------------------------------------------------

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function renderOnlineList(elementId, online) {
  const el = document.getElementById(elementId);
  el.innerHTML = online.length === 0
    ? '<li class="meta">No one online.</li>'
    : online.map(p => `
        <li>
          <span>${p.name || p.steamName || 'Connecting...'} ${!p.name ? `<span class="mod-version">(${p.clientId})</span>` : ''}</span>
          <span class="mod-version">since ${timeAgo(p.connectedAt)}</span>
        </li>
      `).join('');
}

async function refreshPlayers() {
  const historyList = document.getElementById('playerHistoryList');

  try {
    const online = await api('GET', '/api/players/online');
    renderOnlineList('onlineList', online);
    renderOnlineList('dashboardOnlineList', online);
  } catch (e) {
    document.getElementById('onlineList').innerHTML = `<li class="meta">Error: ${e.message}</li>`;
  }

  try {
    const history = await api('GET', '/api/players/history');
    historyList.innerHTML = history.length === 0
      ? '<li class="meta">No join/leave activity yet.</li>'
      : history.map(h => `
          <li>
            <span>${h.event === 'join' ? '→' : '←'} ${h.name || h.clientId}${h.reason ? ` <span class="mod-version">(${h.reason})</span>` : ''}</span>
            <span class="mod-version">${timeAgo(h.at)}</span>
          </li>
        `).join('');
  } catch (e) {
    historyList.innerHTML = `<li class="meta">Error: ${e.message}</li>`;
  }
}

// ---- Deaths ---------------------------------------------------------------

async function refreshDeaths() {
  const list = document.getElementById('deathList');
  try {
    const deaths = await api('GET', '/api/deaths');
    list.innerHTML = deaths.length === 0
      ? '<li class="meta">No deaths detected yet.</li>'
      : deaths.map(d => `
          <li>
            <span>💀 ${d.name}</span>
            <span class="mod-version">${timeAgo(d.at)}</span>
          </li>
        `).join('');
  } catch (e) {
    list.innerHTML = `<li class="meta">Error: ${e.message}</li>`;
  }
}

// Refresh whichever tab is visible, plus keep dashboard-relevant data fresh
// in the background so switching tabs feels instant.
refreshPlayers();
refreshDeaths();
setInterval(refreshPlayers, 8000);
setInterval(refreshDeaths, 8000);

// ---- Access lists (admin / banned / permitted) -----------------------------

const ACCESS_TYPES = [
  { type: 'admin', listId: 'adminList', idInput: 'adminSteamId', nameInput: 'adminName', addBtn: 'btnAddAdmin' },
  { type: 'banned', listId: 'bannedList', idInput: 'bannedSteamId', nameInput: 'bannedName', addBtn: 'btnAddBanned' },
  { type: 'permitted', listId: 'permittedList', idInput: 'permittedSteamId', nameInput: 'permittedName', addBtn: 'btnAddPermitted' }
];

function renderAccessList(type, entries) {
  const cfg = ACCESS_TYPES.find(t => t.type === type);
  const el = document.getElementById(cfg.listId);
  el.innerHTML = entries.length === 0
    ? '<li class="meta">Empty.</li>'
    : entries.map(e => `
        <li>
          <span>${e.name ? `${e.name} ` : ''}<span class="mod-version">${e.steamId}</span></span>
          <button class="btn-remove" data-steamid="${e.steamId}">Remove</button>
        </li>
      `).join('');

  el.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api('DELETE', `/api/access-lists/${type}/${btn.dataset.steamid}`);
        refreshAccessLists();
      } catch (e) {
        alert(e.message);
      }
    });
  });
}

async function refreshAccessLists() {
  try {
    const all = await api('GET', '/api/access-lists');
    renderAccessList('admin', all.admin || []);
    renderAccessList('banned', all.banned || []);
    renderAccessList('permitted', all.permitted || []);
  } catch (e) {
    alert(e.message);
  }
}
refreshAccessLists();

for (const cfg of ACCESS_TYPES) {
  document.getElementById(cfg.addBtn).addEventListener('click', async () => {
    const steamId = document.getElementById(cfg.idInput).value.trim();
    const name = document.getElementById(cfg.nameInput).value.trim();
    if (!steamId) return alert('Enter a SteamID64 first.');
    try {
      await api('POST', `/api/access-lists/${cfg.type}`, { steamId, name });
      document.getElementById(cfg.idInput).value = '';
      document.getElementById(cfg.nameInput).value = '';
      refreshAccessLists();
    } catch (e) {
      alert(e.message);
    }
  });
}

// ---- Backups --------------------------------------------------------------

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function refreshBackups() {
  const list = document.getElementById('backupList');
  try {
    const backupsList = await api('GET', '/api/backups');
    list.innerHTML = backupsList.length === 0
      ? '<li class="meta">No backups yet.</li>'
      : backupsList.map(b => `
          <li>
            <span>${b.fileName} <span class="mod-version">${formatBytes(b.sizeBytes)} · ${timeAgo(b.createdAt)}</span></span>
            <span class="mod-actions">
              <button class="btn-update" data-file="${b.fileName}" data-action="restore">Restore</button>
              <button class="btn-remove" data-file="${b.fileName}" data-action="delete">Delete</button>
            </span>
          </li>
        `).join('');

    list.querySelectorAll('[data-action="restore"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Restore ${btn.dataset.file}? This replaces the current world files. Make sure the server is stopped first.`)) return;
        try {
          await api('POST', `/api/backups/${encodeURIComponent(btn.dataset.file)}/restore`);
          alert('Restored. You can start the server now.');
        } catch (e) {
          alert(e.message);
        }
      });
    });
    list.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete ${btn.dataset.file}? This cannot be undone.`)) return;
        try {
          await api('DELETE', `/api/backups/${encodeURIComponent(btn.dataset.file)}`);
          refreshBackups();
        } catch (e) {
          alert(e.message);
        }
      });
    });
  } catch (e) {
    list.innerHTML = `<li class="meta">Error: ${e.message}</li>`;
  }
}
refreshBackups();

document.getElementById('btnCreateBackup').addEventListener('click', async () => {
  const btn = document.getElementById('btnCreateBackup');
  btn.disabled = true;
  btn.textContent = 'Backing up...';
  try {
    await api('POST', '/api/backups');
    refreshBackups();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create backup now';
  }
});

// ---- Scheduled restart ------------------------------------------------------

async function refreshScheduledRestart() {
  const el = document.getElementById('scheduledRestartInfo');
  const cancelBtn = document.getElementById('btnCancelRestart');
  try {
    const status = await api('GET', '/api/server/scheduled-restart');
    if (!status.scheduled) {
      el.innerHTML = '';
      cancelBtn.style.display = 'none';
      return;
    }
    const mins = Math.floor(status.secondsRemaining / 60);
    const secs = status.secondsRemaining % 60;
    el.innerHTML = `<p class="meta">Restarting in ${mins}m ${secs}s (${status.reason}).</p>`;
    cancelBtn.style.display = '';
  } catch (e) {
    el.innerHTML = '';
  }
}
refreshScheduledRestart();
setInterval(refreshScheduledRestart, 3000);

document.getElementById('btnScheduleRestart').addEventListener('click', async () => {
  const minutes = Number(document.getElementById('restartMinutes').value);
  if (!minutes || minutes <= 0) return alert('Enter a number of minutes greater than 0.');
  try {
    await api('POST', '/api/server/schedule-restart', { minutes });
    refreshScheduledRestart();
  } catch (e) {
    alert(e.message);
  }
});

document.getElementById('btnCancelRestart').addEventListener('click', async () => {
  try {
    await api('POST', '/api/server/cancel-scheduled-restart');
    refreshScheduledRestart();
  } catch (e) {
    alert(e.message);
  }
});

// ---- Mod search (Thunderstore) ---------------------------------------------

async function runModSearch() {
  const query = document.getElementById('modSearchInput').value.trim();
  const source = document.getElementById('modSearchSource').value;
  const resultsEl = document.getElementById('modSearchResults');
  if (!query) return;

  resultsEl.innerHTML = '<li class="meta">Searching...</li>';
  try {
    const { results, warnings } = await api('GET', `/api/mods/search?q=${encodeURIComponent(query)}&source=${source}`);

    const warningHtml = warnings && warnings.length > 0
      ? `<li class="meta" style="color: var(--warn);">⚠ ${warnings.join(' · ')}</li>`
      : '';

    resultsEl.innerHTML = warningHtml + (results.length === 0
      ? '<li class="meta">No matches. Try fewer or different words.</li>'
      : results.map(r => `
          <li>
            <span>
              <strong>${r.name}</strong> <span class="badge ${r.source === 'hexium' ? 'badge-accent' : 'badge-neutral'}">${r.source === 'hexium' ? 'Hexium' : 'Thunderstore'}</span>
              <span class="mod-version">by ${r.namespace} · v${r.version || '?'} · ${r.downloads.toLocaleString()} downloads</span>
              <br /><span class="meta">${r.description || ''}</span>
            </span>
            <button class="btn-update install-search-result" data-namespace="${r.namespace}" data-name="${r.name}" data-source="${r.source}">Install</button>
          </li>
        `).join(''));

    resultsEl.querySelectorAll('.install-search-result').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Installing...';
        const endpoint = btn.dataset.source === 'hexium' ? '/api/mods/hexium' : '/api/mods/thunderstore';
        try {
          await api('POST', endpoint, { namespace: btn.dataset.namespace, name: btn.dataset.name });
          refreshModList();
          btn.textContent = 'Installed ✓';
        } catch (e) {
          alert(e.message);
          btn.disabled = false;
          btn.textContent = 'Install';
        }
      });
    });
  } catch (e) {
    resultsEl.innerHTML = `<li class="meta">Error: ${e.message}</li>`;
  }
}

document.getElementById('btnModSearch').addEventListener('click', runModSearch);
document.getElementById('modSearchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runModSearch();
});

// ---- World picker + open folder --------------------------------------------

async function refreshWorldPicker() {
  const picker = document.getElementById('worldPicker');
  try {
    const { worlds } = await api('GET', '/api/worlds');
    picker.innerHTML = '<option value="">— Pick an existing world instead —</option>' +
      worlds.map(w => `<option value="${w}">${w}</option>`).join('');
  } catch (e) {
    // Non-critical — leave the default option in place.
  }
}
refreshWorldPicker();

document.getElementById('worldPicker').addEventListener('change', (e) => {
  if (e.target.value) {
    document.getElementById('cfgWorldName').value = e.target.value;
  }
});

document.getElementById('btnOpenWorldsFolder').addEventListener('click', async () => {
  try {
    await api('POST', '/api/worlds/open-folder');
  } catch (e) {
    alert(e.message);
  }
});

// ---- Login / auth settings -------------------------------------------------

async function refreshAuthStatus() {
  const el = document.getElementById('authStatus');
  try {
    const status = await api('GET', '/api/auth/status');
    el.textContent = status.authEnabled
      ? `Login is on, username: ${status.username}`
      : 'Login is currently off — anyone who can reach this page has full access.';
    document.getElementById('btnLogout').style.display = status.authEnabled ? '' : 'none';
  } catch (e) {
    el.textContent = '';
  }
}
refreshAuthStatus();

document.getElementById('btnEnableAuth').addEventListener('click', async () => {
  const username = document.getElementById('authUsername').value.trim();
  const password = document.getElementById('authPassword').value;
  if (!username) return alert('Enter a username.');
  if (!password) return alert('Enter a password (this sets/changes it — leaving it blank does nothing).');
  if (password.length < 8) return alert('Password needs to be at least 8 characters.');
  try {
    await api('POST', '/api/auth/setup', { username, password });
    document.getElementById('authPassword').value = '';
    refreshAuthStatus();
    alert('Login saved. You\'ll need it next time you load this page.');
  } catch (e) {
    alert(e.message);
  }
});

document.getElementById('btnDisableAuth').addEventListener('click', async () => {
  if (!confirm('Turn off login? Anyone who can reach this dashboard will then have full access with no password.')) return;
  try {
    await api('POST', '/api/auth/setup', { enable: false });
    refreshAuthStatus();
  } catch (e) {
    alert(e.message);
  }
});

document.getElementById('btnLogout').addEventListener('click', async () => {
  try {
    await api('POST', '/api/auth/logout');
    window.location.href = '/login.html';
  } catch (e) {
    alert(e.message);
  }
});

// ---- Autostart on Windows login ---------------------------------------

async function refreshAutostartStatus() {
  const el = document.getElementById('autostartStatus');
  const checkbox = document.getElementById('cfgAutostartEnabled');
  try {
    const { enabled } = await api('GET', '/api/autostart/status');
    checkbox.checked = enabled;
    el.textContent = enabled ? 'Currently on.' : 'Currently off.';
  } catch (e) {
    el.textContent = '';
  }
}
refreshAutostartStatus();

document.getElementById('cfgAutostartEnabled').addEventListener('change', async (e) => {
  const el = document.getElementById('autostartStatus');
  try {
    await api('POST', '/api/autostart', { enabled: e.target.checked });
    el.textContent = e.target.checked ? 'Currently on.' : 'Currently off.';
  } catch (err) {
    alert(err.message);
    e.target.checked = !e.target.checked; // revert the checkbox on failure
  }
});
