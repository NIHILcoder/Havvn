# Vendored Wintun (virtual-LAN adapter driver)

`win32-x64/` holds the official prebuilt **Wintun 0.14.1** DLL (© WireGuard LLC)
used by the Havvn virtual-LAN feature to create the TUN adapter that carries
game traffic between room peers:

- `wintun.dll` + `prebuilt-binaries-license.txt`

The binary is **not** committed — restore it with:

```
node scripts/fetch-wintun.mjs
```

The script downloads the official ZIP from <https://www.wintun.net/>, verifies
the pinned SHA-256, and extracts only the amd64 DLL plus its license text.

## License note

The Wintun *source* is GPLv2, but the signed DLLs published on wintun.net ship
under WireGuard LLC's separate **Prebuilt Binaries License**, which permits
redistribution when the DLL is distributed alongside software that uses it only
through the documented `wintun.h` API — which is exactly how this app uses it.
Conditions we must keep meeting:

- ship the official DLL **byte-for-byte unmodified** — never re-sign, repack, or
  place it inside `app.asar` (it is `extraResources` → `resources/wintun/`, and it
  must stay out of any code-signing pass);
- keep the proprietary notices intact and surface `prebuilt-binaries-license.txt`
  in the app's third-party licenses;
- do not use the WireGuard/Wintun names to promote the app (a factual "uses
  Wintun by WireGuard LLC" credit is fine).
