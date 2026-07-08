# Havvn — design integration plan (Ember + two-pillar IA + Double-V logo)

> Self-note / execution plan. The concept is validated (see the rendered artifacts:
> home, screens, two-pillar IA). Decisions locked by the user:
> **Ember vibe** (neutral graphite ground + warm ember accents, flat — minimal
> gradients, hairline borders, sharp edges), **two-pillar IA** (Transfers | Rooms),
> **Double-V logomark** (option B). This is renderer-only and independent of the
> engine swap — safe to do in parallel; only the Settings engine selector touches
> shared state (`settings.engine`, already built).

## What already exists (don't rebuild — evolve)
- `renderer/App.tsx` — shell: `currentPage: PageId`, `renderPage()` switch, `<Sidebar>` + `<main>{page}<StatusBar/></main>`. Theme applied via `data-theme` on `<html>` from `localStorage.theme`.
- `renderer/layout/Sidebar.tsx` — current nav (`onNavigate`, `filterMode`, `downloadCounts`).
- `renderer/layout/StatusBar.tsx` — **already the bottom bar** (down/up speed, peers). This becomes the persistent bridge.
- Pages: `pages/DownloadsPage.tsx` + `pages/DownloadItem.tsx` (+ `FilterMode` all/downloading/completed/paused/error), `pages/RoomsPage.tsx`, `pages/SwarmPage.tsx`, `pages/SettingsPage.tsx` (+ `settings/*Section.tsx`, `AboutSection.tsx`).
- Primitives: `components/{Button,Badge,ProgressBar,Toggle,Select,Tabs,HealthBadge,Identicon}.tsx`.
- Tokens: `renderer/styles/{variables,layout,base,components}.css`. Existing var names are `--color-bg-*`, `--color-text-*`, `--color-border`, etc. (seen in App.tsx Toaster). **Phase 1 is a value remap onto these names, NOT a rename.**

## Guiding principles
1. **Token-first.** Drive the reskin through `variables.css`; components inherit. Highest leverage, lowest risk.
2. **Incremental, shippable per phase.** No big-bang. Order: cheap+safe (logo, tokens) → structural (nav) → connective (cross-links).
3. **Keep `data-theme` light/dark working.** Ember = the new dark theme values; keep a warm "day"/light variant. Optionally expose Haven/Midnight as extra themes in `ThemeSelector`.
4. **Preserve rebrand keeps:** `appId com.torrenthunt.app`, GitHub URLs, room KDF salt, `th-splash` DOM ids, `TH_INSTANCE`.

## The Double-V mark (canonical asset)
Two valleys of the wordmark's "vv" meeting at a node. Monoline, scales to favicon.
```svg
<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 9 L10.5 21 L16 12 L21.5 21 L28 9"
        stroke="#f2913f" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="16" cy="9.4" r="2.3" fill="#e0673a"/>
</svg>
```
Accent `#f2913f` / node `#e0673a` (ember). For the app icon on light surfaces, invert to a filled tile (ember mark on graphite `#141519`). At ≤18px drop the node (stroke only) for legibility.

---

## Phase 0 — Logo (small, self-contained, do first)
- Add `renderer/components/Logo.tsx` — the mark (props: `size`, `withWordmark`, `mono`). Single source of truth.
- Replace inline brand SVG/text in: `layout/Sidebar.tsx`, `pages/settings/AboutSection.tsx`, `renderer/index.html` (splash + `<title>` already "Havvn"; swap splash glyph — keep `th-splash` ids).
- **App/tray/installer icons:** regenerate `build/icon.ico` + `build/icon2.ico` from the mark (filled ember-on-graphite tile → 256/128/64/48/32/16 PNG → `.ico`). `build/installer.nsh` references stay the same paths. Signing step unchanged.
- Verify: Sidebar, About, tray tooltip icon, installer.

