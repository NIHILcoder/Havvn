# Materials, Acrylic and appearance profiles

Open **Settings → Interface → Theme constructor → Glass**, or use the
**Edit glass** shortcut in Interface settings. Presets, intensity, blur, tint,
highlights, shadows, scopes and corner overrides belong to the theme and apply
to both its dark and light palettes. Changes preview live with Undo/Redo.
**Save** stores and activates the theme; closing without saving restores the
active theme, including its glass.

Theme import/export includes structured `glass` settings. Old themes without
this field continue to use the existing local material preference. Glass presets
preserve the native Acrylic and local background choices. The default appearance
stays opaque.

**Settings → Interface → Window backdrop & profiles** contains native Acrylic,
Mica, gradients, local wallpaper and complete appearance profiles. These window
preferences remain independent of the theme and are restored at startup.

The material is independent of the palette. **Frosted glass** adds translucent,
blurred surfaces; **Liquid glass** also adds a light rim, depth and a highlight
that follows the pointer. These are composited UI effects, not an optical
refraction shader. The presets are Minimal, Frosted Glass, Liquid Glass and
Frutiger Aero. They preserve the selected palette and window backdrop preferences.

**Windows 11 window material** uses Electron's native background material.
Choose **Acrylic** for a blurred desktop and windows behind Havvn, or **Mica**
for a calmer wallpaper-based backdrop. The app does not capture the desktop to
render either material. Both require Windows 11 22H2 (build 22621) or newer. Windows 10, earlier
Windows 11, Linux and macOS use the regular background and internal glass.
If the native API fails, that window falls back to an opaque background; a failed
popout no longer disables the main window's material. Windows accessibility
settings can pause native transparency without clearing the saved preference.
The material is reapplied after system resume. Repeated identical settings do
not reset the compositor. Windows controls native blur and tint; the glass
sliders tune internal surfaces.

Choose **Desktop / theme background** to expose the native backdrop. A selected
gradient or local wallpaper replaces it inside the app; settings explain when
the selected background hides the native material. With the desktop background,
navigation uses the system blur directly, without an additional CSS blur or
stacked full-window dimming layers. Dialogs keep a denser reading surface.
The background dimming control adjusts the native backdrop overlay as well.
Light palettes use a denser overlay so a dark system material does not obscure
dark text when the app and Windows use different colour modes.
Local PNG, JPEG and
WebP images are limited to 2 MB and 8192 × 8192 pixels. The image is stored
locally with the appearance settings. Removing it deletes that saved copy.

The Glass tab's advanced settings control opacity, blur, accent tint, highlights, shadows and
the areas that receive glass. The player control strip can be glass; video
pixels, torrent rows and chat messages are not individually blurred. Corners
inherit the theme constructor by default; dialogs, cards, buttons and fields
can each have an explicit override. The Minimal preset restores inheritance.

**Lightweight** mode caps blur at 8 px and disables cursor highlights. The
motion switch, the app's Reduce motion preference and the system's reduced
motion preference also stop cursor highlights. System reduced-transparency
and forced-colour modes use solid surfaces. There is no continuously running
animation loop. Pointer geometry is read once per animation frame, and highlights
stop when the window loses focus, is hidden or receives touch input.
Detached room/player panels and the theme editor mirror the
same appearance and get the native material where available.

### Illustrated worlds

**Settings → Interface → Window backdrop & profiles → Built-in themes** offers
ten ready-to-use, editable looks: Neon District (cyberpunk), Brass & Steam
(steampunk), Verdant Tomorrow (solarpunk), Orbital Silence (space), Bathysphere
(deep sea), Kyoto After Rain (Japanese night), The Grand Royale (Art Deco),
Sunset Drive 1986 (retrofuturism), Obsidian Sanctum (dark fantasy), and Polar
Light (Arctic minimalism). The collection is collapsed by default; expand its
header to browse the cards. The illustrations use simple geometry and limited
detail so that the full-window background stays clean.

