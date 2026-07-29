# Conventions and decisions that aren't visible in the code

Written 2026-07-27. These are the things a fresh pair of eyes (or a fresh session)
would otherwise have to rediscover by breaking something.

---

## Commits

- **No AI attribution.** No `Co-Authored-By`, no "generated with", no tool names.
  Commits are authored by the repo owner, full stop.
- Commit messages explain **why**, not what — the diff already says what. When a
  decision was between two reasonable options, the message says which was rejected
  and what made it lose.
- When something lands incomplete, say so **in the commit message**, with the list
  of what is not done. `52bda7b` and `e0f9a51` are the pattern.

## Releases

- The release workflow fires on a **`v*` tag only**. Pushing `main` builds
  nothing and publishes nothing — pushing early is safe and stops branches
  diverging.
- CI runs on push to `main`: typecheck, tests, build, on a Windows runner.
- The current plan is a single **3.0.0** carrying the virtual LAN and the dock
  rework, rather than dribbling out 2.25.x.
- `release.yml` hard-fails if the tag does not equal `package.json`'s version, and
  the draft release notes come from the matching `CHANGELOG.md` section — bump
  both before tagging.

## Internationalisation

Two dictionaries, deliberately not unified (the main process cannot import the
renderer's JSON):

- `renderer/i18n/en.json` + `ru.json` — the renderer. `t()` is **type-checked
  against `en.json`**, so a key missing there is a compile error, but a key
  missing from `ru.json` silently falls back to English. Add to both in the same
  commit; nothing catches the omission.
- `electron/i18n/index.ts` — main-process strings only (tray, native dialogs, OS
  notifications). Hand-typed, and unlike the renderer it **does** support
  `{placeholder}` interpolation.

Languages: `en` and `ru`.

## Theming

- Only CSS variables whitelisted in `shared/theme.ts` `TOKEN_NAMES` are
  theme-controllable. Styling with a raw hex or an un-whitelisted variable makes a
  component invisible to the live theme editor.
- **Roundness is a theme setting**, driven by the `--radius-scale` master through
  `--radius-sm/md/lg/...`. Strict square (0) is the default, not a hardcode. Never
  write a literal radius. `--radius-full` is reserved for genuinely round things —
  status dots, avatars.
- The visual language is "tactical HUD": framed zones with corner brackets, 11px
  uppercase eyebrows for section titles, 26px control pills.

## Responsive

Layout responds to **container width, not viewport**. The room is a named query
container (`container-name: room`, breakpoints 1040/720/420). A viewport media
query asks the wrong question here twice over: the dock squeezes the room without
moving the window, and a torn-off child window is always narrower than any
sensible viewport breakpoint.

Two traps, both of which have already caused bugs:

- `container-type` establishes containment, which makes the element a containing
  block for `position: fixed` descendants — a fixed overlay inside a container is
  trapped and rendered at the container's size. Overlays portal to the owning
  document's body for exactly this reason.
- Converting a viewport query to a container query is **not** a rename. The
  container is usually much narrower than the viewport, so the same number fires
  at completely different window sizes. Re-tune the threshold deliberately, or
  don't convert.

## Testing

- Vitest, no jsdom. Renderer components are tested with
  `renderToStaticMarkup` string assertions.
- Pure logic goes in its own module with a sibling `.test.ts`, and that is where
  the adversarial cases live. This is why `shared/` has `lan-ip`, `lan-packet`,
  `lan-router`, `lan-session-core`, `dock-windows` and friends: anything decidable
  is pulled out of the React/Electron layer so it can be attacked in a test.
- Anything needing a real DOM, a driver, elevation or two machines is a **manual**
  check. `docs/testing-rooms.md` holds the two-instance recipe; `npm run spike:lan`
  and `spike:pipe` are standalone harnesses.

## Multi-window (the dock)

- A torn-off window's React tree runs in the **main renderer's realm**; only the
  DOM is moved. So `window.api` stays absolute — a child has no preload bridge of
  its own — while anything touching a document, window, focus, fullscreen or a
  portal target must resolve the owning realm through
  `renderer/utils/hostWindow.tsx`.
- Cross-window drag is **impossible** in Electron (HTML5 DnD and pointer capture
  do not cross a `BrowserWindow`). Docking back is a button, and the "Move to"
  menu is the accessible path — not a fallback.
- The window pool lives in `shared/dock-windows.ts`, imported by **both**
  `electron/main.ts` and the renderer, because the two halves fail in opposite
  directions when they drift.

## Security posture (rooms / LAN)

The rules that the adversarial reviews kept catching violations of:

- **Encryption proves membership; signatures prove authorship.** Neither proves
  entitlement. A room-key holder can mint unlimited valid identities, so every
  per-member map is capped and every claim is re-derived rather than trusted.
- Each signed message type carries its **own** monotonic anti-replay floor. A
  shared floor lets one type censor another — this was a real HIGH finding once
  already.
- Every new gossip field must be **clamped in place** in `clampGossip`, because
  relays re-flood the clamped copy. That is the anti-DoS mechanism, not hygiene.
- The elevated helper is deliberately **trivial** — raw frames in, raw frames
  out, no protocol logic — because it runs as Administrator. Keep it that way.
- Voice is open to every room member **by design**; the LAN is host-gated. Cloning
  voice's transport is fine; cloning its authorization is a hole.

---

## Branches other than `main`

- `feat/theme-editor-pro` (`b8ff6b0`) — three phases of theme-editor work
  (docked panel + gallery, advanced tokens + search, HSL/eyedropper, WCAG
  contrast, on-screen inspector, palette generation, undo/redo). Committed,
  **never merged and never run live.** Decide whether it belongs in 3.0.0.
- `feat/virtual-lan`, `feat/rooms-dock` — already merged into `main`; the refs
  are just history now.

## Design/plan documents worth reading before touching a subsystem

- `docs/handoff/virtual-lan-plan.md` — the LAN feature end to end. §0.1 lists
  eight invariants, each of which exists because a review found the code
  violating it.
- `docs/rooms-design-audit.md`, `docs/rooms-ownership-transfer.md`,
  `docs/rooms-kick-hardening.md` — earlier rooms work.
- `docs/engine-swap-plan.md` — the transmission sidecar, and the template every
  later "supervised external process" followed, including the LAN helper.
