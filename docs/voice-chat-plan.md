# Voice chat for Rooms — design & implementation plan

Status: **planning**. Decisions locked (2026-07-16):

- **Topology:** full P2P **mesh** (serverless). Soft cap ~6–8 participants; warn/degrade
  beyond. A volunteer-forwarder for larger calls is a documented **future Plan B**,
  not v1.
- **v1 scope:** **full Discord-parity voice** — join/leave, mute, deafen, speaking
  indicators (VAD), push-to-talk, per-user volume, auto-mute-on-silence, join/leave
  chimes.
- **Media:** **audio-only** in v1, but the media layer is abstracted so
  **screenshare/video** can be added later over the same mesh path.

## Why mesh (not an SFU like Discord)

Discord uses a media server (SFU): everyone uploads to the server, the server fans
out. That scales to big servers but **requires infrastructure** — the one thing
Havvn deliberately doesn't have. A full mesh:

- **is serverless** — matches the app's identity;
- **is E2E for free** — WebRTC media is DTLS-SRTP encrypted directly between peers;
  no middle party ever hears or relays the audio (unlike an SFU);
- **reuses what we already built** — signaling rides the **authenticated, encrypted
  room gossip** from the 2.16 protocol-auth work, so voice offers/candidates are
  attributable and unspoofable.

The cost is O(N) upload per person (Opus ≈ 40 kbps × peers). At friend scale (≤8)
that's ~300 kbps up — fine. Past ~8 it degrades; that's the cap.

## Architecture

```
main window (React UI)                hidden engine window (per-room)
  RoomsPage VoicePanel  <--IPC-->  room-engine
   join/mute/deafen/PTT             ├─ data mesh (simple-peer)  ── existing
   speaking rings, volume           ├─ VoiceSession (NEW)
                                     │   ├─ getUserMedia(audio) local track
                                     │   ├─ MediaPeer per voice participant
                                     │   │    (raw RTCPeerConnection, audio track)
                                     │   └─ signaling over the room gossip
                                     └─ playback: remote tracks → WebAudio out
```

### Media location — RESOLVED: the hidden engine window works

De-risk research (2026-07-16, 5-angle cross-corroborated against Electron/MDN/
Chromium docs) confirms **Plan A is viable**:

- **`getUserMedia({audio})` works in a `show:false`, never-shown, no-gesture
  renderer.** Only `getDisplayMedia` was given a gesture requirement; `getUserMedia`
  is intentionally ungated (needs only: secure context + permission + Permissions-
  Policy). A hidden Electron renderer reports Page Visibility `visible` and is fully
  live.
- **Audio playback from a hidden window is audible** — WebRTC audio playout runs on
  a dedicated real-time thread (~100×/s), explicitly exempt from background
  throttling; `<audio autoplay srcObject=…>` plays with no gesture (Electron's
  default `autoplayPolicy` is `no-user-gesture-required`).

**Use the renderer's NATIVE Chromium WebRTC** (`window.RTCPeerConnection` +
`getUserMedia`) for voice — NOT `wrtc`. The engine window's data mesh uses `wrtc`
for Node-side work, but `wrtc` has no `getUserMedia` and is pinned to old Chromium;
media must use the renderer's built-in stack. (No fallback window needed.)

### Media-session abstraction (extensibility for video/screenshare)

`VoiceSession` manages a set of `MediaPeer`s (one per other participant). A
`MediaPeer` is track-agnostic: v1 attaches one **audio** track; adding screenshare
later = attach a **video** track + renegotiate + a UI surface. The signaling and
PC lifecycle don't change per media kind.

### Signaling protocol (over the authenticated room gossip)

New `Msg` types, all Ed25519-signed via the existing `verifySignedBy` (identity =
`deriveMemberId(pub)`), so a member can't spoof another's voice signaling:

| type | payload | purpose |
|---|---|---|
| `voice-state` | `{memberId, inVoice, muted, deafened}` | presence in the voice channel (gossiped like `have`) |
| `voice-offer` | `{to, sdp, pub, sig}` | SDP offer, unicast to `to` |
| `voice-answer` | `{to, sdp, pub, sig}` | SDP answer |
| `voice-ice` | `{to, candidate, pub, sig}` | trickle ICE candidate |

