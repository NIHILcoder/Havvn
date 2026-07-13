# Changelog

All notable changes to Havvn (formerly TorrentHunt) are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [2.12.0] - 2026-07-13

Rooms get folders. The shared file list — until now a single flat pile — can be
organized into named, colored sections, so a room full of movies, music and
everything else finally has structure.

### Added
- **Folders in rooms** (Rooms → a room's file list): create named sections with
  an icon and color and drop files into them. A room with no folders looks
  exactly as before — sections appear only once you make one.
  - Add files straight into a section with its own "+", or drag a file between
    sections to move it; a per-file "move to folder" menu does the same without
    dragging. Files you don't sort land in **Uncategorized**.
  - Sharing a multi-file torrent from Transfers automatically creates a folder
    named after it and drops its files in.
  - Any member can create and organize folders; changes sync to everyone in the
    room over the same encrypted peer-to-peer channel as the files themselves.
    Members on an older build simply keep seeing the flat list — nothing breaks.

### Fixed
- Deleting a folder moves its files to Uncategorized and never touches the files
  themselves; the folder set converges cleanly across members (last edit wins)
  and survives restarts.

### Internal
- Folder convergence, grouping and the icon allow-list are a pure, unit-tested
  module; a peer-supplied icon can no longer crash the Rooms page (suite grows
  to 203 tests). Timestamps from peers are clamped so a skewed clock can't
  freeze a folder or a file's placement.

## [2.11.0] - 2026-07-12

Privacy takes the spotlight: the native engine can be hard-bound to your VPN
so traffic physically cannot leak, magnets add themselves from the clipboard,
the app can shut the computer down when the queue finishes, and the player
learned series, audio tracks, playback speed and picture-in-picture. Also
shipping: the desktop polish built right after 2.10 (taskbar progress, the
hotkeys editor and first-run onboarding).

### Added
- **Bind engine to VPN** (Settings → Privacy, native engine only): the
  download engine's peer sockets are bound to the VPN adapter's address, so
  if the VPN drops they die at the OS level the same instant — stronger than
  the kill-switch, which reacts after detection. No VPN at start means a
  fail-closed loopback bind with a clear warning; when the VPN address
  changes, the engine restarts and re-binds automatically (IPv6 is pinned
  shut while the feature is on). Applies on restart, like the engine picker.
- **Magnet links from the clipboard** (Settings → Downloads, off by default):
  copy a magnet anywhere and Havvn comes to the front with the add dialog —
  the same flow as double-clicking a .torrent file; nothing is added without
  confirmation. Only a hash of the last clipboard text is kept in memory, and
  a magnet already sitting in the clipboard never fires on enable or startup.
- **When downloads finish…** (Downloads toolbar and the tray menu): a
  one-shot sleep / shut down / quit action that fires once every download
  reaches a terminal state. Guard auto-pauses block it, new downloads during
  the countdown re-arm it, execution is preceded by a cancellable countdown
  (shutdown uses the OS 60-second timer), and the choice never survives a
  restart — the machine can't power off by surprise.
- **Serial mode in the player**: a playlist with episodes in natural order
  (season folders respected, duplicate names disambiguated), a Next-episode
  button, and auto-advance when an episode ends — each episode keeps its own
  resume position.
- **Audio track selection** for multi-audio releases: pick a language and the
  stream restarts with that track via on-the-fly conversion; the menu appears
  only when the file actually has a choice, and the pick carries across
  episodes.
- **Playback speed and picture-in-picture** in the player controls: presets
  from 0.5× to 2× that survive episode changes, and a PiP window that follows
  you across episodes where the platform allows. In watch-together rooms the
  playback speed now syncs to everyone.
- **Download progress on the taskbar icon**, a working **hotkeys editor**,
  and **first-run onboarding** — the post-2.10 desktop pack.

### Fixed
- A crash-respawned torrent engine silently lost the IP blocklist; it is now
  re-applied on every engine start.

### Internal
- The VPN-bind decision logic, the completion-action state machine, and the
  ffmpeg audio-stream probe are pure, unit-tested modules (suite: 148 → 186
  tests).

## [2.10.0] - 2026-07-12

Rooms come alive — a chat-first layout with typing indicators, file reactions
and member progress — and the player now remembers where you stopped. Under the
hood: a critical fix for upgrades from the TorrentHunt era, and releases are now
built by CI.

### Added
- **Chat-first rooms.** The room page is a true two-pane layout: files and
  activity scroll on the left while a full-height chat owns the right column —
  the composer never leaves the screen. Members collapse into an avatar strip
  in the chat header; click it for the full list (mute/kick intact).
- **Typing indicators.** "… is typing" appears above the composer, gossiped
  peer-to-peer with rate limiting — nothing is stored.
- **File reactions.** React to shared files with 🔥 👍 ❤️ 😂 — counters live on
  the file rows, your own reaction is highlighted, and late joiners receive the
  current picture. Hostile/unknown emoji are rejected at the protocol level.
- **Member progress.** File rows show who already has the file (overlapping
  avatars) and an ember progress ring around members currently downloading it.
- **Room identity export / import** (Settings → Sharing): save your signing
  key, profile and joined-rooms list to a file and restore them after a
  reinstall — losing the install no longer means losing your rooms.
- **The player remembers your position.** Reopen an unfinished film and it
  resumes with a quiet "Resuming from 1:23:45"; a film watched to the end
  starts fresh. Keyed by torrent hash, so it survives remove and re-add.
- **Update channel** (Settings → System): stable or beta — stable users can
  now opt into prereleases, and beta installs are no longer pinned to them.

### Fixed
- **Upgrades from TorrentHunt lost the profile.** The legacy profile migration
  (downloads list, room identity keys, settings) had never actually run due to
  an initialization-order bug — it failed silently on every launch. It now
  runs, verified against a real legacy profile.
- Room chat no longer sinks below the window on long sessions; holder avatars
  align with the reactions; the avatar ring is no longer clipped by the
  members panel or the chip edge.

### Internal
- Releases are built by CI: pushing a version tag type-checks, runs the full
  test suite, builds the installer and portable zip, and opens a draft release
  with notes from this changelog. The CI pipeline now fails on test failures.
- Dev mode actually loads the dev server now (NODE_ENV was never set), and
  DevTools no longer auto-open.

## [2.9.1] - 2026-07-11

A polish release on top of 2.9.0: the VPN warning finally lives inside the app,
the tray got live speeds, rooms got quality-of-life upgrades, and the brand mark
was unified.

### Added
- **Live tray.** The tray tooltip and menu header now show current download/upload
  speeds and the number of active downloads, plus a new "Open downloads folder" item.
- **Rooms: drag & drop.** Drop files onto an open room to share them (with an ember
  drop overlay); a client-side file filter appears for rooms with many files; quiet
  presence toasts ("… is online", "… is sharing") with dedupe and no join spam.
- **Animated brand mark.** The sidebar Double-V draws itself in on launch and re-draws
  on hover; the lockup is centered. Fully disabled by the "reduce animations" preference.

### Changed
- **The startup VPN warning is now an in-app dialog** in the app's own style instead
  of a native message box.
- **About statistics** rebuilt as flat stat tiles matching the settings system.
- **Notifications moved to the bottom-right corner** — they no longer cover the
  page-header buttons on Downloads and Rooms.
- **The brand mark lost its orange node dot everywhere** (app, splash, web pages,
  installer artwork, repository assets) — it had never made it into the app icon, so
  the mark read inconsistently across surfaces.
- Settings: more breathing room between nav tabs and around custom blocks inside cards.

### Fixed
- **"Don't show again" on the VPN warning never worked** — the old native dialog
  ignored the button entirely. It persists now, and only via an explicit click:
  closing the dialog with Escape doesn't silence a security warning forever.
- **The Privacy "VPN Detection" toggle now actually gates the startup check** — the
  warning used to fire even with the toggle off; a dead, unreachable
  privacy:showVPNWarning IPC channel was removed.
- **Room chat no longer sinks below the fold on long sessions** — the members+chat
  column is pinned while the main column scrolls, members scroll internally, and the
  composer stays on screen.

## [2.9.0] - 2026-07-10

Havvn now speaks Russian everywhere — including the tray, native dialogs and the
installer — Settings was rebuilt from the ground up, and the app finally ships a
portable ZIP alongside a branded installer.

### Added
- **Full interface localization (RU/EN).** Every window, form and toast is translated —
  including the parts React can't reach: the tray menu, native file dialogs, OS
  notifications and the application menu all follow the language switch live.
- **Settings search.** A search box above the settings nav finds any setting by name or
  keyword, in both languages.
- **A scheduler that actually does something.** Schedule windows now expose the speed
  limit the engine applies (they silently did nothing before), show a live
  "limit active" status, and render a week-at-a-glance strip of your windows.
- **Interface preferences.** UI scale (90–125%), speed units (binary/decimal KB/s or
  Mbit/s, applied app-wide), start page (Transfers or Rooms), reduced motion, and a
  compact density mode for settings.
- **Seeding at a glance.** The Seeding tab shows live stats: active seeds, total
  uploaded, and your overall ratio.
- **Portable ZIP distribution.** `Havvn-x.y.z-win-portable.zip` — unpack and run, no
  installer needed; ships the native engine inside and shares its data with installed
  copies, so switching between the two loses nothing.
- **Branded installer.** The NSIS installer got the Double-V treatment (graphite
  welcome/finish sidebar, ember mark) and now installs in Russian or English,
  following the system language.

### Changed
- **Settings rebuilt on a modular Ember system.** The 1900-line monolith is now a thin
  shell over per-tab components with one shared row/card/toggle system — labels and
  controls no longer collide, toggles line up in a clean column, and rows stack
  gracefully on narrow windows. The IA was regrouped: Network split into
  **Connection** (absorbing Advanced: DHT, µTP, ports, UPnP) and **Sharing** (web
  remote, TURN relay, network profiles), with DNS-over-HTTPS moving under Privacy.
- **Privacy tab rebuilt.** A live exposure dashboard with an honest protection verdict
  replaced the old synthetic privacy score; every control is wired to real state.
- **The browser receive page** (share links) was redesigned on the Ember system, and
  per-file **Download buttons now appear only once the file has fully arrived** —
  until then each row shows its live progress.
- **About page** is now a clean identity page (version, session engine, license,
  source); update and default-client actions live only under System.
- Dropdown selects open upward near the bottom edge instead of getting clipped.

### Fixed
- **Downloads page crash** — "torrent host exited before ready": importing the
  main-process i18n from the torrent host's utility process pulled in Electron APIs
  that don't exist there. The host boots reliably again.
- **Scheduler day chips were off by one** — a window created for Monday actually
  fired on Sunday. Existing schedules were unaffected in practice (they had no
  speed limit and thus never fired).
- **UI scale no longer clips the window** — scaling switched from CSS zoom (which
  fought the full-viewport layout, cutting content above 100% and leaving dead bands
  below) to Electron's native page zoom.
- Privacy DHT toggle kept the Connection tab in sync; a failed IP lookup no longer
  leaves the exposure check spinning forever; save failures surface a toast instead
  of dying silently.
- The custom TURN relay form no longer overflows its card.
- The About page's GitHub link pointed at the pre-rebrand repository.

## [2.8.0] - 2026-07-09

The big one: **TorrentHunt is now Havvn**, the download engine was rebuilt, the whole
interface was redesigned around two pillars, and rooms grew into a place you actually
*use together* — watch and listen in sync, end-to-end encrypted for real this time.

### Rebrand
- **TorrentHunt → Havvn.** New name, new Double-V logomark, new "Ember" look (warm accents
  on a graphite ground). Your existing profile, downloads and rooms migrate automatically;
  the update feed still reaches installs from the old name.

### Engine
- **New default torrent engine.** Transfers now run on a bundled native **Transmission**
  daemon instead of WebTorrent, with WebTorrent kept as a selectable fallback (Settings →
  Engine). Rooms and share links still use WebRTC/WebTorrent. Feature parity across the
  board: streaming, subtitles, the swarm map, tracker editing, seed-from-folder, the IP
  blocklist, and magnet metadata preview all work on the native engine.

### Added
- **Watch & listen together.** Open a shared room file in the in-app theater and turn on
  **"together"** — play/pause/seek stay in sync across the room and late joiners snap to the
  current position.
- **Music mode for rooms.** Audio files get a dedicated stage: album art pulled from the
  track's **ID3 tags**, a live **WebAudio spectrum**, a shared queue that auto-advances, an
  **Ember player** bar (scrubber, volume, fullscreen, keyboard controls) replacing the bare
  Chromium one, and floating emoji reactions.
- **End-to-end encrypted rooms that actually transfer.** Files are encrypted on disk before
  seeding and decrypted after download — **ciphertext only on the wire**. The content key
  travels in an **owner-signed config (Ed25519)** so a member who only holds the invite code
  can't plant, forge, tamper with, or replay one, and the invite code marks the room
  encrypted so a joiner never seeds plaintext by mistake.
- **Per-room download & speed controls.** Auto-download every shared file or pull them
  manually per file, plus per-room upload/download speed limits.
- **Two-pillar navigation.** A **Transfers | Rooms** switch splits downloading from
  shared-listening, bridged by a persistent status strip (live speed/peers and who's
  listening now), with **Share to room** / **Bring a file from Transfers** cross-links.

### Fixed
- **E2E rooms now work at all.** The encrypted-file seeder used a filename the torrent store
  couldn't read back, so an E2E share connected but moved zero bytes — fixed, along with an
  E2E-flag flap over gossip and same-named files clobbering each other's ciphertext.
- **Deleting then re-sharing a file brings it back.** Room tombstones are timestamped, so an
  explicit re-share wins over an earlier deletion (a stale copy no longer resurrects it).
- **Room activity credits the right person.** Gossiped file additions kept the sharer's
  name instead of showing "added by ?".
- **Custom-named seeds work on the native engine** (the on-disk name is mapped correctly).

### Security
- Room E2E config is authenticated end to end (owner-signed, topic-bound, re-verified on
  restart and rekey) — the invite code alone can no longer be used to poison another
  member's content key.

## [2.7.0] - 2026-07-05

A hardening + housekeeping release from a full product review. It makes the app
smaller and better-tested, not bigger: net −470 lines of code and the test suite
grew from 68 to 100.

### Security
- **Closed a path-traversal write in rooms.** A room member (with only the room
  code) could send a file named `..\..\evil.exe` and have it written outside the
  shared room folder — an arbitrary-file-write. Peer-supplied file names are now
  reduced to a bare basename before any write.

### Fixed / Performance
- **No more constant disk writes while idle.** The downloads store was being
  rewritten every 5 seconds the whole time the app was open — even with nothing
  downloading. It now writes only when real progress changes, so a laptop sitting
  on completed/seeding torrents stops churning the SSD.
- **Smoother list.** The downloads list no longer rebuilds and re-sorts every row
  ~1.3×/second; live numbers still update, but the UI does far less work.

### Changed
- **Removed the per-torrent speed limit control.** The underlying engine only
  supports a global speed limit, so a per-torrent value never actually applied —
  the control was removed rather than left as a setting that does nothing. Use the
  global / alternative-speed limits in Settings.
- **Removed an unused Catalog screen** that was never reachable in the UI.
- **More of the app is translated** — the VPN/low-disk safety banners and the
  add-torrent file picker are now localized (they were English-only).

### Internal
- Extracted the engine's trickiest correctness logic (magnet infoHash
  normalization, seed-limit decisions, startup restore planning) into small pure
  modules with unit tests, so the bugs fixed in 2.6.x can't silently return.

