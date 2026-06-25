# Testing rooms (friend swarms) on one machine

Rooms are peer-to-peer (WebRTC rendezvous + WebTorrent transfers), so verifying
them normally needs two different computers. To make local testing possible, set
the `TH_INSTANCE` environment variable: it launches an **isolated second copy**
of TorrentHunt with its own profile (separate DB / config / room identity) that
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

The second window's title bar reads **“TorrentHunt — peer2”** so you can tell them
apart. Each instance has its own room identity (name + avatar), so they show up as
distinct members in a room. You can launch more with different names
(`peer3`, `peer4`, …).

> Both instances load the renderer from the same dev server (Terminal A), so start
> `npm run dev` first and wait for webpack to finish before launching peers.

## What to verify

1. **Join / presence.** In peer1 create a room → copy the invite code. In peer2
   *Join by code*. peer2 should appear as an online member in peer1 (avatar +
   green dot) and vice-versa.
2. **File transfer.** peer1 adds a file → it auto-downloads into peer2's room
   folder with live progress; the “who has what” list updates on both sides.
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

## Notes

- TURN relays are on by default (Settings → Network → Sharing), so cross-NAT —
  and same-machine — connections work. Turn it off to test the STUN-only path.
- Isolated profiles live next to the real one, e.g.
  `%APPDATA%\torrenthunt-peer2`. Delete that folder to reset a test peer.
- `TH_INSTANCE` is a **testing aid only** — production builds are single-instance.
