# Where things stand — handoff notes

Written 2026-07-27, before a Windows reinstall. Everything here is deliberately in
the repo rather than in a machine-local scratchpad, because the scratchpad does not
survive the reinstall.

Companion file: [`virtual-lan-plan.md`](./virtual-lan-plan.md) — the full design +
invariants for the virtual-LAN feature. Read its §0.1 before touching anything LAN.

---

## 1. What is DONE and PROVEN

**Virtual LAN (Hamachi-style, inside rooms)** — `ad1a457`, `edb0cc9`, `1b4f891`.

Verified live on two real machines:

- `ping` across the tunnel: 6/6, 0% loss, ~5 ms average
- **Minecraft LAN worlds appear with no manual IP entry** — the multicast
  replication an L3 tunnel does not give you for free, and the thing Tailscale
  cannot do
- teardown leaves no adapter, no firewall rule, no handshake secret, no orphaned
  elevated helper

Phase 1 is what was tested. Phases 2A (link quality, diagnostics, firewall fix-it)
and 2B (one-hop peer relay) are code-complete, unit-tested and reviewed, but **have
never been exercised live** — see §3.

**Rooms dock P1–P3** — `7d26f91`, `d6fd37d`, `0d6116c`. Confirmed working by the
user: panels move between the three zones, a whole group tears off into its own
window, and a panel keeps running across a move.

---

## 2. What is DONE but NOT verified

**Dock P4** — `52bda7b`. App titlebar in torn-off windows, hideable panels with a
restore control, tear-off by dragging a tab onto the desktop.

Compiles, 1264 tests green — but the **adversarial review never ran** (the agents
died on a connection error). P1–P3 each had 2–3 review passes that found real
defects, including two that could render the room blank, so the absence here is
meaningful, not a formality.

The three lenses that did not run, and should:

1. **Can the room be emptied or stranded via hiding?** Hiding is a new way to
   remove panels from view. The model refuses hiding the last visible panel, but
   the interleavings were never attacked: hide + tear off + close that window;
   a persisted blob claiming everything is hidden; a hidden panel in a window
   zone that no longer exists.
2. **Does a cancelled drag ever tear off, and does the mount contract hold?**
   The gesture is gated on three conditions together; Escape pressed with the
   pointer far outside the app is a known, documented ambiguity.
3. **Window-chrome parity** — in particular whether a child window's
   minimise/maximise/close really act on the child. The design says an
   event-sender lookup would target the room window instead, because a dock
   window's React tree runs in the main renderer's realm; the frame-name map is
   the fix, and it was never tested by anyone but the type checker.

---

## 3. What to do next, in the order I would do it

1. **Live-test LAN 2A** on two machines. Cheap and self-contained: the per-peer
   quality dot with RTT in its tooltip, the copy-pasteable diagnostics report, and
   the "game won't connect?" firewall fix-it (it adds a scoped rule through the
   already-elevated helper, so it costs no second UAC).
2. **Live-test the dock P4 surface** — the four things above, plus the one thing
   no unit test in this repo can reach: moving a panel **between documents**
   (into a torn-off window and back). Everything else about the hoisted mount is
   covered; that adoption step is not.
3. **Re-run the P4 adversarial review**, or walk the three lenses by hand.
4. **Peer-relay (2B) needs a third peer** or a pair behind symmetric NAT to
   exercise at all. It cannot break the direct path — direct frames are still
   bare IP packets, byte-identical to Phase 1; only relayed frames carry an
   envelope, distinguished by a magic byte whose high nibble is neither 4 nor 6.
5. **`npm audit`** — 50 vulnerabilities, 4 critical, flagged long ago and never
   addressed. Worth clearing before anything public.
6. **The 3.0.0 release** is the user's stated plan: fix everything, then tag. The
   release workflow fires on a `v*` tag only — pushing `main` ships nothing.

---

## 4. Known-broken / known-missing

