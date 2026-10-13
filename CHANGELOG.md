# Changelog

## Unreleased

## [3.2.0] - 2026-10-13

This release adds room chat and workspace tools, expands local game-server administration, and reduces unnecessary runtime and interface work.

### Added

- Settings search lists individual parameters and their descriptions, then navigates to and highlights the selected control. The search index follows setting labels in renderer builds.

- Multi-file selection in rooms with click/Ctrl/Shift and keyboard shortcuts, bulk download/pause, folder moves and removal. Selection markers appear after the first selection; the file speed budget now opens from a compact toolbar button.

- Shared room chat pins with owner controls, authenticated snapshots and navigation back to recent messages.
- First-unread navigation and read receipts for visible chat messages, including detached windows.
- Per-room notification modes: all activity, explicit @mentions, or off.
- Local chat archive search with author, date, link, request and mention filters.
- File request statuses with links to shared room files, and an optional watch-together start after every participating viewer is ready.

- Minecraft settings templates with a before/after preview and custom templates saved on the device.
- Server health panels with bounded CPU/RAM history, host disk space and explicit Paper/spark tick measurements.
- Full server snapshots covering the world, game files, mods, settings and version metadata. Updates retain a full snapshot and restore the previous assembly if installation fails.

- Room layout presets for conversation, cinema, gaming and administration, plus named custom layouts with panel widths and the selected server/tab. Saved layouts fold detached panels back into the room.
- A server preparation checklist showing server and LAN state, the required version and published content folders, with explicit file reception and client-pack confirmation.
- Server console search, warning/error filters, frozen output, navigation to the latest error and locally saved commands that prefill the command input.

### Changed

- Room state crosses desktop IPC as an initial snapshot followed by coalesced changes. Renderer subscribers share a decoder, request a new snapshot after a missed revision and retain references to unchanged data.
- Room storage uses scoped JSON snapshots and a bounded cache of decrypted text. Unread counts use metadata; persisting unchanged messages retains their existing encrypted text.
- WebTorrent piece caches share byte budgets across transfers: 32 MiB for Classic downloads, 16 MiB for rooms and 8 MiB for shared links. Empty file clients and sharing windows are released after idle periods without ending active publications, rooms or calls.
- The Native engine respects active-download limits across startup, pauses, streaming and settings changes. Polls no longer overlap, and expensive peer statistics are refreshed separately from progress.
- Transfer pages, sidebar counters and playback-buffer indicators share one download model and statistics subscription. Unchanged entries retain their references; live speed/progress sorting continues to update.

### Fixed

- Removed perpetual glow animations from persistent connection, room-presence and call indicators, allowing idle windows to stop submitting animation frames. Reduced-motion preferences now also cover pseudo-elements.

- Unified compact search/room control shapes, fixed squeezed RSS rule actions, removed nested input focus frames and rounded external-player preference borders. Settings alerts sit lower; torrent file selection uses round markers with keyboard support.

- Completion-action and export menus in Downloads now render above the transfer list when glass headers are enabled. Long menu labels wrap within correctly sized rows.

- The room member-count button now hides/restores the People panel at its current dock position instead of collapsing the left column and its unrelated tabs.

- Replaced system dropdown menus in search filters, provider connections, player preferences, episode prefetch and torrent creation with Havvn menus. RSS and subtitle delay fields now use themed number controls; profile capture fixtures use the app's styled buttons.

- Fixed overlapping multiline pinned chat messages and unified spacing, wrapping and control sizes in room pins, file requests, profile actions, room layouts and server forms. Narrow chat composers now keep the input and send action on separate rows.

- Torrent size in detailed and expanded download rows now comes from metadata instead of dividing lifetime transferred bytes by current progress, preventing inflated sizes after pausing and restarting. Native polling restores the full metadata size independently of file selection and repairs older saved values.