## [2.6.3] - 2026-07-05

### Fixed
- **Pausing an in-progress download no longer falsely marks it "completed".**
  Pausing works by telling the engine to stop wanting pieces; if a piece finished
  in the exact moment you hit pause, WebTorrent interpreted "nothing left wanted"
  as "done" and the app flipped the half-finished torrent to seeding/100% (and
  fired a "download complete" notification). Pause now settles the state before
  halting, with a second guard so a paused partial download can never be reported
  complete. Pinned by a new real-wire regression test.

## [2.6.2] - 2026-07-05

A large stability release: a multi-agent audit of the whole download engine
surfaced 28 verified bugs, all fixed here (plus 4 regressions caught and fixed by
an adversarial self-review). Typecheck, all 67 tests, and lint are green.

### Fixed
- **App no longer hangs on startup if the torrent engine's background process
  dies before it's ready.** The readiness handshake had no failure path, so a
  crash during engine init froze the whole app on a blank-looking window with no
  error. It now fails fast and recovers.
- **Duplicate detection works again across the process boundary.** Engine error
  codes (e.g. "already in downloads") were being stripped when crossing to the
  main process, so RSS auto-download retried the same item forever and the watch
  folder logged every duplicate as an error. Codes are now preserved.
- **Pause/Resume respects the concurrent-download limit.** Resuming a paused
  torrent (or "Resume All") could blow past your max-active-downloads setting and
  run everything at once; it now re-queues correctly.
