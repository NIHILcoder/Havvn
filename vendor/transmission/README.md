# Vendored transmission-daemon (download engine sidecar)

`win32-x64/` holds the minimal portable set of **Transmission 4.1.3**
(GPL-2.0-or-later, © Transmission contributors) used as the app's native
download engine, spawned as a localhost-RPC sidecar:

- `transmission-daemon.exe` + `libcurl.dll`, `libcrypto-3-x64.dll`,
  `libssl-3-x64.dll`, `zlib.dll`

The binaries are **not** committed — restore them with:

```
node scripts/fetch-transmission.mjs
```

The script downloads the official MSI from
<https://github.com/transmission/transmission/releases/tag/4.1.3>, verifies the
pinned SHA-256, and extracts only the daemon set.

## License / GPL note

Transmission is GPLv2+; this app communicates with the unmodified daemon over
its documented RPC protocol as a separate process (aggregation, not linking).
When distributing builds that bundle the daemon we must point users at the
corresponding source: <https://github.com/transmission/transmission/tree/4.1.3>
(also mirrored in the About dialog / README when the engine ships).
