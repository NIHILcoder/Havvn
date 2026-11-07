# HAVVN website

The public landing page is the static GitHub Pages entry point in `docs/index.html`.
Its styling and interactions live in `docs/assets/site.css` and `docs/assets/site.js`.
The progressively loaded Three.js hero lives in `docs/assets/hero-scene.js`.
No build step, CDN, remote font or package installation is needed to serve the site.

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
demo, mobile navigation, WebGL rendering, the motion pause control, offscreen
suspension, reduced motion, WebGL context loss and restoration, the fallback
without WebGL, content visibility without JavaScript, and hero alignment with
the centered content on wide displays. It also verifies that assets make no
external requests and saves desktop/mobile screenshots in `artifacts/site/`.
Interaction checks cover mouse dragging, native touch events, arrow keys, reset,
clicking a peer, sending pulses, translated selection status, and static routes
with reduced motion. `interactive.png` shows a selected route.
The isolated smoke profile uses software WebGL; real-device GPU performance
should be checked separately when changing scene complexity.

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

The hero uses Three.js to extrude the existing HAVVN outline into a beveled,
faceted copper sculpture, with a procedural studio reflection, a 3D peer network,
pointer response and orbiting light signals. The environment and glow textures
are generated locally; no remote models or textures are fetched.

Drag the scene with a mouse or horizontally with a finger to rotate it. Vertical
touch gestures remain available for page scrolling. Brighter network beacons
invite selection; clicking a visible peer sends light packets to its six nearest
neighbors. The **Send a pulse** button selects a front-facing peer, and the reset
button clears the route and restores the orientation. The status explicitly
labels this as a P2P demo; no real peer connection or transfer is started.

The canvas is keyboard-focusable: arrows rotate, Enter/Space sends a pulse,
and Home/Escape resets. Instructions and selection status follow the page
language; updates are announced through a live region. Pausing or enabling
reduced motion still permits manual rotation and a static highlighted route.
Controls stay hidden until WebGL is ready and leave the tab order on context
loss, with focus returned to the motion control when necessary.

The animation loop stops when the scene leaves the viewport, the document
becomes hidden, the user pauses motion, or reduced motion is enabled. Small
screens use a smaller sculpture, a capped pixel ratio and at most 30 frames per
second. Geometry, materials, textures and observers are released on navigation.

The original SVG remains visible until the first successful WebGL render. It
also serves as the fallback when loading fails, WebGL 2 is unavailable, or the
context is lost. The scene and studio reflections rebuild when the context is
restored. Pausing, language switching and the rest of the page work independently
of Three.js. The scrolling text uses one scheduled frame per scroll update.

Three.js **0.180.0** is vendored unchanged under
`docs/assets/vendor/three-0.180.0/` (`three.module.min.js`, `three.core.min.js`
and its MIT `LICENSE`). Both modules come from the official npm `three` package.
When updating the library, use a new versioned directory and update the import
in `hero-scene.js`; then restamp assets and run the smoke check. The original
brand SVG and locally served font licenses are included with the assets.
