# Changelog

All notable changes to TorrentHunt are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

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

[1.5.10-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.10-beta
[1.5.9-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.9-beta
[1.5.8-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.8-beta
[1.5.7-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.7-beta
[1.5.6-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.6-beta
