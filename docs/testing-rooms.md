# Testing rooms (friend swarms) on one machine

## Stage 7: complete local automatic acceptance (5 October 2026)

Run `npm run test:rooms` for the full build, three TypeScript checks, complete `npm test` and ten native scenarios. Against an already rebuilt application, run `node scripts/acceptance-rooms.cjs --native-only`. Results, logs and screenshots are saved under temporary acceptance directories. See [scope, three-process relay/ten-rotation scenario, compatibility and physical checks still unavailable](rooms-local-acceptance.md). The peer fixture uses `TH_INSTANCE` and local trackers; it does not validate the production privacy policy on a physical network.

## Game-server maintenance (5 October 2026)

See [actual Minecraft/NeoForge backup, restore and content acceptance](rooms-server-maintenance.md) for the isolated JVM smoke, executable consent checks, legacy backups and interrupted-maintenance recovery.

## Shared playback (4 October 2026)

See [playback model, queue policy and limits](rooms-playback-model.md).

```powershell
npx vitest run shared/room-playback.test.ts guest/watch.test.ts guest/mesh-chat.test.ts --maxWorkers=2
node scripts/smoke-room-playback.cjs
```

With isolated instances and an updated guest page, play the same synthetic media
at 0.5×, 1.5× and 2×. Check play/pause and forward/backward seeks, then open a late
viewer and simulate slow loading. A pause arriving while loading must remain a
pause. A long HLS seek must not bounce another command back to the room. Waiting
for data should show buffering rather than a deliberate pause.

Change an audio track and advance its queue. Rate should remain selected and the
watch session should stay open; receiving a track should not send another track.
Reselect the current desktop queue track: it should restart at zero and still
accept subsequent remote play/pause/seek commands.
Check different local shuffle/repeat choices, Together off, and a departing queue
driver. Then switch guest language, detach/reattach the desktop player and close
both players: preserve position/pause/rate on recreation and stop timers/streams
on closure. Verify normal browser autoplay prompts separately from the smoke
test, which enables autoplay for isolated synthetic media.

## Large manifests and voice overflow (4 October 2026)

See [transport, capacity policy and compatibility limits](rooms-manifest-capacity.md).

Automated checks:

```powershell
npx vitest run shared/room-manifest-sync.test.ts shared/room-voice-policy.test.ts electron/db/room-manifest-storage.test.ts electron/sharing/room-liveness.test.ts guest/mesh-authority.test.ts electron/sharing/room-voice-capture.test.ts --maxWorkers=2
npm run build
node scripts/smoke-room-voice.cjs
node scripts/smoke-room-lifecycle.cjs
```

Manual acceptance with the isolated instances described below:

1. Publish 500 uniquely named synthetic files, then repeat with 5000. Join a second
   desktop instance and a browser guest after publishing. Keep automatic download
   off while testing metadata. Every accepted file should appear; diagnostics
   should stop showing synchronization only after all parts arrive.
2. Restart the desktop recipient. Verify that files beyond entry 1000 still appear.
   Repeat with several active rooms; chat and voice controls should remain usable.
3. Retry the connection during synchronization, then close/reopen the room. An old
   queued snapshot must not modify the reopened room. Add a file beyond capacity:
   existing entries should remain, with a capacity notice on desktop.
4. On updated clients, exceed nine voice participants. All clients should converge
   on the same admitted set. Waiting participants should be visible without a
   failed-link badge or microphone transmission. When an admitted participant
   leaves, an eligible waiting participant should connect with mute/deafen intact.
5. Repeat across two physical computers with VPN changes, sleep and restrictive
   NAT/TURN. Verify actual audibility and disk/seeding performance separately.

Rooms are peer-to-peer (WebRTC rendezvous + WebTorrent transfers), so verifying
them normally needs two different computers. To make local testing possible, set
the `TH_INSTANCE` environment variable: it launches an **isolated second copy**
of Havvn with its own profile (separate DB / config / room identity) that
skips the single-instance lock, so two copies run side by side and behave like
two different people.

## Run two instances (dev)

Open two terminals in the project root.

**Terminal A — primary instance + the renderer dev server:**

```powershell
npm run dev
```

**Terminal B — second, isolated instance (PowerShell):**

```powershell
$env:TH_INSTANCE = 'peer2'; npm run dev:electron
```

(For cmd.exe use `set TH_INSTANCE=peer2 && npm run dev:electron`.)

