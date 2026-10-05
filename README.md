<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-e25117?style=for-the-badge" alt="English" /></a>
  <a href="README.ru.md"><img src="https://img.shields.io/badge/Русский-30343b?style=for-the-badge" alt="Русский" /></a>
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/简体中文-30343b?style=for-the-badge" alt="简体中文" /></a>
</p>

<p align="center">
  <img src="assets/havvn-cover.png" alt="Havvn — a private, serverless P2P hub" width="720" />
</p>

# Havvn

[Changelog — 3.1.0](CHANGELOG.md#310---2026-10-05)

[![Release](https://img.shields.io/github/v/release/NIHILcoder/Havvn?label=Release&color=e25117)](https://github.com/NIHILcoder/Havvn/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/NIHILcoder/Havvn/total?label=Downloads&color=orange)](https://github.com/NIHILcoder/Havvn/releases)
![Platform](https://img.shields.io/badge/Platform-Windows%20·%20macOS%20%2F%20Linux%20planned-blue)
![License](https://img.shields.io/badge/License-MIT-green)
![Built with](https://img.shields.io/badge/Electron%20%2B%20React%20%2B%20Transmission%20%2B%20WebTorrent-informational)

**A private, serverless P2P hub that happens to speak BitTorrent.**

Havvn (formerly TorrentHunt) is a fully-featured torrent client — but that's the foundation, not the
point. Its real job is the things classic clients *can't* do, all peer-to-peer with
**no servers, no accounts, and nothing in the cloud**:

- 📺 **Watch anywhere.** Stream a torrent *while it's still downloading* to your phone,
  laptop or TV — even formats the browser can't natively play (transcoded on the fly).
- 🔗 **Share without friction.** Send a finished download straight into a friend's
  **browser** over a link — no install, no account on their side.
- 👥 **Private friend rooms.** Spin up an invite-only **room** where everyone's files
  auto-sync into a shared folder and you **chat, end-to-end encrypted and signed**.
  Connections even hop between members, so a room works across home networks **without
  any infrastructure of its own**.
- 🎮 **Play together.** A room can become a **private LAN** so games that only speak
  local network work over the internet, and you can run a **dedicated server** inside
  the room — no accounts, no hosted game service.
- 🎙️ **Hang out in voice.** Serverless room voice chat with **neural noise suppression**,
  **screen sharing** (system audio included, echo-cancelled) and a **global push-to-talk**.
- 🛡️ **Inspect your network exit.** A privacy dashboard separates direct-request IP,
  system web proxy and local tunnel routes, with a VPN kill-switch.

You bring your own indexers and feeds — Havvn bundles none. Everything runs on
your machine and directly between you and your peers: **the developer runs no servers,
and the app costs nothing to operate.** Public WebRTC **rendezvous trackers** broker the
initial handshake — they never carry file bytes or plaintext, and you can point Havvn
at **your own trackers** in Settings → Sharing. Network discovery also uses STUN;
search contacts the providers you configure, and optional features such as IP/ISP
lookups contact their respective services. Built with Electron,
React, a bundled native Transmission engine and WebTorrent.

> **Legal use only.** Havvn does not bundle indexers for copyrighted material.
> The only pre-seeded source is a Creative Commons / open-source RSS feed (FOSS Torrents),
> shipped **disabled**. Any search providers or additional RSS feeds are added by you, and
> you are responsible for what you download and share.

---

## Download

Grab the latest Windows installer from the
**[Releases page](https://github.com/NIHILcoder/Havvn/releases/latest)**.

This README describes the current `main` branch. The latest packaged release may
not include all of these features yet; check its release notes.

### Verify your download

Every release is scanned with [VirusTotal](https://www.virustotal.com/) and ships with
a SHA-256 checksum — both are listed in that release's notes. As an open-source desktop
app, the installer may trigger a SmartScreen "unknown publisher" prompt; verifying the
checksum confirms the file is genuine.

```powershell
Get-FileHash .\Havvn-Setup-<version>.exe -Algorithm SHA256
```

Compare the output against the SHA-256 published in the matching GitHub release.

---

## Features

### Downloads
- **Bundled native Transmission engine** for fast, battle-tested transfers, with a
  WebTorrent fallback (WebTorrent also powers rooms and share links)
- Add torrents via **.torrent file, magnet link, or drag & drop** — local files *and*
  remote `.torrent` URLs are supported — or **search from Downloads** without leaving
  the add flow
- Pause / resume / remove (with optional file deletion), retry failed downloads
- **Per-file selection & priority**, sequential download, global speed limit
- **Upload capped by default** — fresh profiles share a **1024 KB/s (1 MiB/s)**
  upload budget across regular torrents. Change it in Settings → Connection;
  existing profiles keep their saved limit. Optional adaptive upload backs off
  when network latency rises
- **Seed ratio / seed time limits**, tracker add/remove per torrent
- **Stop / resume seeding** independently of pausing an unfinished download —
  completed files stay in the list and can be shared again
- **Tracker warnings** stay separate from transfer failures, so a rejected tracker
  does not label an otherwise working download as failed
- **Category and paused** on add — from the dialog, from search, and from RSS — so a
  week of grabs does not land in one pile already transferring. These are your
  download groups, not search filters for the source site's content
- Categories, search/filter/sort, list & detailed views
- Open the OS "open with" dialog when you double-click a `.torrent` — no silent adds

### Discover content
- **Pluggable search** — bring your own **Jackett**, **Prowlarr (Torznab)**, a custom
  JSON API, or a **local Python script**. No indexers are bundled. Results arrive as
  each provider answers (and can be cancelled), with duplicate torrents merged.
  Pick files, copy the magnet, open the release page or add paused into a download
  category. Retry a failed provider while keeping the other results. A script can
  describe itself in a `th-plugin` comment so you see its name and required
  credentials before a search fails — see [search plugins](docs/search-plugins/)
- **Compare release variants** — group matching films and episodes, expand their
  variants, refine results by release details, and see torrents already added or
  completed. Save preferences for resolution, audio language, voice/dub type,
  maximum size and minimum seeds, then rank matching releases first. Media labels
  are inferred from release names; unknown details remain unknown.
  **Compare** on a release group opens aligned cards with
  quality, size, audio languages, subtitles and per-source seed observations with
  receipt times. Title hints and optional Custom JSON/plugin media reports are
  labelled separately; absent labels remain unknown. Cache replay keeps original
  timestamps. Download a chosen edition directly from comparison.
- **Download history in search** — removed torrents stay marked across restarts.
  Results without a hash receive a non-blocking possible-match hint. Up to 1000
  local records are kept; clearing them does not remove downloads or files.
- **Per-source connections** — System (system proxy/VPN), Direct, or a reusable
  HTTP/SOCKS5 proxy profile, plus trusted mirrors. Compatible Python plugins use
  the Havvn Network SDK. **Sign in** opens an isolated source browser; log in and
  complete any browser check there, then close it to keep the session for search
  and `.torrent` retrieval. Browser extensions in Chrome/Edge are not inherited
- **HTTP mirror failover** — Custom JSON, Jackett and Torznab try configured
  service copies after network errors or HTTP 5xx, keeping the selected connection,
  API path and query parameters. Search, capabilities and `.torrent` retrieval
  share this behavior: up to four addresses within 20 seconds, with the last
  working mirror first. Login/browser checks, rate limits, proxy and TLS failures
  stop the attempt. Add mirrors under **Providers → Source connection** and use
  **Save and check**. Jackett/Torznab mirrors use the same base-URL format as the
  provider; Custom JSON mirrors use an origin plus an optional service prefix,
  to which Havvn appends the original search path. Mirrors must serve the same API;
  HTTPS sources require HTTPS mirrors. Legacy connections keep their old behavior.
- **RSS as a rule engine** — a rule watches any set of feeds (or all of them), matches
  on words or a regex with include and exclude, bounds size, seeds and age, and files
  what it grabs with its own path, category and paused choice. Smart episode matching
  keeps **one copy per episode** when several groups post the same one. Feeds import
  and export as **OPML**. New items raise a notification if you asked to be told;
  rows you dismiss leave the list but stay remembered so a rule cannot grab them
  again. Only items that appear after you subscribe are grabbed, never the
  back-catalogue. One legal FOSS feed is pre-seeded **disabled** (opt-in, no
  background traffic until you enable it)

### Stream & watch
- **Built-in player** — watch/listen to a file *while it's still downloading*; playback
  starts before the download finishes. Music and video **open in their own window**
  (the app's chrome, not an OS caption) and come home on demand; position, pause and
  volume survive the trip
- **A mixing desk for music** — five-band equaliser with presets, loudness levelling,
  repeat/shuffle and an output device, remembered across tracks, windows and sessions
- **Subtitles** — embedded text tracks (mkv, etc.) and sidecar `.srt` / `.ass` / `.vtt`
  files are converted to WebVTT on the fly and overlaid on playback
- **Remembered player preferences** — preferred audio/subtitle languages, subtitle
  mode, size, colour, background and timing offset, with per-file track choices
- **Playback diagnostics** — see startup/conversion/buffering state, continuous
  media buffered ahead, torrent speed and peers. Seeking into an incomplete area
  waits for data; torrent progress is not the same as playable buffer
- **Continue watching** — local watch history with resume, start over, next episode,
  mark watched and remove/clear actions. Positions survive seeks, transcoding,
  audio-track changes and switching between the main and pop-out player. History
  does not restore deleted files or automatically resume stopped downloads
- **Next episode prefetch (Classic/WebTorrent)** — opt in to download a bounded
  beginning of the next file near the end of playback. It yields to the current
  video and stops on pause, seek or low buffer. Native/Transmission does not yet
  support this feature; excluded files require explicit consent
- **External players** — open complete local media in the system-associated player,
  or choose your installed **VLC / mpv**. VLC and mpv can also play incomplete files
  from a verified local stream while Havvn stays open. VLC / mpv can start from the
  saved position; **mpv sends progress back to watch history** while Havvn runs. VLC and
  the system player do not send playback positions back
- **On-the-fly transcoding** — formats the browser can't decode (mkv, HEVC, AVI…) are
  converted live via the bundled ffmpeg, no external player needed
- **Watch on another device (LAN)** — one click shows a QR code + link; open it on a phone,
  tablet or laptop on the **same Wi-Fi** and stream the torrent with **seeking**, even for
  exotic codecs (served as adaptive HLS straight from your PC — no cloud, no app on the
  other device)
- **Cast to TV** — find Chromecast / Android TV / Google TV devices on your network and
  play a torrent on the big screen with pause / resume / stop controls
- **Watch anywhere (experimental)** — stream a torrent to a device *outside* your network
  over WebRTC, transcoded on the fly

### Create & share
- Create torrents from files or folders (single or batch), custom trackers, private flag,
  start-seeding-immediately
- **Instant Share Links** — send a completed download to anyone via a browser link
  (peer-to-peer over WebRTC, no install on their side); short links + QR
- **Join a room from the browser** — the invite dialog copies a link
  that opens chat, voice and watch-together in Chrome, Edge or Firefox. No
  install on their side; you keep Havvn open. Encrypted files and the rest of
  the app (LAN, game server, file write) stay in the desktop client
- **Rooms (friend swarms)** — create a private group, share a speakable invite code, and
  everyone's files auto-distribute peer-to-peer into a shared folder. No cloud: members
  find each other over WebRTC and converge a file manifest, live presence, and
  **end-to-end encrypted chat** over **AES-256-GCM** channels keyed from the code
- **A real app-grade room layout** — three regions (People + Voice | Stage | Chat) with
  draggable splitters that remember their widths; **tear any panel out** (chat, voice,
  files, LAN, server) into its own window and drag it to a second monitor — a call
  stays connected and a download keeps going
- **End-to-end encrypted rooms** — opt in at creation and the swarm carries **ciphertext
  only**: files are encrypted on your disk before seeding and decrypted after download,
  never plaintext on the wire. The room's content key is **distributed in an
  owner-signed config (Ed25519)** so a member who merely holds the invite code can't
  plant or forge one, and the invite code itself marks the room encrypted so a joiner
  never seeds plaintext by mistake
- **Organize the shared folder** — top-level **sections** with folders inside, drag & drop
  onto either level, and **per-folder auto-download** that inherits section → room
  settings (or pull files manually, per file)
- **A files zone that works like a file manager** — context menus, hover actions, filter
  chips, view options, per-room sort & collapse memory, search highlighting,
  **image thumbnails with a lightbox**, Show-in-folder, and a total-size readout — and
  huge rooms stay smooth thanks to **virtualized lists**
- **Watch & listen together** — open a shared file in the in-app theater and flip on
  **"together"**: playback stays in sync across the room (play/pause/seek follow, and
  late joiners catch up to the current position). Music files get a dedicated mode — an
  album-art disc from the track's **ID3 tags**, a live **WebAudio spectrum**, a shared
  queue that auto-advances, and floating emoji reactions
- **Watch while it downloads** — start a shared video in the room theater *before* the
  download finishes (non-E2E rooms, browser-native formats)
- **Member profiles** — signed profiles with name colors, status lines and a pick of
  deterministic avatar styles, generated on your device and never uploaded; open a
  **profile card** from any member or message
- **Invite previews** — the invite dialog shows who's inside, file count and total size,
  and whether voice is live, with a prominent copy button
- **Ownership transfer** — hand a room to another member with a **signed transfer chain**,
  so clients can verify the new owner instead of trusting a claim
- **Local room data** — inspect managed copies and encrypted cache, clean selected downloaded copies while retaining publications and keys, and browse local history in pages. Password-protected room/identity recovery preserves old keys and signed proofs; restore into an empty room profile. File bytes and chat history are excluded from the backup. See [room data](docs/rooms-local-data.md).
- **Signed profile bans** — updated clients and browser guests sync an owner-signed ban list, including after an owner handover or holder restart. Removal blocks a profile, not a person: a new identity with the current invite can join. Files and keys already received cannot be revoked.
- **Per-room controls** — auto-download every shared file or pull them **manually** per
  file, and set per-room **upload / download speed limits**
- **Desktop receive queue** — two simultaneous file receives across all rooms, visible waiting count/size, pause/resume that keeps partial files, and queue priority. Disk checks account for encrypted and plaintext copies with a 256 MiB safety margin. [Details and limits](docs/rooms-receive-resources.md).
- **Shared room file budget** — default 256 KB/s upload across desktop room clients, configurable total upload/download, voice priority, and a separate screen bitrate per participant. New rooms offer manual or automatic downloading; manual is the default. Voice/video/LAN and regular torrents have separate transports.
- **Shared playback model** — rate-aware positions, drift correction, separate buffering/pause states and pending commands during loading. Track changes retain the watch session and speed; desktop and browser use the same rules. [Model and limits](docs/rooms-playback-model.md).
- **Optional playback host** — the room owner selects a desktop or browser host; viewers request actions and report readiness, buffering or local playback. Shared control remains available. [Host mode and limits](docs/rooms-watch-host.md).
- **Large room lists** — paged synchronization and persistence for up to 5000 files, bounded metadata, and consistent voice admission for nine participants with visible waiting status. [Capacity and compatibility](docs/rooms-manifest-capacity.md).
- **Room connection diagnostics** — observed discovery/handshake/sync stages, separate file/voice/LAN health, retry discovery while keeping established channels, and a reduced JSON report without invitations, keys, addresses or chat. [Definitions and limits](docs/rooms-connection-diagnostics.md).
- **Local room acceptance** — `npm run test:rooms` checks isolated peers, encrypted transfers, voice, playback and themed windows. Physical VPN/NAT/TURN and device checks remain separate. [Scope, evidence and compatibility](docs/rooms-local-acceptance.md).
- **Signed chat** — every message is **signed (Ed25519)** and bound to a member
  identity, so even someone who has the invite code can't post under another member's
  name; the local chat history is **encrypted at rest**. The composer is built for
  sharing scripts: multiline input, Tab indents, and triple-backtick **code blocks**
  with copy
- **Connections across networks** — WebRTC trackers broker discovery; ICE tries direct connections. Other members can relay room messages, and file holders can serve downloaded files. Strict NAT may require configured TURN. A relayed member in the list does not prove that file, voice or LAN traffic uses TURN. [Observed paths and limits](docs/rooms-connection-diagnostics.md).
- **Bring your own rendezvous trackers** — rooms, share links and remote cast announce to
  public WebRTC trackers to broker the first handshake (no file bytes, no plaintext). Point
  Havvn at your own instead in Settings → Sharing; an unusable entry falls back to the
  public set rather than leaving a room with nowhere to announce

### Play together
- **Virtual LAN** — the host starts a session, admitted members get a virtual address
  and a direct encrypted link. Broadcast and multicast are replicated so LAN games
  find each other without anyone typing an address; a server hosted in the room is
  announced the same way. Relayed paths are opt-in and never drawn as a healthy
  direct link. **Windows only**, for now — other members still share files, chat and
  voice
- **A dedicated server in the room** — install, start, stop and a live console from
  the room itself; mods shared in the room can be mirrored in with consent. Minecraft
  is the module that exists today; others are named as coming
- **Room network recovery** — LAN has an explicit retry after terminal failure. Linked servers stop on room/network interruption and keep their worlds; schedules resume after an explicit Start. See [lifecycle details](docs/rooms-network-lifecycle.md).
- **Server console and local hosting** — remote commands wait for a signed host acknowledgement of process input. Leaving defaults to stopping servers and keeping worlds; an explicit local option keeps current processes manageable outside the room. See [console and exit details](docs/rooms-server-console-and-exit.md).

### Voice & screen share
- **Room voice chat with zero infrastructure** — a serverless WebRTC mesh between
  members, end-to-end like everything else in a room
- **Neural noise suppression** — RNNoise (Off / Standard / Enhanced) running in a
  WASM AudioWorklet, so keyboards and fans don't make the trip
- **Screen sharing, watched on demand** — share a screen or window into the room;
  optionally capture **system audio**, echo-cancelled so your speakers don't loop back
- **Global push-to-talk** — a system-wide hotkey that works while the app is in the
  background
- **Real device controls** — mic & output pickers, input gain, output volume,
  voice-activity sensitivity, and a **live mic test you can actually hear** through your
  chosen output device
- **Voice recovery** — desktop and browser guests retry ICE up to three times, then show a Retry action. Device changes preserve mute/deafen; see [recovery policy and tests](docs/rooms-voice-recovery.md).
- **Connection quality at a glance** — each tile shows good / fair / poor and
  reconnecting states

### Automation & networking
- **Scheduler** for time-based bandwidth rules (supports windows that cross midnight)
- **Watch folder** — auto-add `.torrent` files dropped into a directory
- **IP blocklist** support (load lists by URL, applied to the engine)
- **Advanced engine controls** — DHT toggle, max connections, listening port
- **Pause All / Resume All** from the toolbar or the system-tray menu

### Desktop experience
- **Optional background mode** — enable close-to-tray to keep torrents running after
  closing the window; reopen it from the shortcut or tray. By default, closing quits
- Run at login, close/minimize-to-tray, native completion notifications
- **Two-pillar layout** — a **Transfers | Rooms** switch keeps downloading and
  shared-listening as distinct spaces, bridged by a persistent status strip that surfaces
  live speed/peers and who's listening right now
- **Custom themes** — dark / light / system on the warm **Ember** palette (and the
  W-wings logomark), plus a **live theme editor**: two-mode token editing, JSON
  import/export, and a sanitizer so a shared theme can't break the app
- **Customizable hotkeys**
- **Materials & glass** — theme constructor glass presets saved with each theme, local backgrounds, per-area
  controls and appearance profiles. Native desktop Acrylic is available on
  Windows 11 22H2+. [Setup and compatibility](docs/appearance.md).
- **Localization** — English & Russian
- Settings export / import

### Privacy & anonymity
- **Network exit dashboard** — direct HTTPS exit IP, ISP and exit country; the system
  web proxy's IP/country appear separately. Countries describe network exits, not your
  physical or home location. Refreshes every 30 seconds while the panel is visible.
- **Local tunnel route detection** — recognizes NekoTun/sing-box and common VPN
  adapters, checks Internet routes and flags IPv6 bypasses. DNS and hosting-provider
  names do not count as VPN evidence. Unavailable route data stays unknown.
- **VPN kill-switch** — checks local routes every 5 seconds without external lookups,
  pauses active torrents and room networking when tunnel routing cannot be confirmed,
  and covers activity started during an outage. Torrents resume manually.
- **Native engine binding** — selects the routed IPv4 tunnel, blocks IPv6 peers and
  uses loopback fallback when no suitable tunnel is found.
- **One-click recommended privacy preset**, ephemeral peer ID, log sanitization, clear
  data on exit, and open/clear-logs controls
- **Secrets encrypted at rest** via OS-level encryption (DPAPI / Keychain / libsecret)

### Application security
- Context isolation, sandboxed renderer, Node integration disabled, type-safe IPC bridge
- Content-Security-Policy and navigation guards in production builds
- The local streaming server refuses cross-origin and DNS-rebinding requests, so a web
  page open in your browser can't read what you're streaming

### Security status

Havvn's room protocol is built on standard primitives — **AES-256-GCM** for content and
chat, **Ed25519** signatures for member identity, config authorship and ownership
transfer — but the protocol composing them is **my own design and has not had an
independent security review or audit**. It is written to resist a specific, concrete
threat: someone who holds a room's invite code but was never granted membership should
not be able to forge a config, impersonate a member, or plant a content key.

It is *not* built to withstand a well-resourced attacker, and it has not been tested
against one. Treat the encryption as meaningful protection from casual interception and
from other peers in the swarm — not as a guarantee for a threat model where being wrong
carries real consequences. If you find a flaw, please open an issue; I would rather hear
it than not.

---

## Tech Stack

| Layer        | Technology                                   |
|--------------|----------------------------------------------|
| UI           | React 18, TypeScript, d3-geo (swarm map)      |
| State        | Zustand                                      |
| Desktop      | Electron 44, Node.js                          |
| Torrents     | Transmission (bundled native engine) with a WebTorrent fallback; WebTorrent + WebRTC for rooms & share links |
| Voice        | WebRTC mesh, RNNoise noise suppression (WASM AudioWorklet), global hotkeys via uiohook |
| Persistence  | electron-store (local JSON), renderer localStorage for watch history and player/search preferences |
| Tests        | Vitest, Node.js test runner, isolated playback smoke scripts |
| Build        | webpack (renderer + browser guest), tsc (main), electron-builder |

---

## Getting Started

### Prerequisites
- **Node.js 24** and npm (the version used in CI)
- **Windows 10+ x64** for the current packaged target. macOS / Linux ports are planned
- **Python 3** only if you use Python search providers; VLC / mpv only if you choose
  those external players

### Install
```bash
npm ci
```

### Run in development
Starts the webpack dev server and Electron. The launcher waits for the renderer
at `http://127.0.0.1:3000/` before opening the app; the first compilation takes longer
than subsequent rebuilds:
```bash
npm run dev
```

### Build
```bash
npm run build        # compile main + renderer + browser guest
npm run typecheck    # type-check all three projects
npm test             # Vitest suites + Node.js dev-launcher tests
npm run lint         # lint
```

### Package a desktop installer
```bash
npm run dist         # build Windows x64 NSIS installer + portable ZIP
```
Packaged output is written to `release/`.

---

## Project Structure

```
electron/            Main process (TypeScript)
  torrent/           Torrent engines, creator, watch folder, LAN cast/HLS server
  services/          RSS, search/source sessions, external players, mpv IPC, IP blocklist
  sharing/           Share Links + Rooms (WebRTC seeder/engine in a hidden window)
  lan/               Virtual LAN (Windows)
  gameserver/        In-room dedicated servers
  scheduler/         Time-based scheduler engine
  db/                electron-store wrapper
  ipc/               Typed IPC handlers
  utils/             Logger, VPN detection, secure store, helpers
  main.ts            App lifecycle, tray, window, security
  preload.ts         contextBridge IPC API
renderer/            React UI (pages, components, stores, i18n)
guest/               Browser room guest (TypeScript)
shared/              Types, parsers, rule matching, playback contracts, download state machine
scripts/             Dev launcher, native prebuild setup, isolated smoke checks
docs/search-plugins/ Python provider examples + Havvn Network SDK
vendor/              Bundled native engine (Transmission) and Windows LAN driver (Wintun)
build/               App icons & installer resources
```

---

## Architecture

### Download state machine
Downloads follow a validated lifecycle (`shared/state-machine.ts`):

```
QUEUED → DOWNLOADING → SEEDING ⇄ COMPLETED
   ↓         ⇅           ⇅
   └──────→ PAUSED ─────→ COMPLETED

Transfer failures → ERROR → QUEUED / DOWNLOADING (retry)
Any state → REMOVED
```
Invalid transitions are rejected to keep state consistent.

### Persistence
Downloads, settings, feeds, rules and providers are stored locally via
**electron-store** (JSON). Progress is written on a debounced interval (batched into a
single write) to keep disk I/O low while torrents are active, so downloads resume after a
restart.
Watch history, playback positions and player/search preferences stay on this
computer in renderer localStorage. Source logins use separate persistent browser
sessions; they do not import cookies or passwords from your everyday browser.

### Process & security model
- Renderer runs context-isolated and sandboxed; Node integration is disabled
- A minimal, type-safe preload bridge exposes only the IPC surface the UI needs
- Production builds apply a Content-Security-Policy and block in-app navigation to
  external origins (external links open in the default browser)
- Source sign-in windows have their own sandboxed sessions and restrict top-level
  navigation to configured origins. HTTPS page resources and Cloudflare challenge
  resources are allowed inside the window; it exposes no application preload API

### Logging
Structured logs are written to the app's `logs/` directory with daily rotation,
multiple severity levels, and automatic cleanup of old files.

---

## Known Limitations

- **Speed limits** are enforced by the native engine for regular torrents; for rooms and
  share links (WebTorrent) they're applied best-effort via throttling. For strict
  control, use OS-level network management.
- **Peer statistics** for rooms and share links are approximate — WebTorrent reports
  aggregate peers and does not cleanly separate seeds from leechers.
- **VPN detection** checks selected Internet routes and adapter identities; split
  routing and application-specific rules can differ. HTTPS IP lookup does not measure
  the address seen by torrent peers. Havvn's kill-switch reacts after detection;
  use your VPN client's kill-switch for immediate network blocking.
- **Proxy**: there is no SOCKS/HTTP proxy option for peer traffic — use a VPN for
  network privacy. Per-source proxies cover search and `.torrent` retrieval only;
  authenticated proxy profiles are not supported yet.
- **Site access**: browser sign-in can reuse a source session, but does not guarantee
  access through site restrictions or browser checks. An older Python plugin needs
  updating to use the shared connection; Legacy mode keeps its own network/login path.
- **External playback**: install VLC / mpv yourself. Incomplete streams require an
  active, selected file and Havvn running; opening history or an external player does
  not resume paused/excluded downloads. Stopping an external stream leaves the torrent
  running. Only mpv reports playback position back to Havvn.
- **Episode prefetch** currently works only in Classic/WebTorrent, for files in the
  same torrent and playback with a known duration.
- **Watch anywhere (remote WebRTC streaming)** is experimental and depends on NAT
  traversal; it may not connect on every network.
- **Room connectivity across strict NAT**: rooms connect for the large majority of
  networks via direct/IPv6/STUN and **peer-relay through another member**. The one case
  that can't connect with zero infrastructure is a room where *every* member is behind a
  strict (symmetric) NAT and none is reachable — add **your own TURN relay** in settings
  (one member is enough) for that.
- **Watch-while-downloading in rooms** covers non-E2E rooms and browser-native formats;
  everything else plays the moment the download completes.
- **Browser room guests** get chat, voice and watch-together only. They cannot
  write files, join the virtual LAN or run a game server, and encrypted room
  files do not play in the tab. The host must keep Havvn open.
- **Virtual LAN is Windows only** — members on macOS or Linux can still share files,
  chat and voice; they cannot join the tunnel.
- **Game servers** — Minecraft is the only module so far, and a server lives on its
  host's machine.

---

## Contributing

CI runs on every push to `main` / PR (`.github/workflows/ci.yml`): type-check, tests and build are required
gates; lint runs as advisory. Please run `npm run typecheck`, `npm test` and `npm run build`
before opening a PR. The guest page (`docs/room/guest.js`) is produced by
`npm run build:guest` (also part of `npm run build`) and must be committed so
GitHub Pages can serve it.

When updating this README, keep the English, Russian (`README.ru.md`) and
Simplified Chinese (`README.zh-CN.md`) versions aligned.

---

## License

MIT License — see the `LICENSE` file.

Copyright © 2026 Havvn. Free to use, modify and distribute under the terms of the
MIT License.