- **Force Recheck no longer misbehaves.** Rechecking a finished torrent used to
  re-fire the "download complete" notification and reset the seed-time-limit
  clock (so the limit never triggered); rechecking a stopped torrent silently
  started it seeding again. Both fixed.
- **Lifetime "downloaded" total no longer doubles** on every restart / recheck /
  auto-move (it was counting already-on-disk data as freshly downloaded, which
  also halved your share ratio).
- **Removing a torrent while casting/streaming no longer leaves files undeletable
  on Windows** (the transcoder kept the file open) or orphaned background
  processes running.
- **"Delete files" is safer** — a "start seeding" entry with a custom name now
  deletes the real files instead of possibly missing them or hitting an unrelated
  folder.
- **Per-file priority (Low/Normal/High) now actually affects download order**
  instead of being visual-only.
- **Closing the player reverts instant-play mode** — the torrent no longer stays
  stuck in forced-sequential order, and a previewed "skipped" file no longer
  keeps downloading.
- **Disk-space guard** now checks every drive your torrents write to (not just
  the default folder) and correctly clears its warning once space is recovered.
- **Add-time disk check** rejects a torrent up front when its known size won't
  fit, instead of failing mid-download.
- Numerous smaller fixes: streaming servers no longer leak on rapid opens, stats
  no longer read a torrent mid-removal, completion progress is persisted
  immediately, queued rows no longer show a stray separator, and context-menu
  Pause/Resume no longer error on states where they don't apply.

