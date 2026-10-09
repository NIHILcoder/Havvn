# HAVVN website

The public landing page is the static GitHub Pages entry point in `docs/index.html`.
Its styling and interactions live in `docs/assets/site.css` and `docs/assets/site.js`.
No build step, CDN, remote font or runtime dependency is needed.

## Local preview

From the repository root:

```sh
node scripts/serve-site.cjs
```

Open http://127.0.0.1:4173/. Set `HAVVN_SITE_PORT` to choose another port.
The server binds only to localhost.

## Asset cache updates

After editing the website CSS or JavaScript, run:

```sh
node scripts/stamp-site-assets.cjs
```

This updates their content hashes in `docs/index.html`. Changed assets get fresh
URLs, so returning visitors receive the new styles and interactions instead of
old cached files. Include the updated HTML in the same commit as the assets.
The smoke check rejects stale hashes. Product release numbers are not involved.

## Browser checks

With the project's Electron dependency installed:

```sh
node scripts/smoke-site.cjs
```

The smoke check starts an isolated preview server and Chromium profile. It checks
Russian and English at eleven widths from 320 to 2560 pixels, local assets and
fonts, anchor destinations, language persistence, keyboard tabs, the animation
demo, mobile navigation, live particle rendering, the motion pause control,
reduced motion, content visibility without JavaScript, and hero alignment with
the centered content on wide displays.

## Content updates

For translated copy, English is the element's text; Russian is its `data-ru`
attribute. The browser language selects the initial language; a user's choice
is saved locally. Product names and technical names keep their original spelling.

The landing page deliberately contains no pinned release numbers or release dates.
The hero and download buttons link to the latest GitHub release. The updates
section describes enduring product capabilities and links to the changelog as
the source of current changes. Publishing a release needs no corresponding
website edit.

Keep platform details aligned with `docs/linux.md`: Linux is a preview;
virtual LAN and system audio capture in this page are described as Windows
features. P2P and E2E encryption do not promise anonymity or connectivity in every
network.

## Visual effects

The hero uses the existing HAVVN vector shape with a metallic material, a
locally rendered 3D particle network, pointer response and orbiting lights.
A requestAnimationFrame loop stops when the hero leaves the viewport, the
document becomes hidden, the user pauses motion, or reduced motion is enabled.
The scrolling text uses one scheduled frame per scroll update. The original
brand SVG and locally served font licenses are included with the assets.
