# Optional playback host and viewer readiness

Implemented for rooms stage 5.2 on 5 October 2026.

## Using the modes

Shared control remains the default. In the desktop room player, the room owner
can select an online updated participant in **Playback control**, or return to
**Shared control**. A browser participant can lead playback; choosing the host
is an owner management action available in the desktop client.

In host mode, only the selected host changes shared play/pause, position, speed
and file. Followers' playback controls send requests and restore the host's
last state. The host can accept or dismiss requests in either player. There is
one pending request per viewer, at most eight visible requests, and requests
expire after 20 seconds. A host change invalidates all pending requests. Turning
off **In sync** allows local playback without sending shared controls.

The host is also the only automatic audio queue driver in this mode. Shared
mode keeps its existing presence-based queue driver. A late viewer can follow
the host's file and paused state from a heartbeat, even after missing the
original track/play/pause command.

Viewer cards distinguish ready, buffering/seeking/loading, playback errors,
local playback and unknown readiness from older clients. Readiness is reported
by the viewer's player; it is not a promise about their network or future buffer.
A paused file with playable data can be ready. Loading does not masquerade as
an intentional pause. Reports update on readiness changes and 5-second beats;
inactive viewers disappear after the existing presence timeout.

There is no readiness quorum, automatic global pause or automatic takeover.
When the host is absent, has left the player, is watching locally or has a
different file open, the player explains that the owner can choose another
host. Disconnected viewers cannot keep the whole room waiting indefinitely.
Volume, subtitles, audio output, equalizer and local audio preferences stay local.

## Protocol and authority

The current verified room owner signs `watch-policy-v1` over the room topic,
owner ID, verified ownership-transfer timestamp, host ID and monotonic timestamp. Empty host ID selects shared control.
Owner signature/identity checks run before adoption and relay, including policies
embedded in HELLO. Policies are transient, re-served for late joiners and not
written to disk as permanent preferences. A running holder can re-serve them
without the owner online; restarting every holder loses the session choice.
Ownership transfer resets the old owner's choice, including if ownership later returns to that same identity. After invite rotation, the
owner re-signs the current choice for the new topic; a holder does not re-serve
the old topic's signature.

The original `sync-v2` canonical bytes are unchanged. Updated senders attach
`v: 3` plus a separate `watch-host-v1` signature binding readiness, request kind,
policy owner/timestamp and the complete base command. Both signatures must
verify. Signed session epochs, sequence floors, clock bounds, identity binding,
membership/file checks and ingress budgets still apply. Updated engines and
guests reject follower controls, outdated policy stamps and legacy controls in
host mode before relay or delivery to the player. Requests do not execute until
the current host accepts them; local UI expiry is checked again on acceptance.

Capability advertisements guide UI only. `watch-host-v1` does not grant owner
or host rights. Older clients remain usable in shared mode because base control
signatures stay compatible. Older recipients do not enforce host policy and may
ignore the host choice; both players show an update warning in mixed rooms.
Network partitions can delay policy convergence; this is not distributed consensus.

## Verification

Shared tests cover owner revisions, old-host rejection, shared-mode restoration,
legacy behavior, malformed requests, and tampering with signed policy/readiness.
Encrypted desktop and browser mesh tests exercise genuine Ed25519 proofs,
HELLO policy verification, relay rejection, duplicate requests, late joins and
ownership handover. Manager tests check engine acknowledgement and error delivery.

`node scripts/smoke-room-playback.cjs` mounts the actual desktop RoomPlayer and
GuestApp in isolated Chromium with synthetic loopback media. It checks host
selection, buffering display, follower requests without control echo, acceptance
on desktop and browser, media retention on handover, and the existing direct/HLS,
queue, speed, pause and teardown scenarios. Room/torrent/shell boundaries are
injected. Real devices, latency/NAT/VPN, autoplay prompts, mixed deployed versions
and detached windows remain stage 7 acceptance.

Rebuild and publish guest assets before testing an externally hosted browser guest.