- **Signed helper executable** — blocked on a code-signing certificate, not on
  code. Builds are unsigned (`CSC_IDENTITY_AUTO_DISCOVERY: false`), so the UAC
  prompt for the LAN helper shows an unknown publisher.
- **Confirm dialogs from a detached panel** — P2 left this open and P3/P4 mostly
  closed it; verify a confirm raised inside a torn-off window appears in *that*
  window.
- **Symmetric-NAT pairs without a relay candidate** still have no path. The panel
  says so honestly and points at TURN; the data-plane relay only helps when a
  third session member can reach both ends.
- **Legacy IPX / DirectPlay-L2 games** are out of scope by design — the tunnel is
  L3. Say so in the UI rather than letting people discover it.

---

## 5. Things that will bite you if you forget them

These are the non-obvious ones. Each cost real debugging time.

- **`Start-Process -ArgumentList` splits arguments on spaces** and does not
  re-quote them for the child. A path like `C:\Users\First Last\...` arrives
  as two argv entries. Two levels of quoting are required: double quotes for the
  child's parser, single quotes for PowerShell's. This silently broke the elevated
  helper for every user whose profile name contains a space.
- **The room grid places five children by auto-placement.** `display: none` on a
  splitter removes a grid item and shifts every later column one track left. Hide
  splitters with `visibility`. There is a comment at the site saying so.
- **`container-type` traps `position: fixed` descendants.** Every overlay must
  portal out to its owning document's body. This is why the pickers and modals
  portal, and why the Stage is deliberately *not* a query container.
- **A dock window's React tree lives in the main renderer's realm.** Only the DOM
  moves. So `window.api` stays absolute (a child has no preload bridge), but
  anything touching a document, a window, focus, fullscreen or a portal target
  must resolve the *owning* realm — that is what `renderer/utils/hostWindow.tsx`
  is for.
- **Changing a React portal's container remounts its children.** That is why each
  live panel owns one stable container for its lifetime and a move is a single
  `appendChild`, not a re-target. Undoing this quietly reintroduces the bug where
  moving a panel kills the voice subscriptions and the LAN failure latch.
- **Never extend a signed gossip canonical.** Adding a field breaks older peers'
  signatures. A new semantic gets a new message type with its own domain tag and
  its own anti-replay floor — never a shared floor.
- **A signature proves authorship, not entitlement.** Every virtual IP claim is
  re-derived on receipt; every admission is checked against a pinned session host.
  The relay is the untrusted party in its own path, so its claims are never
  load-bearing.
- **Do not edit sources through PowerShell** `Get-Content`/`Set-Content` on this
  machine — it mangles BOM-less UTF-8 into mojibake. Use an editor.

---

## 6. Repo state at the time of writing

- Branch `main`, everything committed. Two commits were unpushed at the moment
  this was written (`0d6116c`, `52bda7b`) — push them.
- 1264 tests, both typechecks clean.
- `vendor/wintun/win32-x64/wintun.dll` is **not** in git by design (gitignored,
  like the transmission daemon). Restore it with
  `node scripts/fetch-wintun.mjs` — the SHA-256 is pinned in that script.
- Untracked junk that is not part of any feature and can be deleted: `123.rar`,
  `LogoNew/`, `very cool themes/`, `__roomfile_verify_tmp.html`.
- `electron/i18n/index.ts` has an uncommitted local edit that predates all of
  this work; decide what to do with it.

## 7. After the reinstall

```
git clone https://github.com/NIHILcoder/Havvn.git
npm install
node scripts/fetch-wintun.mjs        # restores the Wintun DLL (pinned SHA-256)
node scripts/fetch-transmission.mjs  # restores the torrent engine binary
npm test && npm run typecheck
```

The LAN feature needs a **packaged** build to test, not `npm run dev`: the
elevated helper relaunches the app through `process.execPath`, which is
`electron.exe` in dev. `npm run dist`, then install on both machines.
