# Changelog

All notable changes to TorrentHunt are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [1.5.24-beta] - 2026-06-05

### Removed
- **Collaborative Seeding Network.** The reputation/points/badges dashboard was a
  local-only mock with no real networking, so it's been removed entirely (UI and
  backend). The genuine per-torrent **seed ratio / time limits** stay (Settings →
  Seeding).

## [1.5.23-beta] - 2026-06-05

### Added
- **"Use TURN relays for share links" setting** (Network → Sharing, on by
  default). TURN relays let shares connect through strict (symmetric) NAT, but
  route the encrypted transfer through a third-party server that sees both IPs.
  Turn it off for a more private, direct-only connection (which won't work
  through symmetric NAT). The choice applies to both sides of the transfer.

### Changed
- **More reliable share connections across networks.** WebRTC now uses explicit
  STUN + (optional) TURN, so shares can also connect when a peer is behind a
  symmetric NAT — not just on the same network.

## [1.5.22-beta] - 2026-06-05

### Fixed
- **Custom-named created torrents now seed (not stuck at 0%).** "Start seeding"
  now seeds the original files straight from disk, so renaming the torrent in the
  Create dialog no longer breaks the content mapping. Sharing such a torrent uses
  the real source path too.

### Changed
- **Much shorter share links.** A share link now carries only the torrent's
  infoHash; the receiver page rebuilds the magnet (adding the trackers itself).
  Links are now short and constant-length regardless of the file name — which
  also makes the share QR code far less dense. Older long links still work.

## [1.5.21-beta] - 2026-06-05

### Added
- **QR code for share links.** The share dialog can now show a QR code to open
  the link on a phone. QR generation now uses a real library, so the codes are
  actually scannable (this also fixes the previously non-functional magnet QR on
  the "Torrent Created" screen).

### Fixed
- **Theme picker layout.** The "Color scheme" label and theme cards no longer
  drift across the panel as the window widens — the row is left-aligned and the
  cards keep a sensible width.

## [1.5.20-beta] - 2026-06-04

### Fixed
- **Created torrents now seed instead of stalling at 0%.** When creating a
  torrent from a single file, the auto-filled name stripped the extension, so
  the torrent name no longer matched the file on disk — WebTorrent couldn't find
  it and "start seeding" stuck at 0% (which also blocked making a share link).
  The name now keeps the extension, so created torrents seed immediately (100%)
  and can be shared.

## [1.5.19-beta] - 2026-06-04

### Fixed
- **Create-Torrent header is readable in light theme.** The elevated header used
  a dark gradient that wasn't overridden for light mode, leaving dark text on a
  dark bar; it now uses a light gradient.
- **Creating a torrent survives navigation.** The creation stage/progress/result
  now lives in a store, so switching tabs mid-creation no longer loses the
  window — coming back shows the live progress or the finished result.

## [1.5.18-beta] - 2026-06-04

### Fixed
- **Long file names no longer break layouts.** In the download detail view the
  title now truncates and the action buttons stay put instead of overlapping it.
  On the "Torrent Created" screen, a long file name no longer stretches the info
  grid and pushes the buttons out of place.

## [1.5.17-beta] - 2026-06-04

### Fixed
- **Share links now actually transfer.** The native WebRTC module crashed under
  Electron the moment a peer connected, so downloads never started. Sharing now
  runs in a hidden window using Chromium's own WebRTC (the same stack the browser
  receiver uses) while seeding the file straight from disk — validated
  end-to-end (peer connects and downloads). Dropped the native @roamhq/wrtc
  dependency entirely.

## [1.5.16-beta] - 2026-06-04