### Known limitations
- **Per-torrent speed limits are stored but not enforced.** The engine
  (WebTorrent 1.9.7) only supports a global speed limit; the previous per-torrent
  calls were a silent no-op. This release stops pretending they apply — a future
  release will either wire real per-torrent throttling or remove the control.

## [2.6.1] - 2026-07-02

### Fixed
- **Pause now truly stops downloading.** Root cause finally found and pinned by
  a regression test against real peer connections: WebTorrent accumulates
  duplicate piece-selections (every select call adds one; the app selects on
  ready, on resume, and on stream-open), and deselect removes only one matching
  entry — leftovers kept the torrent downloading no matter how it was "paused".
  Pause now clears the selection list outright; peers stay connected and resume
  is instant, but bytes stop flowing immediately.
- **Swarm map is no longer empty.** Peer addresses carry a port ("1.2.3.4:6881"),
  and the map's geo filter mistook everything containing ":" for IPv6 — every
  single peer was discarded before lookup. The map now actually lights up.
- **Returning to the Downloads tab no longer flashes "no peers"** on active
  rows: the last stats snapshot survives tab switches.
- **Adding a torrent no longer freezes the dialog or produces a stuck
  "Loading..." twin.** Add confirms instantly (magnet metadata resolves in the
  background), a second click can't fire a duplicate add anymore, and re-adding
  a torrent whose earlier attempt failed retries the existing entry instead of
  creating a second row over the same torrent (which is what made deleting one
  appear to delete both).