The second window's title bar reads **“Havvn — peer2”** so you can tell them
apart. Each instance has its own room identity (name + avatar), so they show up as
distinct members in a room. You can launch more with different names
(`peer3`, `peer4`, …).

> Both instances load the renderer from the same dev server (Terminal A), so start
> `npm run dev` first and wait for webpack to finish before launching peers.

## What to verify

1. **Join / presence.** In peer1 create a room → copy the invite code. In peer2
   *Join by code*. peer2 should appear as an online member in peer1 (avatar +
   green dot) and vice-versa.
2. **File transfer.** New rooms start in manual mode: peer1 adds a file → peer2 sees it without downloading. Request it explicitly, or opt into automatic downloading in the join dialog. Then verify live progress and the “who has what” list on both sides.
3. **Friendly name sync.** peer2 (which only had the code) adopts the room's real
   name once peer1's HELLO/PING arrives.
4. **Roles + activity log.** The creator is owner (`canManage`); the Activity
   panel logs created / joined / file-added events on both sides.
5. **Kick = rekey.** Owner removes peer2 → the room rotates to a new code; peer1
   stays, peer2 is stranded on the old swarm (can't see new activity).
6. **Local mute.** Muting a member hides their shares on the muting install only,
   reversibly, without broadcasting.
7. **E2E rooms.** Create a room with encryption on → shared files travel as
   ciphertext (the room-enc cache) and are decrypted into the room folder for
   watch/open; a kick/rekey must not strand already-shared files.
8. **Watch-together.** Both peers open the same downloaded media → play/pause/seek
   stays in sync, and the player shows who's watching.
9. **Persistence.** Quit and relaunch each instance → rooms, members list,
   manifest (re-seeded), history, and E2E config all survive.
10. **Browser guest.** Copy the *browser* invite link (or open
    `docs/room/index.html#<invite>` locally). Confirm join on the gate — the
    guest appears with a Guest badge, can chat / join voice / watch a
    non-E2E playable file, and cannot write files or see LAN / game server.

## Notes

- TURN relays are on by default (Settings → Network → Sharing), so cross-NAT —
  and same-machine — connections work. Turn it off to test the STUN-only path.
- Isolated profiles live next to the real one, e.g.
  `%APPDATA%\havvn-peer2`. Delete that folder to reset a test peer.
- `TH_INSTANCE` is a **testing aid only** — production builds are single-instance.

## Voice recovery and device changes (3 October 2026)

Use two isolated desktop profiles and an updated browser guest. Start voice explicitly on each, confirm audible speech, then test mute, deafen, push-to-talk, per-member volume and the selected output device before disconnecting anything.

1. Briefly interrupt connectivity for less than five seconds. It should recover without a new microphone capture. Repeat with a longer outage: show reconnecting and up to three automatic ICE-restart attempts, then an explicit failure and Retry. Each negotiation has a 20-second deadline; repeated presence or signaling must not start an unlimited loop. Restore the network and use Retry if needed.
2. Switch Wi-Fi/VPN/TUN while voice is active, including NekoBox system proxy plus TUN, then sleep/resume. Some interface changes do not emit a browser `online` event: ICE detection or explicit Retry must still give a bounded result. Check actual two-way audio, not just a connected badge. Test a real TURN-required network separately; the browser guest's STUN-only behavior remains different from desktop.
3. Unplug the selected microphone, remove the only available input, then reconnect it. The client should fall back to the default when available, show a missing microphone when none is usable, and retry when an input returns. A preferred device must stay selected in settings. Change the system-default microphone without ending the old track. Browser guests follow the default input.
4. Repeat input changes while muted, deafened and with PTT released. The replacement must stay silent until the chosen transmit mode permits audio. Keep a screen with system sound shared during desktop recapture: replacing the microphone must not replace or mute its separate screen-audio sender. Unplug/reconnect the selected output device and verify routing and volume.
5. Leave voice/the room, close the guest, or kick a participant during reconnect or a pending capture. Microphone indicators must stop, no late answer/capture should revive the call, and no retries should continue after teardown. Enable the VPN kill-switch and drop the VPN: voice must stop; releasing the kill-switch must not automatically open the microphone.

Local automated verification uses synthetic microphones and local IPC signaling:

~~~powershell
npm run build:electron
node scripts/smoke-room-voice.cjs
node scripts/smoke-room-lifecycle.cjs
~~~

The voice smoke runs actual WebRTC between separate desktop/guest Electron renderers and reports an evidence file in a temporary profile. Only these test windows use an explicit public/private-interface policy for local host ICE; the app keeps its existing policy. Default-policy host gathering was intermittent on this test machine, so that boundary still needs real-device validation. It does not establish physical hotplug, real browser permission dialogs, cross-machine audibility, sleep/VPN/NAT/TURN behavior or system-sound capture. These manual checks remain open until run on real devices. See [rooms-voice-recovery.md](rooms-voice-recovery.md) for retry timings and compatibility limits. Rebuild and publish the guest page separately before testing the hosted guest.


## Room secret storage and key-history v2 (3 October 2026)

Use synthetic rooms in the isolated profiles above. Codes, content secrets, all previous keys and their copies in cfg/key pages should be inside the protected room-record envelope in the profile's rooms.json. Metadata remains readable. Do not edit or damage your real profile for this check.

Create an E2E room, share a small file, and keep a surviving second client connected. Remove/rejoin a third test identity enough times to rotate the content key at least nine times. Rejoin with the new invite each time. Restart the holder, take the owner offline and join a fresh fourth profile through the holder. The original file must still decrypt and open. Repeat with multiple old files, manual fetch, missing pages and transfer of ownership during connection. Old clients only support the current key and eight compatibility keys; this scenario requires updated clients along the key-page relay path.

The local automated OS-storage check is:

~~~powershell
npm run build:electron
node scripts/smoke-room-secrets.cjs
~~~

It creates an isolated temporary profile and reports an evidence file; it never opens your real rooms. Additional unit/in-memory preload regressions are in room-secrets.test.ts, room-keyring.test.ts and room-e2e-adopt.test.ts. Unavailable OS storage must preserve the record, refuse networking and show Retry; disk failures during live updates must report unsaved changes and keep the latest update for retry. Actual OS account loss/keychain recovery needs a separate disposable OS account or VM and is not established by the synthetic test.

## Signed profile bans (step 3.4)

Use updated clients in isolated profiles. Create a room, keep a holder connected, remove a third profile, then save the new invite. Restart the holder, take the owner offline, and join a fresh profile through that holder. Check that the owner-signed ban proof is preserved inside the protected envelope in rooms.json, without a public banState/signature, and that the fresh client/browser guest learns it. Public ban IDs remain metadata. Try the same excluded profile with the new invite: it must show removal and receive no content key/full file manifest. Existing file swarms on an excluded desktop must stop; already downloaded files must remain on disk.

Transfer ownership, remove the former owner, and join another profile with the original owner pin plus the current code. The authenticated chain must still lead to the new owner and carry its bans. A transfer during the deferred kick must be refused; retry after rotation finishes. A new identity with the current invite can join: this is an invite-based room, not owner-approved admission. Old clients may omit the snapshot; do not treat silence as proof of no bans. For format/compatibility see rooms-ban-snapshots.md. The regression tests use encrypted in-memory connections; repeat on two devices and real VPN/NAT before general acceptance.

## Desktop room resources (step 4.1)

Use two isolated desktop profiles with small test files. Queue three files in one room, then another in a second room: no more than two receives should run on each install across its rooms. Check waiting count/bytes and file positions; use the context menu to move a waiting file to the front. Pause an active receive and a waiting file, resume the active file, then restart while the other is paused. Automatic fetching must not override the saved pause. Removing/leaving a room or enabling the VPN kill-switch must not start its queued jobs later. Completed local files still offer stopping/restarting seeding separately.

Check ordinary and E2E files. On a disposable small volume, leave insufficient room for ciphertext + plaintext + the 256 MiB safety margin: the receive must report disk-full before opening the store, retain existing data and allow retry after space is freed. Repeat with cache and destination on different volumes. Do not fill the normal system volume. A paused live-playback file should request resuming first; a file waiting behind occupied slots should report that wait within five seconds, without launching a playback server later. See rooms-receive-resources.md for inactivity deadlines and conservative reservation accounting.

Automated regressions: room-receive-queue.test.ts, room-receive-integration.test.ts, room-file-storage.test.ts, room-autofetch.test.ts, room-watch-stream.test.ts and room-engine-lifecycle.test.ts. Shared traffic regressions are in room-traffic-budget.test.ts and room-limits.test.ts. Real network throughput, VPN/NAT and low-space OS behavior still require the two-device acceptance run.

For traffic acceptance, keep regular torrents, LAN and game servers idle and use two sending room clients on the same install. Set a finite total file budget in Settings → Sharing, then verify that two simultaneous transfers share it instead of each getting the full amount. Account for the token-bucket startup burst and transport overhead. Lower one room’s individual ceiling and verify its spare share goes to the other; close a room and verify reallocation. Zero at the room level inherits the total. Joining/leaving the last voice call must apply/restore the displayed file budget; a stricter user limit must not increase. Verify this again after an engine restart and while the VPN kill-switch is suspended.

Create a new room with the default manual choice, receive a manifest and verify that it does not download automatically. Repeat with the choice enabled. Rejoin an existing room and verify its old preference survives.

Share a synthetic test screen, change the per-participant bitrate while live, then add a participant. Inspect sender parameters/WebRTC stats and verify both the new and existing participants use the selected ceiling. Verify that multiple participants increase total traffic; voice and screen audio are not covered by the file budget. Repeat at 250/2500/20000 kbit/s and check a rejected parameter update produces a warning rather than a false guarantee.

## Connection diagnostics (4 October 2026)

Open **Connection diagnostics** from the room header or its connection status. See [definitions and report contents](rooms-connection-diagnostics.md).

1. Use an isolated empty room: before a configured tracker answers it should show discovery, then waiting for participants. Use an unreachable tracker separately and check the problem count; silence must not become a claim of a wrong invitation. Add a second client and check channel negotiation, accepted greeting and synchronization. Close it and check waiting plus retained last-success times.
2. Keep a file transfer and a voice call active and select Retry discovery. Existing channels and file clients must remain; microphone capture, screen sharing and LAN must not restart. Tracker acknowledgments reset for this attempt and return as new responses arrive. A failed tracker must not hide a working peer.
3. Compare a direct control channel and a real TURN-required connection against the selected candidate pair in WebRTC statistics. An unused configured TURN server must not count as the selected route. Compare gossip through a member separately; file/voice/LAN transports may take other paths. Unknown voice quality must stay unmeasured, not good.
4. Activate the VPN kill-switch: the panel remains available, traffic/activity counts stop, and Retry is disabled. Inspect a saved room after the room engine fails; opening the panel must not trigger recovery itself. Use explicit Retry, then check that voice/screen/LAN require their usual explicit actions after engine loss.
5. Copy and save JSON. Inspect it for names, identifiers, invitation/code, keys, addresses, tracker URLs, raw errors, SDP, chat, file names and paths: none should be present. Cancel a save and check that it does not announce success. Verify only bounded fixed events/counts/times remain, and that restarting the app resets session observations.
6. Check the dialog in the standard and custom themes, at narrow window sizes and with keyboard focus/Escape. Switch rooms or close it while a refresh/action is pending: late results must not alter the next room's panel.

Automated suites: shared/room-diagnostics.test.ts, shared/room-protocol.test.ts, room-liveness.test.ts, room-manager.test.ts and room-engine-lifecycle.test.ts. Native/UI checks: `node scripts/smoke-room-lifecycle.cjs` and `node scripts/smoke-room-diagnostics.cjs` after building Electron.


## Stage 5.2: optional playback host

See [protocol, limits and automated checks](rooms-watch-host.md). On two updated desktop profiles plus an updated browser guest:

1. Open the same playable file in sync. In the owner player choose a host. Confirm shared play/pause/seek/rate/file changes originate only from that host.
2. Use a follower control or music queue entry. A request must appear for the host; dismissing must not move others. Accept a seek or file change and verify all in-sync players follow. Repeat with the browser as host.
3. Change the host with a request pending. The old request and old host controls must not execute. Return to Shared control and verify ordinary collaborative controls work.
4. Delay a viewer source, pause a ready viewer, disconnect a viewer and close/opt out the host. Check ready/buffering/local/unknown statuses and absence messaging. No missing viewer may force a global pause. The owner must be able to replace an absent host.
5. Join late, including on a different initial file while the host is paused. Follow the host file/position from a beat. Toggle sync off and verify volume, subtitles and local controls remain personal.
6. Transfer ownership, rotate the invitation, then join through a surviving holder. Verify host policy follows the documented ownership/topic rules. Check the mixed-version update warning.

The host choice is a session preference: a full restart of all holders returns to Shared control. Run `node scripts/smoke-room-playback.cjs` for isolated native direct/HLS and both-player request checks; it does not replace this physical-device acceptance.