### Fixed
- **Share worker crashed in the packaged app.** The isolated share worker had
  been unpacked from the asar, which broke its module resolution
  (`require('webtorrent')` couldn't be found). It now stays inside the asar like
  the main process, so it loads modules identically. Worker stdout/stderr is now
  captured into the app log for diagnostics.

## [1.5.15-beta] - 2026-06-04

### Fixed
- **App no longer dies when a browser opens a share link.** The WebRTC native
  module could crash the whole process (a native segfault, uncatchable from JS)
  the moment a browser peer connected. Sharing now runs in an isolated
  utilityProcess — if WebRTC crashes, only that worker dies and the app keeps
  running (it respawns on the next share). Also disabled DHT on the share client.

## [1.5.14-beta] - 2026-06-04

### Fixed
- **App crash when opening a share link.** The share client didn't disable µTP,
  so the native utp-native module crashed the whole process (WSAENOBUFS) the
  moment a browser peer connected. It now uses `utp: false` like every other
  client, plus per-torrent error guards.

## [1.5.13-beta] - 2026-06-04

### Added
- **Instant Share Links (beta).** Right-click a completed download → **Share
  link…** to get a link anyone can open in a browser to download the file
  peer-to-peer over WebRTC — no install and no cloud, the bytes go straight from
  your machine. Built on a dedicated WebRTC-enabled WebTorrent client
  (@roamhq/wrtc) + public WebSocket trackers, with a static receiver page hosted
  on GitHub Pages. The app must stay open while people download.

### Notes
- Reliability depends on public WebRTC trackers and your NAT (no TURN yet), so
  some connections may fail — this is an early beta of the feature.

## [1.5.12-beta] - 2026-06-04

### Added
- **Play AVI/MKV and other formats via on-the-fly transcoding.** Files Chromium
  can't decode (avi, mkv, wmv, flv, HEVC, …) are now transcoded to H.264/AAC on
  the fly with a bundled ffmpeg, so they play in the in-app player. Direct
  playback that fails on an unsupported codec falls back to transcoding
  automatically. (Increases the installer size by ~80 MB for the ffmpeg binary.)

### Changed
- **Redesigned the player** to match the app's look — accent header, a
  "Converting" badge during transcoding, refined file switcher and states.

### Notes
- Transcoding re-encodes video in real time; weak CPUs may buffer on 1080p.
- Seeking ahead is limited while transcoding (live stream, no range).

## [1.5.11-beta] - 2026-06-04

### Added
- **Watch / listen while downloading.** A new in-app player streams video and
  audio straight from a torrent — playback starts before the download finishes
  (sequential, on demand). Right-click a download → **Watch / Listen**. Supports
  switching between multiple media files in a torrent. Built on WebTorrent's
  local streaming server (127.0.0.1 only). Codec support follows the built-in
  Chromium player (MP4/H.264, WebM, Ogg play best).

## [1.5.10-beta] - 2026-06-04

### Fixed
- **Auto-launch toggle no longer resets itself.** The toggle state is now read
  from the saved preference instead of the Windows login-item registry, which
  reported "off" when the item was registered under a custom name. The OS
  login item is still applied on startup and on every toggle.
- **Theme picker no longer overlaps its label.** The theme cards now stack
  full-width below the "Color scheme" label instead of overflowing into it at
  standard window widths.

## [1.5.9-beta] - 2026-06-03

### Fixed
- **Manual update check now downloads** — clicking "Check for Updates" downloads
  the new version regardless of the Auto Update toggle (a manual check is an
  explicit intent to update). Removed the misleading "downloading…" status that
  appeared even when nothing was being downloaded.

### Changed
- **Redesigned RSS item search** — replaced the oversized full-width search bar
  with a compact search box aligned in one row with the item count and clear
  button.
- **Removed the Catalog tab** — it was empty and duplicated the Search tab
  (which has Internet Archive built in). Removed from the sidebar, routing and
  the Ctrl+K shortcut.

## [1.5.8-beta] - 2026-06-03

### Added
- **Full Russian localization of Settings** — every settings tab and its
  sub-panels (General, Downloads, Network, Advanced, Scheduler, Seeding,
  Privacy, Interface, Notifications, System, About) plus the Privacy panel,
  Seeding dashboard and statistics are now fully translated (en/ru).

### Changed
- **Settings toggles auto-save** — switches now persist instantly on click and
  apply their side-effects immediately; the "Save Changes" bar is reserved for
  text/number fields only. "Cancel" reverts every tracked field.

## [1.5.7-beta] - 2026-06-03

### Added
- **RSS feed search** — the Items tab now has a search box that filters feed
  items by title in real time (works within a selected feed or across all
  feeds). Shows a `matched / total` counter and a dedicated "no matches" state.

### Changed
- **Auto-update prerelease support** — the updater now picks up prerelease
  (beta/alpha/rc) GitHub releases automatically when the installed build is
  itself a prerelease. Stable builds are never offered beta releases.

### Fixed
- **Clearer update errors** — the cryptic `Cannot find latest.yml ... 404`
  failure is now translated into an actionable message explaining that the
  release is missing its auto-update metadata. Network failures get a friendly
  message too.

## [1.5.6-beta]

### Added
- Real auto-update via electron-updater + GitHub releases.
- "Create Torrent" file exclusion with honest progress reporting.
- Real encryption / anonymity options, VPN kill-switch, disk-space guard,
  and torrent health indicators.

[1.5.24-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.24-beta
[1.5.23-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.23-beta
[1.5.22-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.22-beta
[1.5.21-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.21-beta
[1.5.20-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.20-beta
[1.5.19-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.19-beta
[1.5.18-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.18-beta
[1.5.17-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.17-beta
[1.5.16-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.16-beta
[1.5.15-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.15-beta
[1.5.14-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.14-beta
[1.5.13-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.13-beta
[1.5.12-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.12-beta
[1.5.11-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.11-beta
[1.5.10-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.10-beta
[1.5.9-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.9-beta
[1.5.8-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.8-beta
[1.5.7-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.7-beta
[1.5.6-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.6-beta