## [2.6.0] - 2026-07-01

### Added
- **Instant-play streaming ("zero-wait").** Hitting Watch on a file now starts
  playback almost immediately instead of waiting on the download: the engine
  prioritizes the head of the file you're watching, requests the very first
  pieces from every peer at once, and fills the buffer in playback order — so a
  movie in a large, barely-started torrent plays in seconds. When you stop
  watching, the torrent goes back to normal rarest-first downloading.
- **One-click Watch / Listen.** Media downloads now show a Watch (or Listen)
  button right on the row — previously the player was only reachable from the
  right-click menu.
- **Live swarm world map.** A new **Swarm** tab draws every peer you're connected
  to on a real world map, grouped by country, with glowing nodes sized by how
  many peers are there and arcs streaming toward your location. Peer locations
  are resolved entirely offline on your machine — no peer address is ever sent
  anywhere or shown in the app.

## [2.5.0] - 2026-06-29

### Fixed
- **Pausing a download no longer drops your peers or corrupts the swarm.**
  Pause used to fully tear down and recreate the torrent, which dropped peers from
  dozens down to a handful on resume, forced a complete on-disk re-verify of
  everything already downloaded, and produced visibly distorted progress/size/speed
  numbers on every stop/resume — reported as "health went from normal to weak after
  resume", "downloads in bursts", and "can't reach 100%". Pausing an in-progress
  download now keeps the torrent and its peer connections alive and simply stops it
  from wanting new pieces; resuming just wants pieces again — no re-add, no re-hash,
  no peer loss. (A finished/seeding torrent still fully releases its file handle on
  pause, same as before, so a just-finished archive that says "in use" opens fine
  once paused.)
- Fixed a related correctness bug where every resume was internally treated as a
  brand-new download, which could re-stamp a torrent's reported size from a
  transient mid-reattach reading.

### Added
- **Cinema mode for watch-together.** The room player gained a proper theater
  layout — video on one side, a sidebar with who's watching and the room's live
  chat on the other, so you can talk without leaving the player — plus floating
  emoji reactions everyone in the session can see in real time.

## [2.4.1] - 2026-06-27

A maintenance release — a security hardening for rooms plus internal cleanup. No
user-facing feature changes.

### Security
- **Room gossip is now bounded and validated on the way in.** A malicious room member
  could previously send oversized or malformed gossip to exhaust memory — and the new
  peer-relay would re-flood it. Inbound frames are now size-capped *before* they are
  decrypted, and the decoded fields (names, ids, file lists, chat text) are clamped to
  sane limits, so the mesh can't be used to amplify a bad payload. Normal traffic is
  unaffected.

### Changed
- Internal cleanup with no behaviour change: several **Settings** sections were
  extracted into their own components, dead code was removed, and **eight unused
  dependencies were dropped** (smaller install and a smaller supply-chain surface).

## [2.4.0] - 2026-06-27

The rooms ("friend swarms") release: talk, personalise, and connect across more
networks — all peer-to-peer, end-to-end encrypted, with no servers to pay for.

### Added
- **In-room chat.** Every room now has real-time text chat that rides the same
  encrypted channel as the rest of the room. Messages are **signed with a per-device
  key and bound to a member identity**, so even someone who has the invite code can't
  post as another member; the chat history is **encrypted at rest** on your disk.
- **Pick your avatar.** Your room profile can choose from several distinct avatar
  styles (mirror, grid, rings, bauhaus) instead of a single fixed one. Avatars are
  still generated on your device from a seed — nothing is ever uploaded.
- **Peer-relay — rooms work across more networks, still with zero servers.** Two
  members who can't reach each other directly (strict NAT) now connect **through any
  other member who can reach both**, automatically. The relayed traffic stays
  end-to-end encrypted, so the relaying member only ever forwards ciphertext.
- **Bring-your-own TURN relay (optional).** For the rare case where both sides are
  behind strict NAT and no member can relay, you can point the app at a TURN server
  you trust (a free Cloudflare/metered tier or your own) in **Settings → Network →
  Sharing**. One side configuring it is enough; the password is stored encrypted.