## Phase 1 — Ember tokens (`styles/variables.css` + `components.css`)
- Audit existing `--color-*` names; remap their **values** to the Ember palette (ground `#141519`, panel `#1a1c21`, surface `#1b1d22`, line `#2a2d36`, text `#ecebe6`, muted `#98958d`, accent `#f2913f`, accent2 `#e0673a`, seed/olive `#adb87c`, warn `#f0b24a`, error `#e2664a`). Radii 10/7px. Sans display, tight tracking.
- Keep light/day theme values; ember is the dark theme. (Optional: `data-vibe` for Haven/Midnight as extra `ThemeSelector` options — nice-to-have, not required.)
- **Flatten** in `components.css`: solid accent buttons (no gradient), 1px hairline borders, kill big glow shadows; active = ember border + faint ember bg. Progress bars solid ember (downloading) / olive (seeding).
- Verify each page visually (Electron render pipeline / `website/concept` local server).

## Phase 2 — StatusBar → the bridge (`layout/StatusBar.tsx`)
- Keep `↓/↑ speed · peers`. Add right side: presence — "◎ <room> — <names> watching" + **Join →** (navigates to Rooms). Source presence from the rooms subsystem; if the renderer doesn't already receive room presence, add an IPC subscription (check `RoomsPage` / preload for an existing rooms event before adding one).
- Verify: bar shows live speed + a live watching indicator, Join jumps to Rooms.

## Phase 3 — Two-pillar navigation (`layout/Sidebar.tsx` + `App.tsx`)
- Sidebar top: **Transfers | Rooms** mode switch (icons + counts). Contextual middle swaps by mode:
  - Transfers → the existing `filterMode` list (All/Downloading/Seeding/Completed/Paused) + categories/labels.
  - Rooms → room list + "Online now".
  - Footer: Swarm / Search / Settings utility icons + the "me" chip.
- `App.tsx`: derive the active pillar from `currentPage` (transfers-pillar = `downloads`; rooms-pillar = `rooms`); the mode buttons call `setCurrentPage('downloads'|'rooms')` and the sidebar renders the matching contextual list. Utilities (swarm/search/settings/rss/create-torrent) stay reachable from the footer + hotkeys. Keep existing keyboard shortcuts.
- Highest structural risk — land only after Phase 0–1 are stable.

## Phase 4 — Component restyle to the concept
- `pages/DownloadItem.tsx` + `DownloadsPage.css`: the transfer row (icon tile, name/sub, ember/olive progress, `↓rate · peers` column, status chip, hover-reveal **◎ Share to room** + pause/stop). Keep the selected-row detail tabs (Peers/Files/Trackers/Swarm) — data already available from `getPeers`/`getFiles`/`getTrackers`.
- `pages/RoomsPage.tsx`: watch-together stage + scrubber, shared-files list with **＋ Bring a file from Transfers**, right members panel + chat (density like the concept).
- `pages/SwarmPage.tsx`: swarm hero canvas + stats panel (peers-by-country, transport) — restyle; data from `getSwarmGeo`.
- `pages/SettingsPage.tsx`: section styling; **wire the engine selector to the real `settings.engine`** (native/webtorrent, `getEngineChoice`) with the "restart to apply" + DoH "requires Classic" honesty note.

## Phase 5 — Cross-links (connective tissue; real backend wiring)
- **Share to room** on a transfer → room picker → share into the room (reuse `electron/sharing` room-manager + `castPublishDiskFile`/`share-seeder`).
- **Bring a file from Transfers** in a room → picker from downloads → same path.
- Highest effort (touches rooms + torrent manager). Scope after the visual layer lands.

## Phase 6 — Verify
- `npm run typecheck` + `lint` + `vitest`; run the app on each page; screenshot via the Electron render pipeline (`scratchpad/render2.js`); adversarial review of the renderer diff; check light/dark, `prefers-reduced-motion`, responsive breakpoints, and focus-visible states.

## Sequencing & risk
- Phases 0–1 are near-zero-risk and give ~80% of the visual payoff — do them first, ship, gather reaction.
- Phase 3 (nav) is the one structural change; isolate it.
- Runs in parallel with the engine swap (renderer-only); the only shared touch is the Settings engine selector, which reads state already added this session.
- Concept sources to mirror: `website/concept/{index,screens,ia}.html` (local), and the published artifacts.
