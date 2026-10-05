# Desktop room receive queue (step 4.1, first part)

All desktop rooms share two receive slots and at most 512 active or waiting jobs. A slot covers receiving, hash verification and the resulting decryption attempt; a completed seed does not occupy a receive slot. Restored files also use the queue during local verification. Browser guests do not write room files to disk and do not use this queue.

The file list shows the room's active receives, waiting count and waiting plaintext bytes. A file's waiting position is across all rooms. The context menu can move a waiting file to the front without interrupting active transfers. Pausing receiving stops that torrent, keeps its owned partial path and saves a local pause flag. Resume explicitly queues the same file again. Automatic fetching and folder rules do not override the pause. Old clients ignore the pause flag; this guarantee requires the updated desktop client.

Pausing receiving and stopping seeding are separate actions. Pause is available while waiting or downloading, not during final verification/decryption or after completion. A room-wide delete or local hide cancels the file's queued work through the existing remove action. Exiting a room, removal by its owner and VPN suspension cancel queued work; stale callbacks cannot restart it in a new session. Graceful exit holds active slots until the WebTorrent client closes its stores.

## Disk checks

Before allocating a receive path, Havvn checks the destination volumes and reserves the complete file size against other room operations. Each volume keeps a 256 MiB safety margin. E2E receives reserve ciphertext size (plaintext plus 28 bytes) in the cache and plaintext size in the destination, combining the amounts when they share a volume. Authenticated publication uses a temporary file and hard link, so publication does not allocate a second plaintext copy. Local E2E encryption, legacy-copy migration and a later local decrypt retry also check and reserve their output space.

Reservations are deliberately conservative: they remain for the full operation and do not subtract partially written bytes. A resumed receive can therefore require more free space than its remaining bytes. Completed files are accounted for by the filesystem's current free-space result. This is local coordination between room operations, not an OS quota or reservation against other applications.

Receive-store writes check current free space at most once per second and refuse new writes after cancellation. Another application consuming the safety margin produces a disk-full error instead of silently continuing. An already submitted write or another process can still consume space between checks. An unavailable disk probe rejects preparation; Havvn does not assume the volume has unlimited free space. Existing source files and partial downloads remain available for explicit retry.

Torrent metadata must match the manifest's hash, exact single-file name, size, piece length and piece count before a writable chunk store opens. Downloaded bytes still pass original torrent-hash verification; receiving 100% ciphertext does not mean plaintext is ready.

## Waiting and errors

A receive without metadata fails after 60 seconds; a receive without another downloaded byte fails after three minutes. The error releases its slot and can be retried. These are local inactivity deadlines, not a prediction that peers will become available. Playback can prioritize its queued file, but waits at most five seconds for a slot and at most 25 seconds overall for metadata; timing out does not silently start a playback server later. The requested file remains in the receive queue. Pausing receiving or a transfer failure also closes that file's old playback server; resuming playback creates a fresh stream.

## Shared file traffic and voice priority

Settings → Sharing → Room traffic and screen sharing controls one file budget for all desktop room WebTorrent clients on this install. The default upload ceiling is **256 KB/s total**, and the default download ceiling is **0 (unlimited)**. A per-room ceiling is an additional upper bound: zero inherits the shared budget. A finite budget is divided equally among existing room file clients, with spare allocation from individually capped rooms redistributed. Clients are created lazily; idle clients can retain a share until the room closes. The room file panel shows its effective allocation, including zero before a client starts. Closing a client returns its allocation to the remaining clients.

Voice priority is on by default. While at least one local room voice session is joined, the shared file budget is reduced to at most **64 KB/s upload and 2048 KB/s download**. A stricter configured limit stays in effect. Leaving the last call restores the normal budget; muting does not restore it while still joined. An explicitly unlimited normal budget still receives these finite bounds during a call. This reserves headroom rather than guaranteeing call quality on an unknown connection.

New clients start with both directions blocked until allocation succeeds. Live updates lower old ceilings before allocating the freed budget. Application failures restore the previous allocation; a failed rollback stops the affected file clients. Preferences saved but not acknowledged by the engine are reported separately and retried on room activation. Settings survive an engine restart.

These are WebTorrent file transport limits with token-bucket bursts, not a hard ceiling on the whole application or WAN interface. Room signaling, voice, video/audio screen sharing, LAN, game servers, regular torrents and browser guests have separate transports. HTTP streaming to a local player is also outside this network budget. Regular torrent limits and VPN suspension still operate independently.

## Screen bitrate

Screen video has a separate **250–20000 kbit/s** encoder ceiling, default **2500 kbit/s per remote participant** (decimal units). Changing it updates current senders and peers joining during a share, without reopening capture. Screen video remains capped at 15 fps. Multiple remote peers multiply outgoing screen traffic; screen audio and protocol overhead are additional. The encoder may use less bandwidth and sender parameter application is best-effort; a connected peer reports a warning if applying the cap fails. The local preview/forwarding encoder retains its separate 10 Mbit/s cap.

## Fetch choice for new rooms

Create and join dialogs offer automatic downloading explicitly; it is **off by default for a new room**. With it off, shared files are listed without downloading until requested. Existing room preferences, including legacy rooms with an absent autoFetch field (historically on), are preserved when rejoining. Folder overrides and per-file paused receives continue to apply.

Cache cleanup and history remain step 5.4. Actual two-device throughput, voice quality, VPN/NAT and a nearly-full volume remain manual acceptance in step 7.

## Verification

`room-receive-queue.test.ts` tests scheduling, cross-room priority, cancellation, bounded waiting, E2E volume accounting and disk checks. `room-receive-integration.test.ts` runs the actual preload command handler with local network doubles and checks two live receives across rooms, advancement on completion/error, pause/resume, persisted pause, disk refusal, metadata refusal, writes after cancellation and teardown. `room-file-storage.test.ts` additionally checks the real WebTorrent chunk store and hash verification on local files.

Room traffic regressions cover shared allocation, redistribution, voice transitions, failures and actual byte streams through the installed WebTorrent throttle groups. The manager suite checks persistence, saved/applied outcomes, startup and legacy fetch preferences; voice recovery tests inspect current and mid-share sender parameters. The isolated Electron smoke checks resource persistence and real preload application across an engine crash.

Repeat receiving on two isolated desktop profiles before accepting real-network behavior: queue three files, pause the active and waiting ones, resume, restart while paused, finish an E2E file, and test a disposable nearly-full volume. Do not fill your normal system disk for this test.