- **Connection indicator.** Each member shows whether they're connected directly or
  reached via a relay.

### Changed
- **Sturdier connectivity, less noise.** WebRTC ICE servers and rendezvous trackers
  now come from a single shared list across rooms, share links and casting, with a
  few extra STUN endpoints. The defunct bundled TURN relay (which only produced
  "connection timed out" log spam) was removed in favour of the ladder above.

### Fixed
- **Room avatars no longer appear cropped** when the same avatar is shown at more
  than one size at once (e.g. the header chip and the member grid).

### Security
- Rooms gain a per-install **Ed25519 signing identity** (private key encrypted at
  rest). Chat messages are signed and verified with trust-on-first-use identity
  binding, and the message log is encrypted on disk.

## [2.3.2] - 2026-06-25

### Fixed
- **RuTracker plugin showed the forum name instead of the torrent title.**
  RuTracker puts `data-topic_id` on the row, so the parser grabbed the row's first
  link (the forum) as the title (with the `√`/`*` status leaking in). Titles are
  now read from the topic link (`viewtopic.php?t=…`) with HTML entities decoded;
  the forum stays as the category. (Update your local `rutracker.py` copy.)
- **Add-torrent errors no longer show Electron IPC noise** — the raw "Error
  invoking remote method 'downloads:add'…" wrapper is stripped to just the message.

## [2.3.1] - 2026-06-25

### Fixed
- **Clear error when adding a duplicate torrent.** Re-adding a torrent the engine
  already has used to surface as a raw `downloads:add` failure; it now shows a
  plain "This torrent is already in your downloads." — including magnets whose
  infoHash can't be pre-read and torrents the engine still held after a removal.
- **Window icon re-asserted** from a loaded image (taskbar/thumbnail robustness).

## [2.3.0] - 2026-06-24

### Added
- **RuTracker search (via a bundled plugin) + provider logins.** Search providers
  now have optional **Login / Password** fields (stored encrypted, like the API
  key) that are passed securely to script plugins as `TH_USERNAME` / `TH_PASSWORD`
  — so account-gated indexers work while scraping stays in userland. Ships a
  ready-made `docs/search-plugins/rutracker.py` (stdlib-only: login, .org/.net/.nl
  mirrors, a `cookie:<bb_session>` captcha fallback, concurrent magnet fetch). Add
  a "Python Script" provider pointing at it, enter your RuTracker login, and search.
- **Wider peer acquisition.** A single active torrent is no longer capped at ~55
  peers (per-torrent ceiling raised to 100, global budget to 300 — safe because
  slow-start + adaptive throttle still protect the router). Magnet links now also
  get a larger curated default-tracker list unioned in (never `.torrent` files,
  which may be from a private tracker). Plus an **experimental µTP transport**
  toggle (Settings → Advanced) to reach µTP-only peers TCP misses — default off on
  Windows, recovered safely by the auto-restarting engine if the native module
  misbehaves.
- **Smart network profiles.** Opt-in (Settings → Network → Smart network profiles):
  TorrentHunt detects which network you're on — keyed by the router (gateway MAC,
  so it works on Wi-Fi *and* Ethernet) — and automatically applies that network's
  settings overlay: speed limits, connection cap, adaptive throttle, DoH. e.g.
  "Home → full speed; phone hotspot → 200 KB/s + DoH on". The overlay is live and
  non-destructive — leaving the network restores your base settings. Save the
  current network as a profile in one click, then tick which settings to override.
  No mainstream client does per-network automation.
- **DNS-over-HTTPS for the torrent engine.** Opt-in (Settings → Network →
  DNS-over-HTTPS): resolve tracker/peer hostnames through an encrypted DoH
  resolver instead of the OS/router DNS. Survives a broken or overloaded router
  resolver (built-in presets use direct-IP endpoints, so reaching them needs no
  DNS at all) and hides which trackers you contact from the ISP. Ships Cloudflare,
  Cloudflare-malware-blocking and Google presets, with a picker, a per-resolver
  Test button, and **custom resolver templates** you can add and remove.

### Rooms (experimental)
- Local two-instance testing via `TH_INSTANCE` (isolated profile, no single-
  instance lock); fixed a self-connection phantom member; a kicked member now
  gets an explicit "you were removed" banner; leaving broadcasts so peers drop
  you immediately (no offline ghost); clearer four-state connection indicator.

## [2.2.0] - 2026-06-22

### Added
- **Adaptive upload throttle ("protect my internet").** Opt-in mode (Settings →
  Network → Smart upload limit) that watches WAN latency and automatically lowers
  the upload rate the moment seeding starts choking the rest of your connection,
  then speeds back up when the line is clear — an AIMD control loop, so no manual
  KB/s tuning is ever needed. Solves the classic "torrents kill my whole internet"
  bufferbloat problem that fixed caps in other clients don't. A live indicator
  shows the current latency vs its unloaded baseline, the cap it has settled on,
  and the upload rate — so you can watch it adapt in real time.