- Repeated clicks on room member avatars could clear the entire desktop interface. Profile anchors are now captured during the click event before React defers the state update. The same fix covers chat author avatars.
- Removed the unused action-header spacer above the room people list so participants start at the normal panel padding.
- Room member profiles and anchored menus now dismiss when their trigger is hidden, removed, moved to another window, scrolled or resized. Long profiles and menus stay inside small windows without losing their controls.
- Repeated Enter presses in room creation, joining and profile editing no longer submit multiple concurrent requests. Pending dialogs lock their settings, and confirming IME composition does not submit them.
- Extended the real two-client UI regression to cover repeated profile toggles, switching participants, Escape dismissal, chat profiles and people-list spacing.

### Verification

- Added regression tests for signed chat pins, room history/search, workspace layouts, file selection, server health/snapshots, download queues, bounded caches, shared download state and settings search.
- Isolated Electron checks cover room panel controls, menus above glass surfaces, themed inputs, native file-selection markers, server administration, sharing-engine lifetimes and idle rendering. Synthetic fixtures and software/forced-awake compositor measurements are identified in the corresponding test documentation.
- Physical multi-computer/NAT/TURN compatibility, device hotplug, installer upgrades and GPU utilization during real transfers remain separate manual checks.

## [3.1.1] - 2026-10-06

This update fixes current-format room invitations being rejected by the desktop join dialog and adds the first Linux x64 packages.

### Added

- Linux x64 AppImage and deb packaging with a pinned Transmission 4.1.3 daemon, Linux FFmpeg, platform-specific native resources and a Linux CI/package smoke workflow.
- XDG desktop autostart, including stable AppImage paths, Linux PNG icons and torrent/magnet/room-link desktop associations.

### Fixed

- Desktop room joining, clipboard prefill and havvn:// deep links now accept both current five-word/five-digit invitations and historical four-word/four-digit codes, including encryption suffixes and validated owner pins. The join hint now describes the current format.
- Windows-only engine paths and native-resource packaging on Linux. Global push-to-talk reports unavailable in Wayland sessions instead of attempting an X11 hook.
- Linux stale-daemon cleanup verifies the executable and exact configuration directory before signalling a reused process ID.
- Updated the build-only source-map-js dependency to 1.2.2 to address GHSA-68fv-2mgg-jv7q without changing the application API.


## [3.1.0] - 2026-10-05

This release strengthens rooms, expands search and appearance controls, and refreshes the Windows installer and startup experience. The changes below describe work accumulated since 3.0.7.

### Added

- Release comparison cards with quality, size, audio and subtitle language hints, per-source seed observations and timestamps, and direct download of a selected edition. Missing metadata remains unknown; inferred labels are distinguished from provider reports.
- Persistent local search download history, including removed torrents, with possible-match hints for results without an info hash and an independent history-clearing action.
- HTTP mirror failover for Custom JSON, Jackett and Torznab search, capabilities and torrent retrieval. Requests preserve API paths, query parameters and the selected connection, prefer the last working mirror, and enforce bounded attempts. Authentication, browser checks, rate limits, proxy and TLS failures stop failover.
- A desktop room receive queue with two concurrent receives across rooms, visible waiting size, priorities, pause/resume and disk-space reservations for encrypted and plaintext copies.
- Shared room file upload/download budgets, voice-priority controls and a separate screen-sharing bitrate setting. New rooms default to manual file downloading.
- Local room data inspection, managed-copy cleanup, paged chat/activity history and password-protected room/identity recovery backups. Backups preserve old encryption keys and signed proofs; they exclude file contents and chat history.
- Owner-signed profile ban snapshots, transfer-chain pinning, authenticated protocol validation and paged file manifests for up to 5000 room files.
- Optional playback hosts, viewer action requests and readiness/buffering status, supported by desktop participants and browser guests.
- Room connection diagnostics with separate discovery, file, voice and LAN states, discovery retry and a reduced report that excludes invitations, keys, addresses and chat content.
- Explicit server choices when leaving a room: stop and keep worlds by default, or retain current local processes while disabling room access and automatic maintenance.
- Glass presets in the theme editor, with material, opacity, blur, tint, highlights, depth, affected areas, quality and motion controls saved with themes. Local backgrounds and portable appearance profiles support coordinated theme, font and background settings.
- Native Windows Acrylic on supported Windows 11 22H2+ systems, with an opaque fallback elsewhere.
- A branded English/Russian Windows setup wizard with persistent desktop/Start menu shortcut and torrent/magnet association choices.
- A lightweight themed startup screen that restores appearance before the main renderer loads, reports actual initialization stages, and offers reload/log recovery when initialization stalls.

