# Rooms: local automatic acceptance

Scope agreed on 5 October 2026: only local automatic checks are available.
This records stage 7 of the [functional audit and implementation plan](rooms-functional-audit-and-plan.md).
Physical network/device scenarios remain open; passing this suite does not certify them.

## Repeating the checks

```powershell
npm run test:rooms
```

This builds Electron, renderer and guest, checks all three TypeScript projects,
runs the complete `npm test` with two Vitest workers, then runs ten native
Electron scenarios serially. Avoid running Minecraft generation or another full
test suite concurrently: CPU contention can cause timing failures.

For native checks against an already rebuilt application:

```powershell
node scripts/acceptance-rooms.cjs --native-only
```

The runner prints its temporary `havvn-rooms-acceptance-*` directory. `report.json`
records each exit code, duration, log path and unavailable scenarios. Individual
native checks print their own evidence/screenshot directories. A failed check
keeps its log and makes the runner exit nonzero, even when later checks pass.
The profiles, identities, room invitations, files and media are synthetic;
the normal Havvn profile, clipboard and physical microphone/desktop are not used.
OS protected storage must be available for the native storage and peer checks.

## What the automatic suite actually exercises

- **Lifecycle:** real RoomManager/preload, isolated engine session, capture denied
  without an explicit action, fake microphone permission revoked on stop, RNNoise
  WASM and AudioWorklet, renderer crash, retry and shutdown.
- **Peers:** three independent Electron processes initialized with `TH_INSTANCE`,
  real room engine and WebTorrent, local successful and rejecting WebSocket
  trackers. The fixture drops only A–C offer/answer forwarding, forcing control
  messages through B. It checks relayed chat, signed late-join backfill, manual
  downloads, same-name files with different SHA-256 hashes and distinct paths,
  diagnostics without the invitation, and local suspend/resume command gates.
- **Encryption:** ten actual owner-triggered rotations, a fresh third identity
  after each removal, surviving holder restarted with its protected profile,
  owner disconnected, then a fresh late joiner downloading/decrypting the original
  old-epoch file from the holder. Original shared bytes stay unchanged.
- **Voice:** real desktop and guest implementations in separate renderers;
  bidirectional audio RTP from synthetic microphones, PTT track gating, concurrent
  ICE restarts, changed ICE credentials, preserved mute/deafen and tracks, network
  recovery events, and teardown of tracks/peers.
- **Playback:** actual React RoomPlayer and GuestApp with native direct/HLS decoding,
  deliberately delayed HLS segments, seek/rate/pause without control echo, native
  VTT subtitle cues and Off, queue transitions, host requests, readiness, guest
  language remount and teardown. Room IPC/torrent boundaries are fixtures here;
  file transfers are covered separately by the three-process peer scenario.
- **Controls:** actual room/server/voice controls, failures/retry, duplicate actions,
  stale replies, dark/light/custom Aero and narrow layouts. A real native child
  window uses the production popout hook and HostWindowProvider: keyboard Select
  operates in the child, popovers stay there, tokens/theme mirror live, and unmount
  closes the child. Screenshots are retained.
- **Data/diagnostics/storage:** actual React cleanup/backup dialogs, cancellation,
  failure recovery and narrow layouts; OS-encrypted store migration, reopening,
  password backup/import, signed history and ban proofs, old-file decryption,
  preservation of corrupt records and no portable machine paths.
- **Server lifecycle:** real synthetic child process and loopback listener, acknowledged
  stdin command, stop before returning, safe room leave, intentional local detachment,
  disabled remote grants/schedules/content synchronization, persisted restoration,
  and cancellation of pending automatic restart. Actual Minecraft maintenance
  evidence is recorded separately in [server maintenance](rooms-server-maintenance.md).

The full regression also covers malformed/replayed frames, root/current owner
pins, signed ownership/key/ban chains and legacy protocol fixtures. These are
protocol simulations, not runs of old installed Havvn binaries.

The peer fixture removes external STUN/TURN only in its test preload and permits
local host candidates only in its test windows. Production privacy/ICE policy
is unchanged. Host-only success and bridge-message forwarding do **not** prove
symmetric NAT traversal or arbitrary file/media relaying. The holder explicitly
downloads and seeds the file used by the owner-offline late joiner.

## Recorded result: 5 October 2026

All fourteen runner checks passed: three TypeScript projects, full `npm test`
(207 Vitest suites / 2873 tests plus seven Node launcher tests), and ten native
scenarios. The full build also passed with three existing Webpack performance
warnings. Scoped lint of the console-log fix/new regression test passed without
errors or warnings. [Portable result record](rooms-local-acceptance-results.json).

The final controls scenario was rerun after stabilizing hidden-window snapshots;
its light popup/panel screenshots were inspected. Only the snapshot fixture disables
animations; application styles are unchanged. Native-window teardown waits for
`closed` rather than assuming it completes within 100 ms.

Acceptance found and fixed a console-log lifecycle race: a delayed error from a
retired stream could clear the new run's stream. Three regression tests cover
retired errors, active failure and intentional close. The actual child-server
scenario now runs without the previous `ERR_STREAM_DESTROYED` log warnings.

## Compatibility and remaining physical checks

Use updated clients along the key-history and paged-manifest path; legacy clients
retain only the current key plus eight compatibility keys. See
[key history](rooms-e2e-key-history.md) and [capacity](rooms-manifest-capacity.md).
Host mode requires `watch-host-v1`; capability advertisements guide the UI and
never grant authority. Rebuild/deploy the guest separately when testing a hosted
browser guest; this suite uses the current local guest sources/build.

Still unavailable with the agreed environment:

- Two physical computers, independent browsers/networks, actual symmetric NAT
  and selected TURN candidate verification.
- Physical sleep/resume, Wi-Fi change, NekoBox proxy/TUN switching and VPN loss;
  packet capture confirming the selected kill-switch policy for file/voice/LAN/server traffic.
- Real microphone/output hotplug, permission dialogs, physical audibility,
  system-sound capture, two captured sources and closing the captured window.
- Running installed older client versions against the updated desktop/guest.

These checks must be performed before claiming hardware/network acceptance.
The July documents are historical snapshots; current behavior and acceptance
are described by this report and the functional plan.