- **Connection slow-start.** The per-torrent connection ceiling now ramps up from
  a low floor over the first ~45s instead of opening a burst of sockets the instant
  torrents go live, which floods cheap routers' NAT tables on startup. Always on.

### Fixed
- **VPN detection no longer inverted.** `ipMismatch` was always true behind a home
  NAT (local `192.168.x.x` ≠ public IP), so the privacy dashboard reported "VPN
  active" with no VPN and "exposed" with one running. Detection now relies on
  interface/DNS/route signals plus an ISP-org fallback for VPNs on non-standard
  interfaces (IKEv2/SSTP).

## [2.1.0] - 2026-06-17

### Added
- **Python script search providers.** Alongside Jackett / Torznab / Custom JSON,
  you can now add a **Python Script** provider: point it at a local `.py` plugin
  and TorrentHunt runs it to fetch results — no Jackett/Prowlarr server required.
  The app auto-detects your system Python 3 (nothing is bundled) and shows a live
  status pill; pick the script with a **Browse…** file picker.
- **qBittorrent plugin compatibility.** A bundled adapter
  (`docs/search-plugins/qbittorrent_adapter.py`) provides the `novaprinter` /
  `helpers` shims existing qBittorrent (nova3) search plugins expect, so the large
  community plugin ecosystem works through the script provider.
- **Plugin docs + example** under `docs/search-plugins/` (contract, runnable
  template, adapter) and first unit tests for the result sanitizer.

### Security
- Script output is treated as untrusted: every field is coerced and length-capped,
  the row count is bounded, and only `magnet:` / `http(s)` links are accepted
  (so `file://`, `javascript:`, `data:` results are dropped). Scripts run via
  `execFile` (no shell), with stdin closed and hard timeout + output caps.

## [2.0.1] - 2026-06-17

### Added
- **Downloads page fully localized** — all row text, status labels (Downloading,
  Seeding, Queued, Paused, Error, Completed), and health-indicator badges
  (Excellent, Good, Poor) are now translated in both English and Russian.

## [2.0.0-beta] - 2026-06-16

A big architectural release. The torrent engine was moved off the main thread, the
private-room feature set grew, startup got faster and smoother, and the app gained
its first automated tests. Major version bump to reflect the scope — much of the
internals changed. The private-room features remain **experimental** (not yet
verified across two machines).

### Changed
- **The torrent engine now runs in a separate process.** WebTorrent + the download
  manager + the in-app stream / transcode / cast servers moved into an Electron
  utilityProcess. Hash-checking and piece I/O no longer run on the UI thread, so
  **adding, restoring, or creating a torrent no longer freezes the window**. The
  main process keeps a thin proxy with the same API; file bytes never cross the
  process boundary (local HTTP + shared disk only).

### Added
- **Animated startup splash** in the app's black-and-white theme, shown until the
  UI has its data so the app opens ready instead of building up piece by piece.
- **Private rooms grew up (experimental):** rooms learn their real name from peers
  (no more raw invite code); shared files survive a restart; an owner role +
  activity log + locally hiding a member; remove a member (rotates the invite code
  so they can't rejoin); and opt-in **end-to-end encrypted rooms** (file contents
  encrypted before sharing).
- **First automated tests** (Vitest) covering the state machine, the room
  encryption, and IP-range matching.

### Fixed
- **Torrents no longer hammer your whole connection.** A global connection cap
  (default 200 across all torrents) replaces the old per-torrent 100, so torrents
  stop flooding the router / saturating sockets — which had degraded VPN/proxy and
  could crash the engine under load.
- **No startup disk thrash** with several torrents (restore honours the
  active-download limit instead of starting everything at once).
- **The drop-zone overlay** no longer gets stuck covering the UI.
- **Download rows line up cleanly** regardless of state, and a queued torrent no
  longer shows both Pause and Resume.
- The app now renders in its **Inter font in production** (it was bundled instead
  of loaded from a CDN the production CSP blocked).
- Faster cold start: page components are **code-split / lazy-loaded** (initial
  bundle roughly halved).

## [1.9.4-beta] - 2026-06-14

A performance fix plus a wave of **experimental** private-room features. The
rooms work is opt-in and not yet verified across two real machines — treat it as
a preview.