### Changed

- The privacy panel separates direct HTTPS exit IP/country, system web proxy IP/country and local tunnel routing. Exit geography is no longer described as the user's home location; unavailable route evidence remains unknown.
- VPN detection uses Internet routes and adapter identities, including NekoTun/sing-box, instead of DNS responses or hosting-provider names. IPv6 bypass is reported separately.
- VPN protection checks local routing without external polling, handles activity started during outages and suspends room networking. Native engine binding selects a routed IPv4 tunnel and fails closed when configuration cannot be read or a suitable tunnel is unavailable.
- Desktop and browser room playback share a rate-aware model, distinguish buffering from pause, retain pending controls during loading and preserve sessions through track changes.
- Room voice has bounded ICE recovery and an explicit retry after exhaustion. Admission limits and waiting states are consistent across desktop and browser participants.
- Search history suggestions, numeric controls, selections, toggles and room/torrent dialogs follow theme colors and corner settings. Popovers use their owning window and work in detached panels.
- Torrent row hover actions have dedicated space, chat composers grow and scroll consistently, and room search category choices open without being clipped inside a scrolling modal.
- Updated English, Russian and Simplified Chinese documentation, room migration/compatibility notes and local acceptance recipes.

### Fixed

- Updated the packaging HTTP cache dependency and removed the unpatched `braces` dependency chain from development tooling. The loopback renderer server retains Webpack watch/HMR and rejects external hosts/origins without proxy or directory-serving features.
- Made TCP loopback regression tests independent of optional native uTP/UDP sockets, avoiding permission failures on Windows CI while retaining real transfer, streaming, prefetch and pause assertions.

- Room engine startup waits and pending commands that could remain unresolved after load failure, renderer crashes or closure; room state now reflects engine failure and supports retry.
- Microphone capture completing after leaving a room, browser mute/PTT state differing from transmitted tracks, and recovery/device changes losing mute or deafen state.
- Same-name room files overwriting unrelated content or being marked present without verification; encrypted completion is distinguished from plaintext readiness and decryption failures remain visible.
- Old encrypted room files becoming inaccessible after key rotations, restarts or late joins. Recovery retains key history and protects stored room secrets with OS-backed encryption.
- Chat acknowledgements reporting success without delivery, duplicate/backfill ordering problems, missing reply context and draft loss on interrupted sends.
- Stale or malformed room frames, replayed participant state, and authority/ban inconsistencies after ownership transfer or holder restart.
- Network recovery races across suspend/resume, offline transitions and VPN protection; LAN exposes a retry after terminal failure and linked servers stop safely while retaining worlds.
- Remote server commands reporting success before host process-input acknowledgement; unsafe maintenance/backup file handling and stale console stream errors affecting a later server run.
- Repeated actions and late asynchronous responses updating stale room/server dialogs, selection portals and detached windows.
- Development startup probes abandoning a renderer response while Webpack was still compiling, leading to readiness timeouts and a blank window.
- Startup splash dismissal races and main-window reveal callbacks affecting a replacement window; failed renderer initialization retains recovery controls.

### Verification and remaining checks

- Added regression tests and isolated Electron acceptance scenarios for room lifecycle, real local peers and encrypted transfers, voice, playback, controls, local data, diagnostics, secrets, storage and network recovery.
- Theme/startup smoke checks cover dark, light and custom glass appearances, reduced motion, narrow layouts, invalid preferences and recovery controls. The refreshed NSIS installer compiles and the packaged application passes startup checks with both torrent engines.
- Physical multi-computer/NAT/TURN interoperability, real VPN/TUN interruption, sleep/network changes and audio-device hotplug remain separate manual checks. The refreshed installer still requires manual install/upgrade verification on Windows.
- Room file bandwidth controls do not impose a universal cap on voice, screen, LAN or ordinary torrent traffic. Profile bans cannot revoke files/keys already received or prevent a person from creating another identity. OS/VPN protection remains necessary for immediate network blocking.
