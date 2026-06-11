# Changelog

All notable changes to TorrentHunt are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [1.8.6-beta] - 2026-06-11

### Changed
- **Reworked the About tab** (Settings → About) into something nicer to look at:
  an animated app header with a floating logo, version and tech badges, and quick
  actions (check for updates, set as default app, GitHub). The statistics below
  now count up and animate in, with subtle hover effects. Purely cosmetic.

## [1.8.5-beta] - 2026-06-10

### Added
- **Peers tab.** The torrent controls window now has a **Peers** tab showing who
  you're actually connected to, updated live: each peer's address, client
  (qBittorrent, µTorrent, Transmission, WebTorrent…), connection type, how much
  of the torrent they have, and the current up/down speed with them. Handy for
  seeing whether a torrent is healthy and where your bandwidth is going.

## [1.8.4-beta] - 2026-06-10

### Added
- **Automatic port forwarding (UPnP).** TorrentHunt now asks your router to forward its
  listening port, so other peers can connect **to you** — not just you to them. This
  noticeably improves download speed and peer count, especially on torrents with few
  seeds. It's on by default and self-heals (the mapping is renewed automatically), and
  Settings → Advanced shows a live status (mapped / no UPnP router / off) with the port.
  For a stable mapping across restarts, keep a fixed listening port.

## [1.8.3-beta] - 2026-06-10

### Added
- **Reworked Privacy & Anonymity tab with a live exposure dashboard.** The top of
  the page now shows, at a glance, what the swarm can actually see about you: your
  **public IP** (the one peers connect to, with reveal/hide + copy), your **ISP /
  network** and **location**, and your **VPN status**. A colour-coded posture
  banner sums it up — *Protected*, *Mostly protected*, or *Your real IP is exposed*.
- **IP-leak detection.** If your torrent-facing IP looks like a regular ISP instead
  of a VPN while no VPN is detected, the page warns you outright — so you catch a
  leak before you start downloading. (Lookups only run when you open the tab or hit
  Refresh; no background traffic.)
- **"Apply recommended" one-click privacy setup** — turns on the VPN kill-switch and
  startup check, sanitizes logs, and disables DHT to shrink your exposure.
- **Log controls** — open the logs folder or clear logs on the spot, plus DHT can now
  be toggled from the privacy tab as a discoverability lever.

## [1.8.2-beta] - 2026-06-10

### Fixed
- **Advanced settings now actually work.** DHT, max connections and the listening
  port are applied to the torrent engine on launch (they were saved but never used).
  The non-working Proxy section and the PEX/LSD toggles were removed — the engine
  doesn't support them, so they only gave a false impression of doing something.
- **Speed limits: "unlimited" no longer stalls traffic.** Removing a speed limit
  used to set the rate to 0 B/s instead of unlimited, freezing all transfers until
  the next restart.
- **Adding a magnet with no peers no longer hangs forever.** It now times out after
  two minutes with a clear error and can be retried.
- **Seed-ratio limit works.** Torrents finished during the current session now stop
  seeding at the configured ratio (the ratio was being read from stale counters).
- **"Stop seeding" really stops.** It now drops the torrent instead of a soft pause
  that left already-connected peers downloading from you.
- **Much faster startup.** The window opens immediately instead of waiting for all
  torrents to be re-verified on disk first (which could take a minute on a large
  library); verification now runs in the background.
- **Tray "Pause All / Resume All" work** (they previously did nothing), and there
  are matching buttons in the Downloads toolbar.
- **The app remembers its window size and position.**
- **RSS fixes.** Links with escaped characters (`&amp;`) download correctly; enabling
  a feed no longer grabs its entire back-catalogue at once; already-added items stop
  being retried on every check.
- **Scheduler** now handles time windows that cross midnight (e.g. 23:00–02:00).

### Security
- **Hardened the local streaming server** so a web page open in your browser can no
  longer read the file you're streaming (cross-origin and DNS-rebinding requests are
  now refused). Exported settings no longer contain your proxy password in clear text.