### Fixed
- **No more startup disk thrash with several torrents.** On launch every torrent
  was brought live at once, so they all hash-checked their data simultaneously —
  heavy disk load and UI lag. Restore now honours your max-active-downloads limit
  (seeding doesn't count); the rest queue up and start as slots free.

### Added (experimental — private rooms)
- **Room names sync automatically.** Joining by code now learns the room's real
  name from peers instead of showing the raw invite code.
- **Files survive a restart.** A room remembers its shared files and re-seeds them
  on launch, including files you shared from outside the room folder.
- **Owner role, activity log, and hiding members.** The creator owns the room;
  there's an activity feed (joins, shares, removals), and you can locally hide a
  member so their shares are ignored on your device.
- **Remove a member (owner only).** Rotates the room's invite code to everyone
  except the removed member, so they can't rejoin with the old one.
- **End-to-end encrypted rooms (opt-in).** Turn on encryption when creating a room
  and file contents are encrypted with a room key before sharing — the swarm only
  ever carries ciphertext. Uses about twice the disk (encrypted + decrypted copy).

## [1.9.3-beta] - 2026-06-13

A stability, performance and security release — lots of engine fixes, a major
runtime update, and a lighter, faster app.

### Fixed
- **Your share ratio no longer resets.** Upload/download totals used to reset to
  zero whenever a torrent was paused, rechecked, or the app restarted, so the
  ratio was wrong and seed-ratio limits often never triggered. They now persist
  correctly.
- **The IP blocklist actually filters peers now.** Incoming peers were silently
  never matched, overlapping ranges could be missed, compressed (`.gz`) lists
  failed to load, and torrents restored at startup were never filtered — all
  fixed.
- **Tracker status is real.** The Trackers tab always showed every tracker as
  "connected"; it now reports the true state (connected / updating / error) with
  live seeders and leechers per tracker and the last-announce time.
- **Add / remove tracker now works.** Those buttons did nothing before; you can
  now add or remove trackers and the change sticks across restarts.
- **Sequential download really downloads in order** instead of just pretending to.
- **Faster, more reliable startup.** Torrents are restored in parallel, so a
  single dead magnet link can no longer stall the whole app on launch.
- Adding a torrent no longer gets rejected just because another download happens
  to share the same name.
- Search results no longer show raw `&amp;`-style codes in titles.

### Changed
- **Updated to Electron 42** (from 28), which was end-of-life — this brings the
  latest Chromium security patches.
- **App data is now split into separate, readable files** (downloads, settings,
  RSS, blocklists, rooms…) instead of one big file. Saving download progress no
  longer rewrites your whole RSS history and blocklist every few seconds.
- **Lighter and faster UI.** The downloads list now stays smooth with hundreds of
  torrents, and interface translations load on demand, shrinking the app.
- The Trackers tab is now fully localized (including Russian).

## [1.9.2-beta] - 2026-06-11

### Fixed
- **Watching a file you shared in a room now works.** It previously said "this file
  is not fully downloaded yet" because a shared file is seeded from its original
  location, not the room folder; the player now finds it correctly.

### Added
- **Interactive cinema.** The room player now shows **who's watching the same file
  right now** — each member's avatar with a play / paused indicator, updated live.
- **Remove shared files from a room.** Each file has a delete button that removes it
  for everyone; downloaded copies are deleted, while the original a member shared
  from is left untouched. Removed files won't reappear (even after a restart or when
  an offline member reconnects).

## [1.9.1-beta] - 2026-06-11

### Added
- **Watch shared files inside a room — together.** In a room, downloaded media files
  now have a **Watch** button that plays them right in the app (with seeking; mkv / avi /
  HEVC are transcoded on the fly). Turn on **"Watch together"** and play / pause / seek
  stay in sync for everyone in the room — a private watch party over the same encrypted
  peer-to-peer channel the room already uses, no cloud involved.

## [1.9.0-beta] - 2026-06-11

### Added
- **Mobile web remote with streaming.** Control your downloads from your phone — and
  actually **watch or listen** to their files on it. Turn it on in **Settings → Network
  → Remote / mobile access**, scan the QR with a phone on the same Wi-Fi, and you get a
  clean mobile page: see every torrent, pause / resume / recheck / remove, add a magnet,
  and tap a file to stream it (with seeking; mkv/avi/HEVC are transcoded on the fly).
  Most clients offer a web remote but can't stream the content — this one can.
  - **Privacy & security:** off by default; access requires a private token that's part
    of the link (so only devices you share it with can connect); it's locked to your
    local network and rejects spoofed requests. "New link" instantly revokes old ones.

## [1.8.7-beta] - 2026-06-11

### Added
- **Force recheck.** Right-click a torrent → **Force recheck** re-verifies the files
  already on disk against the torrent's checksums — valid data is kept and only
  missing or corrupt pieces re-download. Useful after a crash, a manual file change,
  or to confirm a download is intact.
- **Alternative ("turbo") speed limits.** A second set of speed caps you can switch
  to instantly — from the new gauge button in the Downloads toolbar, the tray menu,
  or Settings → Network. Use it as a quick "turbo" (unlimited) or "turtle" (throttle
  while you work) toggle without editing your normal limits.
- **Move completed downloads to a folder.** Optionally, when a download finishes, its
  files are moved to a folder you choose and seeding continues from there
  (Settings → Downloads). Works across drives; if anything goes wrong it safely keeps
  seeding from the original location.

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
