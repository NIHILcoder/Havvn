# TorrentHunt

![TorrentHunt](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## About

TorrentHunt is a desktop application for downloading and distributing open-source software using the BitTorrent protocol. The application is designed exclusively for legal use with open-source projects that officially distribute their releases via torrents.

## Purpose

The primary goal of TorrentHunt is to provide a secure, user-friendly, and efficient tool for:

- **Accessing open-source software**: Download Linux distributions, development tools, and other open-source projects available through official torrent channels
- **Supporting the open-source ecosystem**: Contribute bandwidth by seeding downloaded content to help other users
- **Decentralized distribution**: Reduce the load on project servers by utilizing peer-to-peer technology
- **Curated catalog**: Browse a collection of verified open-source software with direct download links

## Target Audience

- Software developers requiring development environments and tools
- System administrators deploying open-source infrastructure
- Educational institutions distributing free software
- Open-source enthusiasts supporting community projects

## Key Features
---
## Technical Stack

- **Frontend**: React, TypeScript
- **Backend**: Electron, Node.js
- **Torrent Engine**: WebTorrent
- **Architecture**: Multi-process with secure IPC communication

## System Requirements

- Operating System: Windows 10+, macOS 10.14+, or Linux
- Runtime: Node.js 18.x or higher
- RAM: Minimum ~? GB recommended
- Storage: Variable, depends on downloaded content

## Legal Notice

TorrentHunt is intended for downloading and distributing content that is legally available through torrents. Users are responsible for ensuring they have the right to download and share all content accessed through this application. The application includes a curated catalog of verified open-source software projects that officially support torrent distribution.

## Data Persistence

All download information, including progress, metadata, and application settings, is stored in a local PostgreSQL database. This ensures:
- Downloads resume automatically after unexpected shutdowns
- Historical tracking of completed downloads
- Persistent application configuration
- Data integrity and reliability

## Architecture Overview

### State Management
Downloads are governed by a strict state machine with the following lifecycle:

```
QUEUED → DOWNLOADING → COMPLETED → SEEDING
   ↓         ↓            ↓           ↓
   └──────→ PAUSED ←──────┴───────────┘
             ↓
          ERROR → REMOVED
```

All state transitions are validated to prevent invalid operations and ensure data consistency.

### Logging
Application events are logged to the `logs/` directory with:
- Daily log rotation (format: `torrenthunt-YYYY-MM-DD.log`)
- Automatic cleanup of logs older than 7 days
- Multiple severity levels (debug, info, warn, error)
- Structured format for analysis and debugging

### Security Model
- **Context Isolation**: Renderer process runs in isolated context
- **Node Integration Disabled**: Prevents direct access to Node.js APIs from renderer
- **Preload Script**: Provides minimal, type-safe IPC bridge
- **Content Security Policy**: Restricts resource loading and script execution

## Known Limitations

### Bandwidth Throttling
The WebTorrent library does not support native bandwidth throttling. While the application stores speed limit settings, they are not actively enforced. Users requiring strict bandwidth control should use OS-level network management tools.

### Peer Statistics
WebTorrent provides aggregate peer counts but does not distinguish between seeds (users with complete files) and leechers (users still downloading). The "seeds" metric may not reflect actual values.

### Catalog Content
The included catalog contains placeholder entries for demonstration purposes. Users should replace these with valid magnet links from official open-source project websites.

## License

MIT License - see LICENSE file for details.

Copyright © 2025 TorrentHunt

Permission is granted for free use, modification, and distribution of this software for any purpose, including commercial applications, subject to the terms of the MIT License.
