# Shared room playback model

Implemented on 4 October 2026 for stage 5.1 of the rooms plan.

Desktop RoomPlayer and browser GuestApp use `shared/room-playback.ts`. The signed
`sync-v2` wire format is unchanged. The engine, preload and guest retain the
session ID, session epoch and sequence in player events, so a queued state cannot
accept an older or closed session as a fresh command.

## Position, speed and drift

The expected position uses the sender's playback rate. It includes estimated
transit time at reception and all time spent loading the local source afterwards.
Transit is estimated from the signed timestamp and bounded to 0–2 seconds. This
is not an RTT measurement or a clock synchronization protocol: widely different
system clocks and unusually delayed relays still need manual verification.

In shared-control mode, heartbeat catch-up remains forward only. Drift below 0.2 seconds is tolerated;
drift up to 1.8 seconds uses a temporary rate adjustment of at most 5%, restored
after 2.5 seconds. Larger drift seeks. Explicit seeks can move either direction.
Play/pause/rate messages carry a complete state; small position differences do
not cause unnecessary seeks. In shared mode, a deliberate local or received pause
is preserved against another viewer's playing heartbeat. Host mode follows only
the chosen host, including a missed pause recovered from a heartbeat; a follower's
local controls become requests while sync is enabled.

Heartbeats and track changes carry the intended rate, including 0.5×, 1.5× and
2×. Temporary drift corrections are not advertised as a new chosen rate. Volume,
mute, subtitles, output device, equalizer, shuffle and repeat preferences remain
local. Buffer starvation and seeking have separate status messages; waiting for
data does not emit a deliberate pause command.

## Source changes and pending operations

There is one pending playback state while metadata is unavailable. A newer
control replaces it; a local queue selection, closing the player or disabling
Together cancels it. A remote track change keeps its state until the new source
loads. Paused states do not extrapolate; playing states account for local loading
time. Native autoplay is not allowed to override a queued pause.

The echo guard follows the actual seek and play promise rather than a 250 ms
timer. It has a 10-second recovery deadline. A matching late seeked event is still
suppressed after that deadline; a different local seek can supersede the remote
operation. Binding, source replacement and teardown release listeners, operation
timers and rate correction timers. Desktop also releases its WebAudio play
listener. Browser teardown cancels its heartbeat, ignores late torrent callbacks
and revokes blob URLs that its fallback created.

Moving/recreating the media element preserves position, pause state and rate.
The guest language switch recreates the source cleanly while preserving those
values. Chromium/browser autoplay policy can still require a user's play gesture;
the model does not bypass that policy.

## Audio queue

A mounted player uses one watch session across track changes. Join and leave
describe entering/leaving the player, not each audio track. Track messages include
rate, playing and Together, and receiving a track does not re-broadcast it.

Automatic queue advancement uses the lowest member ID among the current track's
Together viewers observed within 16 seconds. Explicit local next/previous actions
remain available. Desktop keeps its existing local queue and shuffle/repeat
choices; a guest can advance supported unencrypted audio. Followers take the
announced track even if their local queue differs. Once watcher presence converges,
only one viewer advances automatically. Network partitions or missing presence
can still produce competing advances; this is not an elected playback host.
Stage 5.2 adds an optional owner-selected host and viewer readiness. In host mode,
only the chosen host advances the queue and followers request changes. See
[host mode and limits](rooms-watch-host.md).

Selecting the current desktop queue track restarts it without waiting for a new
metadata event. Its rate and watch session are retained, and subsequent remote
controls continue to apply.

## Verification

Unit tests cover rate-aware projection, bounded clock/transit estimates, slow
and timed-out seeks, late events, newer local intent, pending track/pause states,
closed sessions, temporary rate correction, source recreation, disposal,
buffering versus pause and queue-driver selection. Guest tests cover late
torrent/blob callbacks and retain signed session metadata through the mesh.

`node scripts/smoke-room-playback.cjs` creates isolated synthetic MP4/WAV/HLS
media and serves it only over loopback. It mounts the actual RoomPlayer and
GuestApp with injected room/torrent boundaries and window/shell fixtures. Native
checks cover a delayed HLS seek exceeding 250 ms without control echo, direct
playback, remote rate/pause, queue rate/session retention, guest language remount
and teardown, including reselecting the current desktop track. No physical
microphone, user rooms or external peers are used.

Two physical clients plus a browser guest, real Internet latency/NAT/VPN,
autoplay permission prompts, long live transcodes, popout windows and mixed
client versions remain acceptance in stage 7. Rebuild/publish the guest assets
before checking the updated behavior on an externally hosted guest page.