## [1.8.1-beta] - 2026-06-08

### Added
- **Subtitles in the built-in player.** A **CC** button lets you switch on embedded
  text subtitles (from mkv and similar) or external `.srt` / `.ass` / `.vtt` files
  sitting next to the video. Tracks are converted to WebVTT on the fly with ffmpeg
  and overlaid on playback; pick a language or turn them off. (Subtitle support for
  Cast/TV is a follow-up.)

## [1.8.0-beta] - 2026-06-08

### Added
- **Cast to TV (Chromecast / Android TV).** The player's "Watch on another device"
  panel has a new **TV** tab that finds Chromecast / Android TV / Google TV devices
  on your Wi-Fi and plays the torrent on the big screen in one click, with
  pause / resume / stop controls. The TV pulls the stream straight from your PC
  (H.264/AAC MP4 for browser-friendly files, HLS for everything else — transcoded
  on the fly), so there's nothing to install on the TV and no cloud involved.

## [1.7.3-beta] - 2026-06-08

### Changed
- **Downloads: content-type icons.** Each row now shows an icon for its kind —
  film, game, music, archive, disc image, app, picture or document (from the file
  extension, falling back to the torrent's category) — so the list is scannable at
  a glance.
- **Removed the duplicate sort header.** The sortable column row (Name/Progress/
  Speed/Added) duplicated the always-visible "Sort by" bar, so it's gone; sorting
  now lives in one place and works in both compact and expanded views.

## [1.7.2-beta] - 2026-06-08

### Fixed
- **Progress bars now actually show (and are coloured) everywhere.** A class-name
  mismatch in the ProgressBar component made every progress bar render as a flat
  grey line with no fill — across Downloads and Create Torrent. They now show a
  proper track + coloured fill (green when complete, accent while downloading).

### Changed
- **Downloads expanded card looks cleaner.** The stats dropped the awkward
  outlined "pills" for tidy label-over-value columns inside one subtle panel, the
  percentage is smaller, and the layout is tighter.

## [1.7.1-beta] - 2026-06-08

### Changed
- **Downloads: expand one torrent at a time (accordion).** Click a torrent (or its
  chevron) to expand just that row to full details; the rest stay compact. The
  default view is now compact instead of everything expanded at once.
- **Downloads: tighter, cleaner list.** The expanded card dropped the oversized
  percentage and boxy stat cells for compact inline stat pills with less padding;
  each row now has a status-colored accent stripe (downloading/seeding/paused/
  error), the row actions are visible (not hidden until hover), and the inline
  progress bar is wider.

### Fixed
- **Cast panel QR no longer gets clipped** on shorter windows (the panel now
  floats with its own scroll).

## [1.7.0-beta] - 2026-06-07

### Added
- **Watch anywhere — stream a torrent to a device outside your network
  (experimental).** The player's "Watch on another device" panel now has two
  tabs: **Same Wi-Fi** (the existing LAN cast) and **Anywhere**. "Anywhere" gives
  a public link + QR that plays the video on any device on any network — even
  mobile data — by transcoding to H.264 on your PC and streaming it peer-to-peer
  over WebRTC (the receiver plays it via MediaSource). No install on the other
  side, no cloud. Keep TorrentHunt open while they watch; seeking is limited in
  this mode. Marked experimental while it gets real-world testing across networks.

## [1.6.3-beta] - 2026-06-07

### Fixed
- **Cast: AVI (and other old formats) now play on other devices.** AVI/WMV/FLV/MPG
  and similar containers have irregular timestamps that broke the seek-friendly
  HLS transcode (mp4/mkv were unaffected). They're now streamed as a single-pass
  MP4 that plays reliably (seeking limited for these formats). Also added an 8s
  watchdog: if HLS shows no picture on any file, the player automatically switches
  to the MP4 stream.

## [1.6.2-beta] - 2026-06-07

### Fixed
- **Cast (Watch on another device): transcoded formats now play reliably.** The
  player library (hls.js) is now served locally from your PC instead of a CDN, so
  the receiving device no longer needs Internet access to start an mkv/avi/HEVC
  stream — the #1 reason those formats showed nothing. Added an automatic
  single-pass MP4 fallback: if HLS can't play a particular file on a device, the
  player switches to a plain transcoded stream that "just works" (seeking limited).

## [1.6.1-beta] - 2026-06-07

### Fixed
- **Create Torrent: subfolders no longer collapse.** When you excluded any file (or
  picked multiple sources), the created torrent flattened every file to the root —
  subfolders disappeared and same-named files in different folders collided. The
  included files are now staged with their folder structure intact (via instant
  hardlinks, no data copied) before hashing.
- **Create Torrent: fewer hangs.** Symlinked folders are no longer followed (which
  could loop forever), and an unreadable/locked/offline (OneDrive) file now fails
  with a clear message naming the file instead of hanging until the timeout.
- **Rooms: "connected" count was wrong.** It showed the number of WebRTC wires
  (several per peer, one per tracker) instead of people — now it counts distinct
  online members.
- **Rooms: name changes propagate live.** Changing your room nickname now updates
  for other members immediately, without rejoining.
- **Rooms: open shared archives.** A shared `.zip`/`.rar`/`.7z` could be locked by
  the app while it was being seeded. Each file now has an **Open** button that
  stops sharing just that file so it unlocks, then opens it (other members keep
  their copy).

## [1.6.0-beta] - 2026-06-07

### Added
- **Watch a torrent on any device on your network.** The in-app player now has a
  **"Watch on another device"** button that shows a QR code and link. Open it on a
  phone, tablet or TV on the same Wi-Fi and the video plays — **with seeking** —
  even for formats the browser can't normally decode (mkv, HEVC, AVI…), because
  the desktop transcodes to **HLS on the fly** (two quality levels, adaptive).
  Browser-friendly files (mp4/webm) are streamed directly with native seeking and
  zero extra CPU. No app to install on the other device, no cloud — the stream is
  served straight from your PC over the local network (the link carries a
  single-use access token).

### Fixed
- **Share links now explain when a movie can't preview in the browser.** Receiving
  a shared `.mkv`/HEVC file used to silently fail to play. The receiver page now
  recognizes more formats, surfaces a clear message when the browser can't decode
  the codec, and points you to Download or to "Watch on another device" on the
  same Wi-Fi for a converted stream.

## [1.5.25-beta] - 2026-06-06

### Added
- **Rooms — private friend swarms (Phase 3).** A new **Rooms** tab (sidebar) lets
  you create a private group, share a speakable invite **code**
  (e.g. `swift-amber-otter-comet-4821`) or QR, and have everyone's files
  auto-distribute peer-to-peer into a shared folder — like a private Dropbox with
  no cloud in the middle. Members find each other over the same WebRTC + tracker
  (+ optional TURN) infrastructure as share links; the manifest and presence are
  exchanged over **AES-256-GCM-encrypted** channels with the key derived from the
  invite code, so only people with the code can read or join. Each member is shown
  with a unique, auto-generated **identicon avatar** and an online indicator, plus
  a live "who has what" view per file. Files you add are seeded from disk; files
  others add download automatically with progress. Rooms persist and reconnect on
  startup. Honors the existing "Use TURN relays" privacy toggle.

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

[1.8.1-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.8.1-beta
[1.8.0-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.8.0-beta
[1.7.3-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.7.3-beta
[1.7.2-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.7.2-beta
[1.7.1-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.7.1-beta
[1.7.0-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.7.0-beta
[1.6.3-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.6.3-beta
[1.6.2-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.6.2-beta
[1.6.1-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.6.1-beta
[1.6.0-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.6.0-beta
[1.5.25-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.25-beta
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
