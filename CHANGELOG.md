# Changelog

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
