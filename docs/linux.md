# Linux packages

Havvn's Linux target is **x86_64**, built on Ubuntu 22.04 (glibc 2.35).
AppImage and deb contain Transmission 4.1.3, its runtime libraries and corresponding
upstream source, plus Linux FFmpeg and Node-API modules. Windows Wintun and DLLs
are excluded.

## Install

Download the `havvn-linux-x64` artifact from a successful
[Linux packages run](https://github.com/NIHILcoder/Havvn/actions/workflows/linux.yml).
Release builds attach these files to the draft alongside the Windows packages.
Development artifacts may contain changes newer than the tagged release.

Verify `SHA256SUMS-linux.txt`, then choose one format:

```bash
sha256sum -c SHA256SUMS-linux.txt
chmod +x Havvn-3.1.0-linux-x64.AppImage
./Havvn-3.1.0-linux-x64.AppImage
# Debian / Ubuntu: installs dependencies and the desktop entry
sudo apt install ./Havvn-3.1.0-linux-x64.deb
```

Run Havvn as your regular desktop user. Keep Chromium's sandbox enabled.
On Ubuntu 24.04+, prefer the deb package, which installs electron-builder's
AppArmor profile. Do not disable system sandbox protections to start an AppImage.
AppImage needs FUSE 2 (`libfuse2` on Ubuntu 22.04, `libfuse2t64` on Ubuntu 24.04);
without FUSE use `--appimage-extract-and-run`.

The deb lists desktop dependencies. AppImage still needs host GTK 3, NSS, ALSA,
GBM and X11 libraries. Other distributions are not yet covered by installation tests.

## Desktop behavior and limits

- The deb registers `.torrent`, `magnet:` and `havvn:` handlers. Select Havvn
  in desktop default-app preferences. AppImage desktop integration depends on
  your desktop/launcher.
- Autostart uses the user's XDG autostart directory. AppImage autostart points to
  the original file, not its temporary mount. After moving it, run it once to
  refresh the registered path.
- Room keys and saved credentials require an unlocked **GNOME Keyring or KWallet**
  compatible with Electron safeStorage. Havvn does not silently fall back to
  plaintext when the keyring is unavailable.
- Global push-to-talk uses X11. Under Wayland it reports unavailable; focused
  push-to-talk and voice-activity mode remain available.
- Wayland screen capture requires PipeWire and a working `xdg-desktop-portal`.
  System-audio capture is not promised on Linux. Microphone voice and received
  screen shares are separate features.
- The virtual LAN tunnel uses Windows Wintun and is **unavailable on Linux**.
  File sharing, chat and other room controls do not require it.
- Windows Acrylic falls back to an opaque window. CSS glass and themes remain
  available. Post-download sleep/shutdown actions are Windows-only; quit remains
  available.

## Build on Linux

Use a separate Linux checkout and Node.js 24. Do not reuse Windows `node_modules`.

```bash
sudo apt-get update
sudo apt-get install -y build-essential cmake ninja-build pkg-config \
  libcurl4-openssl-dev libssl-dev libevent-dev libdeflate-dev libpsl-dev \
  libx11-dev libxtst-dev libxinerama-dev libxkbcommon-dev libxrandr-dev \
  libgtk-3-0 libnss3 libnotify4 libxss1 libasound2 libgbm1 libsecret-1-0 \
  libayatana-appindicator3-1 gnome-keyring libfuse2 xvfb dbus-x11 desktop-file-utils
npm ci
npm run typecheck
npm test
npm run dist:linux
dbus-run-session -- xvfb-run -a npm run test:packaged -- release/linux-unpacked
```

The Transmission builder verifies a pinned SHA-256 before extraction, compiles
only the daemon, bundles its non-glibc library closure and license notices, and
checks its executable version. It does not install a system service.

CI tests on Linux, validates deb metadata, desktop associations and native
resources, then starts the actual packaged app with isolated Transmission and
WebTorrent profiles. Physical desktop, Wayland portal, audio-device and
cross-machine checks remain manual.
