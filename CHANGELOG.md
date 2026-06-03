# Changelog

All notable changes to TorrentHunt are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

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

[1.5.7-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.7-beta
[1.5.6-beta]: https://github.com/NIHILcoder/TorrentHunt/releases/tag/v1.5.6-beta
