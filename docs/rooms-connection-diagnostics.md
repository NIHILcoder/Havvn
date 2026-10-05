# Room connection diagnostics

Open a room and select **Connection diagnostics**, or click its connection status. The same panel is available when the room engine has failed or the VPN kill-switch has suspended networking. Opening it reads the cached state; it does not start an engine, join a room, request microphone access or resume sharing.

## What the stages mean

- **Discovering**: discovery has started but no configured tracker has acknowledged an announcement and no participant connection has succeeded yet. Calling `tracker.start()` is not evidence of success.
- **Waiting for participants**: a configured tracker has answered, or a participant was previously connected, but there are no current channels. An empty serverless room cannot prove that an invitation is wrong or that every participant is offline.
- **Connecting**: a discovered peer is negotiating its data channel.
- **Checking participant**: a channel is open but its greeting has not been accepted. Frame decoding, schema and identity failures are counted separately; an unreadable frame alone does not prove a wrong invitation.
- **Synchronizing**: an identified channel has sent an explicitly incomplete greeting and has not sent its full greeting yet, or an E2E room still lacks its content key.
- **Connected**: there is an identified open channel without those outstanding conditions. This describes the control channel, not a guarantee that every file, voice link or LAN tunnel works.
- **Engine stopped/failed, networking suspended, removed** override the live stages. Live channel and activity counts are zeroed rather than reporting stale successful connections.

Last connection time records a channel's first accepted greeting. Last synchronization time records receipt and processing of an explicitly full greeting from an updated desktop peer. Subsequent short greetings do not undo that observation. Older peers and browser guests do not necessarily provide the full-greeting marker: absence of a timestamp means unmeasured, not failed. Receipt of a full greeting does not certify global manifest convergence or file verification.

## Counts and routes

Tracker counts refer to configured tracker URLs, internally reduced to indexes. Open/pending channels and unique online people are separate counts because one person may have several channels. A failed tracker or peer does not mark all other channels as failed.

**Direct/TURN/unknown** comes from the selected ICE candidate pair of the room's control data channel. Having a TURN server configured, or finding an unused relay candidate in statistics, is not enough to claim a TURN connection. Statistics without the selected pair or candidate types remain unknown. **Through another member** is gossip forwarding and is reported separately.

Files, voice and LAN have separate health indicators. File errors are classified by fixed codes; queued files use the actual receive queue. Unmeasured voice/LAN quality stays unknown. A LAN route through another member does not inherit the quality of the relay's direct leg. These indicators do not describe the separate WebTorrent/voice/screen/LAN transports as if they shared one selected ICE route.

## Retry and export

**Retry discovery** reannounces this room to trackers while preserving its established data channels and file clients. It does not restart microphone capture, screen sharing or LAN. A stopped engine may be reactivated by this explicit action. A synchronous tracker-start error is returned to the caller; initiating discovery is not reported as successful participant connection. Concurrent retries coalesce; leaving, removal and the VPN safety pause block or cancel the operation. Events from a replaced tracker are ignored.

**Copy report** and **Export JSON** use the same allowlist projection, rather than serializing `RoomState` or logs. Schema 1 contains app/protocol versions, engine/connection stages, bounded counts, timestamps and up to 24 recent fixed event types with occurrence counts. There are no room/member identifiers or names, invitations, keys, raw errors, IP/host addresses, tracker URLs, SDP, chat, file names or local paths. The default export name is `havvn-room-diagnostics.json`. The report stays local until the user chooses to share it; cancelling the save dialog does not claim success.

Observations are session-only and bounded. The manager retains the last safe connection snapshot across an engine failure during the current app run. App restart does not restore diagnostic history. Reports can still reveal approximate activity counts and times, so they are reduced diagnostics rather than a promise of anonymity.

## Verification

Automated coverage includes phase progression, bounded history, selected ICE pair classification, allowlist redaction, unknown quality, offline/crash/suspension, actual engine handshake and full/short greeting behavior, preserved channels on retry, replaced trackers, retry coalescing and cancellation on leave. Native Electron smoke checks read-only inspection and engine command handling. The UI smoke runs the actual React dialog with synthetic reports at 1100/700/400 px, theme radii, copy/export cancellation, disabled suspended retry and a stale refresh rejection after an action.

Real NAT, TURN, VPN/interface changes and two-device voice/file behavior remain the manual acceptance cases in [testing-rooms.md](testing-rooms.md). A panel cannot determine an unavailable remote peer's firewall configuration or infer an invalid invitation from silence.
