# Startup screen and Windows setup

The standard startup screen uses the compact Havvn lockup, the active palette
and an actual startup milestone: settings, interface, downloads or ready. It
does not report an estimated percentage. Version text comes from package.json.

A small, shared webpack entry restores the built-in mode, saved custom theme,
accent/font overrides and validated appearance before the React entry runs.
Splash CSS is inlined in the generated HTML; startup JavaScript is a local
script allowed by the production CSP. Glass follows the theme's dialog scope,
material, intensity, blur, quality, motion and corner settings. The glass layout
can show the saved local wallpaper or background gradient. Without dialog glass,
the compact layout stays solid for readable text. Reduced-motion and
reduced-transparency preferences also apply. No desktop capture is used.

Successful initial download loading dismisses the splash with a short fade;
failed download loading also releases the interface. After four seconds a slow
startup exposes logs and reload controls. At six seconds a mounted UI is
released even when the engine has not replied. When React or a dictionary chunk
never mounts, the recovery controls remain instead of showing an empty window.

The Windows installer remains electron-builder's assisted NSIS wizard. Native
directory selection, elevation, extraction progress and keyboard navigation are
preserved. Welcome/finish copy is available in English and Russian, with new
graphite/ember artwork and a matching uninstaller. Windows versions supporting
the dark-caption API use it; older versions retain their native caption.

A setup options page controls desktop/Start-menu shortcuts and .torrent/magnet
handlers. The registration is in installer.nsh so builder does not register
handlers independently of the checkboxes. Havvn room deep links remain
registered through builder. Choices are remembered for upgrades; automatic
updates skip the welcome/options pages. Windows may still ask the user to confirm
their default application. The finish action falls back to the executable when
the Start-menu shortcut was declined.

`npm run dist` regenerates the three bitmap assets and builds the application and
installer. `npm run test:startup` runs a production-entry Electron fixture under
CSP with a separate synthetic profile, checking dark/light/custom themes,
locale, glass, reduced motion, a 320 px layout, corrupt preferences and slow
startup recovery. Controller tests cover minimum duration, repeated replies,
unavailable engine, failed mount and logs errors. The installer can be checked
manually by walking its pages, testing selected/declined options and cancelling
before installation; installation/upgrade tests should use a disposable Windows
profile or VM.