Each card applies its own local SVG illustration, light/dark palettes, font,
glass material and corner geometry. The illustrations ship with the app and work
offline. Both palette modes remain available through the regular mode selector.
The collection preserves the user's reduced-motion and density preferences and
does not consume any of the eight personal profile slots. The background picker
also offers all ten illustrations independently of the palette. Use the existing
theme editor to customize a look, then save or export the current appearance
as a personal profile. Close the editor before applying another world.

**Restore previous appearance** undoes the last theme/profile application,
including the user's wallpaper, palette, font, material and window settings.
**Standard theme** clears the custom palette, quick accent/font overrides and
background, returning to the system's light/dark mode. It preserves density and
reduced motion, and can also be undone. One previous appearance is kept locally;
if storage is full, undo remains available for the current app session.

Personal profiles have separate groups for saving the current appearance,
selecting/applying/deleting saved profiles, and downloading/loading a profile
file. Updating an existing name is labelled explicitly. A loaded file is selected
in the list without being applied automatically. Actions display a status message.

`node scripts/smoke-appearance-collection.cjs` checks the real React cards in an
isolated Electron profile: every illustration decodes, every card applies its
palette and backdrop, repeated application reuses saved palettes, light mode
and stored settings restore correctly, and the gallery fits a 390 px window.
Screenshots are saved in `dist/appearance-collection-*/`.
`npx vitest run shared/appearance-collection.test.ts` checks profile import/export
round trips, all ten bundled assets/translations and text contrast in both modes.

Profiles save the selected palette, mode, accent/font preferences, material,
background, corners, density and reduced motion together. Up to eight profiles
are stored locally. Close the theme editor before saving/exporting or applying
a profile, so an unsaved palette draft is not overwritten. Saving with an existing name replaces it. Export writes a
`.appearance.json` file; Import validates it and adds it to the list without
automatically applying it. Embedded images and custom fonts are included, so
profiles can consume several MB of local storage. Storage errors are shown
instead of claiming the profile was saved. A profile's palette is imported
under its own ID and does not replace an existing palette with the same ID.

## Verification

The [startup screen](startup-and-installer.md) restores the saved theme and
appearance before the main interface loads. It uses the compact Havvn layout
with solid materials and the themed layout when dialog glass is enabled.

`npm run test:appearance` compiles the main process and runs an isolated Electron
fixture, without user profiles or network access. It checks native enable/disable
or the supported fallback, actual React controls, profiles, scope selection,
quality, corner inheritance, dark/light/Aero screenshots, a real detached window
and a 380 px viewport. It also checks the actual theme editor: the Settings
shortcut, preview without persistence, Undo/Redo, cancel before and after Save,
theme import/export, startup, theme switching and backdrop isolation.
The screenshots use synthetic backgrounds and do not
capture the desktop. Unit tests cover settings/profile validation, unsafe image
payloads, OS version gating, native failures and window lifecycle cleanup.

20 October 2026: checked on Windows 11 build 26300, Electron 44.4.2.
`DwmGetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE)` confirms Acrylic (3),
Mica (2), disabled (1), and Mica in a real detached window (2). The report and
wide/narrow UI images are saved under `dist/windows11-glass/`. These images use
synthetic in-app gradients; they do not claim to show the native compositor's
pixels. The earlier Windows 10 fallback check and current unit tests cover
unsupported systems. Existing appearance settings and profiles without a
`nativeMaterial` field retain Acrylic; theme glass stays independent of it.

`node scripts/smoke-packaged.cjs <unpacked-directory>` checks a real packaged
executable with isolated profiles for both download engines. It restores a saved
Mica choice, switches Acrylic/Mica/off through preload and main IPC, verifies
saved settings, creates an E2E room, and creates/edits/restores a document through
the packaged CRDT worker. This covers startup and local operations; it does not
replace multi-PC sync, external NAT/TURN, installed-build or Office acceptance.

References: [Electron background materials](https://www.electronjs.org/docs/latest/api/browser-window#winsetbackgroundmaterialmaterial),
[Microsoft Acrylic design](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic).
