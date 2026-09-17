# Valheim Server Manager

A local web dashboard for running a Windows Valheim dedicated server:
install/update it via SteamCMD, start/stop/restart it, edit its settings,
and install Thunderstore mods by pasting a shared **profile code** (from
r2modman or the Thunderstore Mod Manager's "Export profile as code").

## Requirements

- Windows (the server binary and process control are Windows-specific)
- [Node.js 18+](https://nodejs.org)
- Outbound internet access (SteamCMD download, Steam, Thunderstore)

You do **not** need to install SteamCMD yourself — the app downloads it for
you the first time you click "Install / update server".

## First run

1. Unzip this folder anywhere, e.g. `C:\ValheimManager\`.
2. Double-click **start.bat**. It installs the Node dependencies on first
   run, starts the manager, and opens the dashboard at
   `http://localhost:4656`.
3. Go to the **Server** tab and check the paths:
   - `steamCmdPath` — where SteamCMD should live, e.g.
     `C:\steamcmd\steamcmd.exe` (created automatically if missing)
   - `serverInstallPath` — where the Valheim dedicated server should be
     installed, e.g. `C:\valheim_server`
   Set your server name, world name, password (5+ characters), and port,
   then **Save settings**.
4. Further down the **Server** tab, click **Install / update server**. Watch
   the output panel — this downloads several GB and can take a while.
5. Back on **Dashboard**, click **Start**. The live console streams below.

## Sharing your server with players

Once running, the Dashboard tab shows a **Share with players** card with:
- **Address** (`IP:port`) and **password**, for PC players joining by IP
- A **6-digit join code**, if crossplay is on — this is what Xbox,
  PlayStation, and Switch players enter under Join Game (their builds
  don't have an IP field). It's printed by the server itself once the
  crossplay session registers, usually a few seconds after startup.
  **It resets on every restart** — reshare it each time.

## Crash detection and auto-restart

If the server exits unexpectedly (a mod crash, not you clicking Stop),
the manager notices and restarts it automatically after a short delay —
configurable in **Server → Crash detection**. To stop a permanently
broken mod from triggering an endless restart loop, it gives up after a
configurable number of crashes within a time window (3 crashes in 10
minutes by default) and sends a Discord notification if you have
webhooks configured, so you know it needs manual attention. An
intentional Stop or Restart from the Dashboard is never mistaken for a
crash.

## Scheduled restarts and warnings

On the Dashboard, enter a number of minutes and click **Schedule restart**
to restart the server after a delay instead of immediately (the existing
**Restart now** button is still there for an instant restart with no
warning). Warnings go out at whichever of the 20/10/5/1-minute checkpoints
fit in the window you chose — a 3-minute scheduled restart only gets the
1-minute warning, for example.

Warnings post to **Discord only**. Vanilla Valheim has no way for this
manager (or anything external) to broadcast a message into the game
itself — there's no server chat/announce command — so Discord is the only
channel available. Turn on notifications in **Server → Discord
notifications** to receive them.

Auto-update-triggered restarts (when updates are found and the server is
running) go through this same scheduler automatically, with the full
20-minute warning window.

## Daily scheduled restart

Turn this on in **Server → Daily restart** and set a time (24-hour,
local time on the machine running the manager). It uses the same
20/10/5/1-minute warning sequence as any other scheduled restart, and
only actually fires if the server is already running when the time
comes — it won't start a stopped server just to restart it.

## World selection

**Server → Server → World name** now has a dropdown next to it listing
every world already found in your save folder (works with both Valheim's
current and legacy save formats) — pick one to fill in the name, or keep
typing a new name to create a fresh world. An **Open worlds folder**
button next to it opens the actual save location
(`AppData\LocalLow\IronGate\Valheim\worlds_local`) directly in File
Explorer.

## Remote access and login

By default the dashboard only listens on this machine (see **Dashboard
access** below). If you turn on network access to reach it from another
device, **set up a login first** — go to **Server → Login**, set a
username and password (8+ characters), and click **Save login**. Once
that's saved, the dashboard (and every API call) requires signing in
first; the login page is the only thing reachable without a session.
Sessions last 7 days; use **Sign out** (top right) to end one early, or
**Turn off login** in Settings to remove the requirement entirely.

The password is hashed (scrypt) before it's ever written to disk — the
plaintext password isn't stored anywhere, and the hash itself is never
sent back to the browser even on the settings page.

This is still plain HTTP, not HTTPS — fine on a trusted home network, but
don't rely on it over an untrusted one. And this still doesn't change the
advice below about never forwarding the port on your router; a login
narrows who can get in on your LAN, it doesn't make internet exposure
safe.

## Start on Windows login

**Server → Start on Windows login** adds a shortcut to your Windows
Startup folder, so the manager itself launches automatically when you
log in — no more remembering to double-click `start.bat`. This only
starts the *manager*; the Valheim server itself still needs Start
clicked (or combine this with auto-restart/daily-restart so it stays
running across manager restarts too, once you've started it once).

## Shutdown and data safety

**Stop** and **Restart** ask Valheim to save before exiting — they send a
real shutdown signal (the same one Ctrl+C in a console window sends), wait
up to 60 seconds for it to finish saving and exit on its own, and only
force-stop if it doesn't respond in that time. This matters: a plain
force-kill (which earlier versions of this app used) gives Valheim zero
chance to flush the world or any in-progress player data to disk — several
other Valheim server tools have documented this exact bug in their own
history. Auto-update and crash-recovery both go through this same stop
path, so the same protection applies everywhere the server gets stopped
automatically.

One thing worth knowing: because this requires attaching to the server's
own console to deliver the signal, **the server runs in its own separate
console window** instead of a fully hidden one (this is also how
Valheim's own official start scripts run it). It needs to be genuinely
separate from the manager's own window — an earlier version of this
didn't do that, so the signal could land on the manager's own console
too, producing a `^CTerminate batch job (Y/N)?` prompt that never got
answered and stalled the shutdown. You can ignore the server's console
window — everything you need is still in this dashboard — just don't
close it directly, since closing a console window forcefully is the same
as a force-kill.

If you ever see a "hasn't exited within 60s — force-stopping" message in
the console, that means the graceful shutdown didn't work for some reason
and it fell back to a hard stop (same behavior as before this fix) —
please let us know if you see this, since it would mean something needs
adjusting for your setup.

## World backups

The **Backups** tab lets you create, restore, and delete world backups.
Each backup zips up the entire world folder — this works correctly with
both Valheim's current save format (a chunked folder per world, as of
the 1.0 update) and the older `.db`/`.fwl` file pair, whichever actually
applies to your world. Backups are stored in this app's own `data/`
folder, kept separate from Valheim's save directory so they're never at
risk of being overwritten by anything Valheim itself does.

Restoring requires the server to be stopped first (restoring into a
running world's open files would corrupt them, not just fail cleanly).

**Auto-backup before mod updates**: enabled by default in
**Server → Auto mod-update**. Whenever the auto-updater is about to
apply mod updates, it backs up the world first — so if an update breaks
something (as happened earlier with a mod incompatible with a game
update), you can roll back with one click from the Backups tab instead
of losing progress.

## Server console: search and CPU/RAM

The Dashboard console has a filter box above it — type anything to show
only matching lines (e.g. "error", "died", a player's name) without
losing the rest of the log; clear it to see everything again.

While the server is running, a small **CPU / RAM** readout appears next
to its status, polled via PowerShell every few seconds. If it shows "…"
briefly after starting, that's normal — a percentage needs two samples
over time to compute; it fills in within a few seconds.

## World difficulty and global keys

Beyond the preset dropdown, the Server tab exposes every world modifier
the dedicated server itself supports:

- **Value modifiers** (`-modifier`): combat, death penalty, resource
  drops, raids, and portals — each with the specific values Valheim
  accepts. These apply *after* the preset, so picking a preset then
  adjusting one of these overrides just that one setting.
- **Checkbox modifiers** (`-setkey`): no build cost, player-triggered
  events, passive mobs, and no map.

These take effect from the world's next start — no admin console access
needed. They work on an existing, already-explored world too (nothing
built or explored is lost); only the rules change going forward. An admin
can also change modifiers *live* in-game with `setworldmodifier` /
`setworldpreset` / `resetworldkeys`, but that happens outside this app and
won't be reflected here until you restart.

## All server settings

The Server tab covers everything the dedicated server exe accepts a
flag for: paths, name/world/password, port, public/crossplay, save and
backup intervals, difficulty preset, custom save/log directories, and a
free-text field for any other launch flag. Changing the password (or
anything else here) takes effect the next time the server *starts* — if
it's already running, save your changes, then hit **Restart** on the
Dashboard tab.

## Admin / banned / permitted players (Access tab)

Add players by SteamID64 (find it at [steamid.io](https://steamid.io)) to
grant admin console access, ban them, or maintain a permitted-players
whitelist. These write directly to `adminlist.txt`, `bannedlist.txt`, and
`permittedlist.txt` in the server's save folder, and are refreshed
automatically every time the server starts.

## Installing mods

1. Get a Thunderstore Mod Manager or r2modman profile code from whoever
   built the modpack: in their app, **Settings → Profile → Export profile
   as code**. Codes are temporary — ask for a fresh one if import fails.
2. Go to the **Mods** tab, paste the code, click **Import**.
3. The app downloads every mod in that profile from Thunderstore and
   installs them into `BepInEx/plugins/`, installing BepInEx itself first
   if the profile includes it (most do).
4. Restart the server from the Dashboard tab to load the new mods.

You can also click **Install BepInEx only** to set up modding support
without importing a full profile, then manage mods manually if you prefer.

## Installing mods from Hexium

Some Valheim mod authors have moved to [Hexium](https://hexium.gg), a
newer community-run mod site — a few mods are now Hexium-exclusive.
Hexium mirrors Thunderstore's own API (confirmed against Gale's
open-source client, which both platforms share), so it's supported the
same way Thunderstore is:

- **Profile codes**: paste a code exported from Thunderstore Mod Manager,
  r2modman, or Gale into the Mods tab's import box. It checks both
  Thunderstore and Hexium for the code (Gale can upload an export to
  either, and there's no way to tell which from the code itself), and
  resolves each individual mod from whichever platform actually has it —
  so a profile mixing Thunderstore and Hexium-exclusive mods installs
  correctly in one go.
- **Installing one mod by name**: use **Install a specific mod from
  Hexium** on the Mods tab — enter the author and mod name exactly as
  shown on the mod's Hexium page (e.g.
  `valheim.hexium.gg/mods/shudnal/ConditionalConfigSync` → author
  `shudnal`, mod name `ConditionalConfigSync`).

Installed mods show a small badge indicating which platform they came
from, and Check for Updates / Update work the same way regardless of
source. If Hexium's API doesn't have a mod indexed yet, this falls back
to reading its public mod page directly — more fragile than the API path,
but keeps things working either way.

## Searching for mods

The Mods tab has a search box that covers both Thunderstore and Hexium
(or either one specifically, via the dropdown next to it) — search by
name or description, no need to already know the exact author/mod name.
Results show which platform each mod is on; clicking Install routes to
the right one automatically.

## Exporting your mod list as a code

The **Export current mods as code** button on the Mods tab generates a
shareable code for everything currently installed — the reverse of
importing. The dropdown next to it controls where the code gets
uploaded: **Auto-detect** (default) picks Hexium only if your current mod
list actually has a Hexium-sourced mod in it, otherwise Thunderstore,
matching Gale's own behavior; or force it to either platform explicitly —
useful if you know your friends' Gale is pointed at one specifically.
Both platforms return a standard UUID (with dashes, e.g.
`019c9378-d2e6-4fec-5a2f-e4b22f8cf1d1`) — that's expected regardless of
which one it came from, since Hexium mirrors Thunderstore's API exactly.

### Checking for mod updates

Click **Check for updates** on the Mods tab to compare every installed mod
against its latest version on Thunderstore. Mods with a newer version show
a badge and an **Update** button; if more than one has an update, an
**Update all** button appears too. Restart the server afterward to load
the new versions.

### Auto-updating mods

In **Server → Auto mod-update**, turn on automatic checking and set an
interval (hours). The manager checks in the background; if updates are
found, it applies them and — if the server was running — restarts it
automatically to load them.

## Players tab

The **Players** tab (works out of the box, no mod needed) is built by
parsing the dedicated server's own console log, which reliably reports
Steam ID on connect/disconnect and character name shortly after. Shows
who's online now, a join/leave history, and a death history section.
Add a free [Steam Web API key](https://steamcommunity.com/dev/apikey) in
the Server tab to show Steam persona names for players still mid-connect
(before their character name is known).

**Deaths** (best-effort — see below): vanilla Valheim's dedicated server
**does not log player deaths at all**. This is a hard limitation of the
base game, not something this tool can parse around. The Deaths tab
scans console output and `BepInEx/LogOutput.log` for death-like lines in
case an installed mod happens to print one, but nothing commonly used
actually does this, so this tab will likely stay empty.

**DiscordConnector does track deaths properly**, but stores them in a
LiteDB (binary, .NET-specific) database file — not something this app
can read. So installing it won't feed the Deaths tab here; instead, set
its webhook URL and deaths (plus joins/leaves/shouts/pings) go straight
to your Discord channel, which ends up being the more reliable place to
check them anyway. After installing it from the Mods tab, start the
server once to generate its config file at
`BepInEx/config/nwesterhausen.discordconnector.cfg` (or, in 2.1.0+, under
a `games.nwest.valheim.discordconnector` subfolder), set your Discord
webhook URL there, and restart.

## Discord notifications

Two independent layers:

- **Manager-level** (Server tab): a webhook URL here gets pinged by
  this tool for server start/stop and mod updates. No mod required.
- **In-game events** (join/leave/death/shout/ping): install
  DiscordConnector (Mods tab) and configure its own webhook — it reports
  these with full accuracy since it's hooked into the game itself.

You can use both at once, pointed at the same or different channels.

Note: players connecting to a modded server generally need the *same*
mods installed client-side (typically via the same profile code in
r2modman) — that's a Thunderstore/BepInEx requirement, not something this
tool can bypass.

### How mod installation works under the hood

- The BepInEx core pack is detected by name and its contents are copied to
  the server's root folder (it ships a `winhttp.dll` that Windows loads
  automatically when the server starts — no launch flags needed).
- Mods that ship a full `BepInEx/` folder structure (patchers, config,
  etc.) get that tree merged into the server's `BepInEx/` folder.
- Plain plugin mods get extracted into their own folder under
  `BepInEx/plugins/<namespace>-<name>/`.
- Installed mods are tracked in `BepInEx/_manager_installed.json` so the
  Mods tab can list and remove them.

## Notes & limitations

- **Stopping the server** terminates the process (`taskkill /F`) rather
  than sending an in-game quit command — Valheim's dedicated server has no
  interactive console for that. Auto-save/backup intervals (configurable
  in the Server tab) protect against losing much progress.
- **The dashboard has no login.** By default it only listens on
  `localhost`, so nothing else on your network (or the internet) can
  reach it — this is enforced in code, not just a suggestion. There's an
  opt-in **Server → Dashboard access** toggle to make it reachable from
  other devices on your *local* network (e.g. to control it from your
  phone at home). Turning that on requires fully restarting the manager
  process to take effect.

  **Never forward the dashboard's port (4656) on your router**, with or
  without that toggle on — anyone who found it could stop your server,
  change settings, or install mods with zero authentication. Forwarding
  the *game* port (2456 by default) is completely different and normal —
  that's what lets players connect to Valheim itself, and has nothing to
  do with the dashboard.

  If you want to manage the dashboard from outside your home network, the
  safe way is a VPN into your home network (e.g.
  [Tailscale](https://tailscale.com)), not a port forward. Ask if you'd
  like help setting one up, or if you'd rather have a basic login added
  to the dashboard itself.
- The **BepInEx core pack** can't be removed from the Mods tab (uninstalling
  it isn't safe to automate); delete it manually from the server folder if
  you ever need to.
- Uses Valheim's dedicated server Steam app ID `896660`.

## Project layout

```
server.js            Express app / API routes
lib/config.js         Settings load/save + launch-arg builder
lib/steamcmd.js        SteamCMD bootstrap + install/update
lib/serverProcess.js   Start/stop/restart the game server process; crash detection
lib/crashRecovery.js   Auto-restart after an unexpected exit, with backoff
lib/restartScheduler.js Scheduled restarts with escalating warnings
lib/backups.js          World backup/restore (format-agnostic) + world listing
lib/dailyRestart.js     Daily scheduled restart trigger
lib/auth.js             Login sessions, password hashing, the auth gate
lib/autostart.js        Windows Startup-folder shortcut management
lib/systemStats.js      CPU/RAM polling for the running server process
lib/thunderstore.js     Thunderstore-specific extras (BepInEx/DiscordConnector installers)
lib/hexium.js           Hexium-specific extras (API + page-scrape fallback)
lib/tsCompatBackend.js  Shared logic for any Thunderstore-API-compatible source
lib/httpFetch.js         Timeout wrapper so a hung network call fails cleanly
lib/profileCode.js      Shared r2modman/Gale profile-code decoding
lib/modInstaller.js     Shared package extraction/placement logic for both sources
lib/mods.js             Routes install/update/remove/import across both sources
lib/playerTracker.js    Online roster + join/leave history (log parsing)
lib/deathTracker.js     Best-effort death detection (log + file tailing)
lib/discordNotifier.js  Manager-level Discord webhook posts
lib/autoUpdate.js       Background scheduler for auto mod-updates
lib/accessLists.js      Admin/banned/permitted SteamID list management
lib/serverInfo.js       Parses public IP + crossplay join code from the console
lib/logBus.js           In-memory log streaming (SSE) for the dashboard
public/                 Dashboard frontend (HTML/CSS/JS, no build step)
config/config.json      Your settings (created on first run)
data/                   Player/death history + access lists (created on first run)
start.bat               Windows launcher
```
