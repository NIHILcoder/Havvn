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
gradients, local wallpaper and complete appearance profiles. These window
preferences remain independent of the theme and are restored at startup.

The material is independent of the palette. **Frosted glass** adds translucent,
blurred surfaces; **Liquid glass** also adds a light rim, depth and a highlight
that follows the pointer. These are composited UI effects, not an optical
refraction shader. The presets are Minimal, Frosted Glass, Liquid Glass and
Frutiger Aero. They preserve the selected palette and window backdrop preferences.

**Windows Acrylic** uses Electron's native background material. It shows the
blurred desktop and windows behind Havvn; no screenshots of the desktop are
taken. It requires Windows 11 22H2 (build 22621) or newer. Windows 10, earlier
Windows 11, Linux and macOS use the regular background and internal glass.
If the native API fails, the interface also falls back to an opaque background.
Windows controls its own Acrylic blur and tint; the effect sliders tune the
internal surfaces.

Choose **Desktop / theme background** to expose the native backdrop. A selected
gradient or local wallpaper replaces it inside the app. Local PNG, JPEG and
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
animation loop. Detached room/player panels and the theme editor mirror the
same appearance and get the native material where available.

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

The local machine used during implementation runs Windows 10 build 19045:
the fallback was verified there. The Windows 11 native API path has unit
coverage and still needs a visual check on a supported Windows 11 installation.

References: [Electron background materials](https://www.electronjs.org/docs/latest/api/browser-window#winsetbackgroundmaterialmaterial),
[Microsoft Acrylic design](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic).