- `voice-state` drives who is shown in the voice panel and lets a joiner know who to
  connect to.
- offer/answer/ice are targeted (`to`) — voice signaling goes over the direct wire
  when present, relayed otherwise (reuse the gossip relay + `seenGids` dedup).
- **Glare** (both peers offer at once, common when two join together): **perfect
  negotiation** on the raw media `RTCPeerConnection` (simple-peer can't do this — its
  fixed initiator scheme is the source of its "stuck"/"infinite renegotiate" bugs).
  Per pair, the peer with the lower `memberId` is *polite*, the other *impolite*;
  impolite ignores a colliding offer, polite does an **implicit rollback** (modern
  arg-less `setLocalDescription()` inside `setRemoteDescription`). State per peer:
  `makingOffer`, `ignoreOffer`, `isSettingRemoteAnswerPending`, `polite`.

### Privacy integration (non-negotiable)

- **VPN kill-switch:** voice `RTCPeerConnection`s carry your real IP just like
  seeding. They MUST be torn down by `suspendAllNetworking` under `netSuspended`
  (the same gate we added for room seeding). On VPN drop → leave voice; require a
  **manual re-join** on restore (don't silently re-open the mic).
- **E2E:** mesh media is DTLS-SRTP; no relay peer. TURN (if needed for symmetric
  NAT) only relays encrypted media — the relay learns IP/timing, same as data,
  acceptable and behind the existing TURN toggle.
- **Mic indicator:** the UI must always show when the mic is live (capturing), and
  the mic is released on leave.

### Electron plumbing (new) — specifics from the de-risk

- **Permission string is `'media'`** (Electron collapses mic/cam/screen into one).
  Set BOTH handlers to allow it and tolerate a null webContents:
  - `session.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media' || …existing))`
  - `session.setPermissionCheckHandler((wc, perm) => perm === 'media' || …)` — this
    one is **synchronous and runs FIRST**; a mis-written check handler silently
    blocks capture before the request handler ever fires. `wc` may be `null`.
  - Distinguish audio via `details.mediaType === 'audio'` if we want to scope it.
  - Today the app has **no media permission handler** → default grants, but once we
    add ANY handler we must explicitly allow `'media'` or we break capture.
- **macOS (biggest real gate):** ship `NSMicrophoneUsageDescription` (missing = hard
  **SIGABRT crash**, not a deny) + entitlement `com.apple.security.device.audio-input`
  in **both** main and the **inherited** entitlements plist (capture runs in a helper
  that inherits). Drive the OS prompt from the **main process** before capture:
  `systemPreferences.getMediaAccessStatus('microphone')` → if `not-determined`,
  `await askForMediaAccess('microphone')`. Do NOT infer permission from getUserMedia
  (Electron ~30–32 had a silent-track bug; confirm it throws on 42).
- **Windows:** `getMediaAccessStatus('microphone')` reads status; no
  `askForMediaAccess` — if denied, deep-link `ms-settings:privacy-microphone`.
- **Secure context required** — if the app ever loads from a custom scheme, it must
  be registered privileged/secure or getUserMedia fails outright.
- `backgroundThrottling:false` on the engine window — NOT strictly required (WebRTC
  audio is exempt) but a free safety margin for JS-side timing (VAD meters, timers).
- **AEC caveat:** echo cancellation needs the remote audio to be **actually playing**
  as its reference — deafen must mute OUTPUT via element volume/`enabled`, but keep
  the stream rendered where AEC matters (or accept AEC-off when fully deafened).
- Output routing via `setSinkId()` (supported); device labels are blank until a
  `'media'` grant. Pin input with `{audio:{deviceId:{exact}}}`.

## UX (Discord-parity)

- **Voice panel** in the room: "Join Voice" → shows participants with **speaking
  rings** (VAD via a Web Audio `AnalyserNode` on each stream), mute/deafen state,
  disconnect.
- **Controls:** mute (stop sending), deafen (stop sending + mute all output),
  **push-to-talk** (reuse the existing hotkey system — hold key to transmit),
  **per-user volume** sliders, **auto-mute-on-silence** (VAD gate), **join/leave
  chimes** (short local sounds).
- **Watch-party synergy:** voice runs alongside the existing watch-together
  (`RoomPlayer`) — a call over a shared-file viewing. Strong differentiator; the UI
  should let voice persist while the player is open.

## Data model

Session-only — **nothing persists**. `RoomState` gains a `voice` block:
`{ participants: {memberId, muted, deafened, speaking}[], self: {inVoice, muted,
deafened, ptt} }`. Pushed to the renderer via the existing room-state channel.
Controls flow main→engine as new `room-cmd`s: `voice-join`, `voice-leave`,
`voice-mute`, `voice-deafen`, `voice-ptt`, `voice-volume`.

## Files (new + touched)

- **NEW** `electron/sharing/voice/voice-session.ts` — `VoiceSession` + `MediaPeer`
  mesh manager (getUserMedia, PCs, perfect negotiation, VAD).
- `room-engine.ts` — voice Msg handling, `room-cmd` voice commands, `netSuspended`
  teardown hook, `voice` block in `buildState`, gossip `voice-state` in hello/ping.
- `room-manager.ts` — voice IPC passthrough.
- `main.ts` — media permission handler; engine window `backgroundThrottling`.
- `preload.ts` + `ipc/handlers.ts` — voice IPC bridge (`window.api.rooms.voice.*`).
- renderer — `VoicePanel` component, speaking indicators, controls, PTT hotkey,
  `RoomsPage` integration, i18n (`en.json`/`ru.json`).
- `shared/types.ts` — `RoomState.voice`, voice command types.

## Phases

- **Phase 0 — SPIKE / de-risk. DONE ON PAPER** (research verdict above): hidden-
  window capture + playback confirmed viable; native renderer WebRTC; separate media
  PCs + perfect negotiation. The only remaining validation is a **first-live-build
  smoke test on the user's machine** (real mic + audio out + OS permission prompt),
  folded into Phase 1's first runnable milestone — no separate throwaway spike.
- **Phase 1 — core mesh voice. ✅ DONE (uncommitted).** `room-voice.ts`
  (VoiceSession + MediaPeer, perfect negotiation, VAD), signed `voice-state` /
  `voice-signal` over the gossip, presence + join/leave + mute + **deafen** +
  speaking rings, VPN teardown, Electron media-permission handler + macOS
  `askForMediaAccess`, IPC bridge (manager/handlers/preload/types), `RoomState.voice`,
  a `RoomVoicePanel` in RoomsPage, mic/headphones/phone-off icons, en+ru i18n. 321
  tests (incl. 5 VoiceSession-roster unit tests) pass; typecheck + prod build clean.
  **Remaining live check:** first-build smoke test on a real mic + audio out (and
  confirm `about:blank` is a secure context — if `navigator.mediaDevices` is
  undefined, point the engine window at a `file://` blank page).
- **Phase 2 — full parity. ✅ DONE (uncommitted).** Input modes (Always / Voice
  Activity [VAD-gated] / Push-to-Talk) with a configurable PTT key (in-app listener;
  global PTT via `globalShortcut` is a noted follow-up); per-user volume sliders;
  synthesized join/leave chimes; mic-live indicator (red pulse + red self ring while
  transmitting); deafen now restores the prior mute on un-deafen. Key trick: VAD runs
  on an always-open CLONE of the mic track, so gating the SENT track (enabled=false)
  in 'vad' mode doesn't starve the detector. 322 tests, typecheck + build clean.
- **Phase 3 — adversarial review + polish.** Signaling auth (spoofed offers,
  cross-room replay), glare/renegotiation correctness, DoS (voice-offer flooding,
  ICE flood), IP-leak / kill-switch teardown, echo/feedback. Then ship.
- **Future** — screenshare/video via the same `MediaPeer` (add a video track + a
  view surface); volunteer-forwarder for >8-person calls.

## Open questions / risks

1. **Hidden-window media I/O** (Phase 0 — the big one).
2. **NAT traversal at mesh scale** — mesh needs reliable STUN/TURN; symmetric-NAT
   peers fall back to TURN (already configured).
3. **CPU/bandwidth at the cap** — measure; warn past ~8; consider Opus bitrate cap.
4. **Glare storms** when a group joins simultaneously — perfect negotiation must be
   robust; test N-way simultaneous join.
5. **Echo/feedback** — rely on browser echo cancellation; deafen mutes output;
   speaker-vs-headset guidance.
