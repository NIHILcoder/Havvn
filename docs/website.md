# HAVVN website

The public landing page is the static GitHub Pages entry point in `docs/index.html`.
Its layout and interactions live in `docs/assets/site.css` and `docs/assets/site.js`.
`docs/assets/brand.css` applies the application's Graphite + Ember visual language.
`docs/assets/presentation.css` and `docs/assets/presentation.js` coordinate section
arrivals, autonomous demo sequences and the small animated diagrams.
The interactive Three.js network lives in `docs/assets/hero-scene.js`; the lazily
loaded closing sequence lives in `docs/assets/signal-outro.js`.
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
The script covers all three stylesheets, the main and presentation scripts and
both Three.js modules.
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
clicking a peer, sending pulses, translated selection status, sculpture disassembly,
and static routes with reduced motion. The real application screenshot gallery is
checked separately from the interactive HTML demo. The closing sequence is checked
for scroll progress, instanced geometry, bounded blur, idle suspension, pause,
reduced motion, context restoration and the no-WebGL fallback.
`interactive.png` shows a selected route; `signal-*.png` capture the closing scene.
The isolated smoke profile uses software WebGL; real-device GPU performance
should be checked separately when changing scene complexity.

## Content updates

For translated copy, English is the element's text; Russian is its `data-ru`
attribute. The browser language selects the initial language; a user's choice
is saved locally. Product names and technical names keep their original spelling.

The landing page deliberately contains no pinned release numbers or release dates.
The hero and download buttons link to the latest GitHub release. The source
section links to the changelog and issues. Publishing a release needs no
corresponding website edit.

Keep platform details aligned with `docs/linux.md`: Linux is a preview;
virtual LAN and system audio capture in this page are described as Windows
features. P2P and E2E encryption do not promise anonymity or connectivity in every
network.

## Design and local demonstrations

The page follows the application's Graphite + Ember palette: dark neutral surfaces,
off-white text, orange actions, thin rules and square controls. Inter is the body
font; headings use Chakra Petch in English and Exo 2 in Russian, matching the app's
technical typography. Fonts are served locally with their licenses. Large type
and open space keep the layout legible around the two dedicated 3D sections.

The hero gallery shows actual application screenshots: downloads, the room
workspace, and the light appearance. Its three tabs support pointer and keyboard
selection, and advance automatically while visible. These images use isolated fixtures with synthetic data; their provenance
is recorded in `docs/assets/app/README.md`. They are distinct from the working HTML
demonstrations below and are captioned accordingly.

The product preview has three automatically presented tabs, with manual selection
available. Sample file search filters
three fictional rows and has an empty state; the pause control changes the sample
transfer state. In the room tab, inviting a guest toggles a fictional participant,
and a local chat accepts plain text only, retaining up to ten submitted messages
in memory. No file download, room connection or message transmission occurs.
The on-page caption explicitly describes this as an interactive mockup.

The dedicated rooms section uses the same dark palette and a room preview with
watch-together, voice and shared-folder tabs. They advance automatically while the
preview is visible. Each tab can also be selected by pointer
or arrow keys (Home/End also work). The sample microphone button only toggles
local demo state; it doesn't request microphone access or capture audio. Its
state and accessible label follow language switching. The chat link selects the
interactive room tab in the product preview above. All three room layouts are
checked at every supported smoke-test width and language; dedicated desktop
and mobile screenshots are saved alongside the other site captures.

Three palette buttons change the mockup between Graphite, Paper and Moss; they
don't change the rest of the site. The platform picker supports pointer and
keyboard selection, defaults to Linux on Linux desktops, and otherwise starts
with Windows. Both platforms lead to the official latest release.

The watch tab uses a locally served NASA Earthrise photograph, with its source
linked in the mockup. Playing the demo animates this still and a progress line;
it does not stream a video. Playback stops when leaving the tab, hiding the
document or scrolling the preview out of view. Reduced motion disables the
visual animation. See `docs/assets/PHOTO-CREDITS.md` for the photo source.

Only the language preference is persisted. Demo messages, invited guests,
palette choice and transfer state are reset on reload. The smoke check covers
these interactions, user-input HTML escaping, native touch input and keyboard
navigation. Section screenshots are saved in `artifacts/site/`.

## Automatic presentation

Each information section has a one-time, staggered arrival as it enters the
viewport. The main gallery advances every 6.8 seconds, the product demo every
7.4 seconds, and the rooms every 6.8 seconds. Their selected tabs show a thin
progress rule. Scenes do not move focus or announce an automatic slideshow
through live regions. Clicking, typing or focusing a control inside a demo
hands that section to the visitor for the rest of the page session.

The network performs a four-part sequence: send a pulse, separate the mark,
reassemble, then send another pulse. Tool descriptions are always visible,
accompanied by small SVG/HTML diagrams for streaming, LAN, appearance and search.
Privacy diagrams show local storage, encryption and inspectable code; the source
section has a commit graph, and the download section assembles an application
window. The FAQ answers start open. No step requires clicking to see the content.

Presentation timers retain their remaining time while offscreen or in background
tabs. CSS drawings are suspended individually when outside the viewport, including
inside tall mobile sections. No presentation JavaScript runs on an idle frame loop.
The existing global pause controls freeze all scenes. System reduced motion
disables automatic switching and animated drawings and exposes all arrival content
immediately. Without JavaScript, the content and diagrams remain visible and static.
Observers, timers and listeners are released on navigation; bfcache restores resume
the page without adding duplicate timers.

The smoke check observes real automatic transitions without clicking, verifies
manual takeover with a typed draft, offscreen suspension, global pause and reduced
motion, and captures desktop/mobile presentation frames in `artifacts/site/`.

## Visual effects

The dedicated network section uses Three.js to extrude the existing HAVVN outline into a beveled,
faceted copper sculpture, with a procedural studio reflection, a subtle 3D peer
network and pointer response. The environment and glow textures
are generated locally; no remote models or textures are fetched.

Drag the scene with a mouse or horizontally with a finger to rotate it. Vertical
touch gestures remain available for page scrolling. Brighter network beacons
invite selection; clicking a visible peer sends light packets to its six nearest
neighbors. The **Make a connection** button selects a front-facing peer, and the reset
button clears the route and restores the orientation. **Separate mark** splits
the sculpture into individual extruded facets; the same button reassembles it.
This manual action also works while motion is paused. The status explicitly
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
of Three.js.

The closing scene loads only when its section approaches the viewport. It samples
the original brand SVG into a single instanced mesh of small 3D blocks. Native
scroll position assembles those blocks into HAVVN; a short, bounded shader
displacement and canvas blur respond near the end of the assembly. A sticky stage
provides scroll travel without intercepting the wheel, touch gestures or scroll
position. Text, links and the download button remain normal, sharp HTML elements.

The closing renderer draws on demand during scroll and a short settling period;
it has no permanent idle loop. It suspends offscreen and in background tabs, caps
pixel ratio, and limits mobile updates to 30 fps. The footer pause control mirrors
the main animation control. Reduced motion shows a completed static wordmark and
removes the extended sticky travel, glitch and blur. The original SVG is visible
without JavaScript or WebGL and after context loss. Resources and observers are
released on navigation, while back/forward-cache restores are supported.

Three.js **0.180.0** is vendored unchanged under
`docs/assets/vendor/three-0.180.0/` (`three.module.min.js`, `three.core.min.js`
and its MIT `LICENSE`). Both modules come from the official npm `three` package.
When updating the library, use a new versioned directory and update the import
in both `hero-scene.js` and `signal-outro.js`; then restamp assets and run the smoke check. The original
brand SVG and locally served font licenses are included with the assets.
