# Large room manifests and voice capacity

Implemented on 4 October 2026 for stage 4.3 of the rooms plan.

## Manifest transport

Desktop and browser guests share `shared/room-manifest-sync.ts`. Large HELLO
snapshots use at most 64 collection entries and 96 KiB of UTF-8 JSON per part.
Encryption/base64 overhead remains below the existing 1,000,000-character frame
limit. Small greetings keep their previous form. Signed file revives, deletions,
ownership chains and E2E configuration are carried unchanged and still verified.

Each snapshot has an ID, timestamp, part index and total. Receivers merge entries
incrementally, reject duplicate/stale parts and report a direct channel as synced
only after every part arrives. Receiving only the final part is insufficient.
Availability is assembled across parts; desktop retains only IDs from its accepted
manifest. Guest viewers do not retain availability inventories.

Bulk work uses one replaceable pending snapshot per wire, round-robin scheduling,
and byte/signature pacing. It waits while the data channel has at least 512 KiB
buffered. Control messages, voice signaling and playback signaling do not enter
this queue. Relayed manifest parts have a separate bounded queue: at most 256
queued sends and 4,000,000 bytes. Room closure, code rotation, destroyed wires and
network suspension prevent obsolete queued sends.

The diagnostics Retry action also requests a fresh manifest on existing direct
channels. Receivers rate-limit these requests to one full response per wire per
10 seconds. Overflowed relay queues may discard bulk sends; reconnect/retry is
the recovery path, rather than unlimited buffering.

## Retained data

Accepted file manifests have a shared ceiling of 5000 files, 16 MiB of serialized
metadata, and 64 KiB per file entry. Admission accounting is incremental; deletion
releases space. These are metadata limits, not limits on downloaded file sizes.
Rejected additions do not evict accepted files. Desktop displays a capacity
notice; local additions fail explicitly at the file-count ceiling.

Folder maps are capped at 512. File deletion/revive clocks and folder deletion
clocks retain at most 5000 IDs each. A full clock collection refuses a new ID
instead of forgetting an old replay floor. Updates to a known ID still work.
Persisted manifests retain the same 5000 entries as the engine: the previous
1000-entry truncation is removed. Folder/clock storage uses the same shared caps.

Manifest HELLO pages persist through one bounded IPC batch per page, including
their activity events. The manager checks the current engine/top frame and room
lifecycle before accepting a batch. Each collection in a batch contains at most
64 entries. Unpaged greetings from older peers are split into the same bounded
persistence batches, so valid legacy manifests also survive restart. Loose files
discovered at startup are seeded sequentially, with a
small pacing interval and a lifecycle check before advancing.

Manifest assembly retains bounded part maps. Direct wires accept one manifest
author; relay assembly accepts up to 256. Incomplete availability is capped at
512 KiB per author and 16 MiB per assembler and released upon completion. Existing
member, identity, wire, chat, receive-queue and traffic limits continue to apply.
The unused `electron/utils/room-memory.ts` module, including its conflicting
5000-message chat limit, was removed.

## Voice overflow

The mesh supports nine admitted participants: each has at most eight media
connections. Desktop and guest retain up to 256 signed presence announcements
and deterministically select the nine lowest member IDs. Once presence converges,
every updated participant selects the same composition regardless of arrival
order. This is a capacity wait, not a first-in-first-out queue: a newly announced
lower ID can displace a current participant.

Waiting participants remain visible. Their microphone track is disabled for
transmission and no media peers are allocated for them. Presence changes reconcile
the mesh, retain connections that remain admitted, close excluded connections,
and admit eligible waiting participants. Mute/deafen choices and replay floors
are preserved. A lost slot is not presented as a failed connection.

## Verification and limits

Automated coverage includes 500/5000-file encrypted round trips between actual
room-engine modules with injected tracker/transport boundaries, browser handling
of 5000 files, serialization/restoration of all entries, three simultaneous
5000-file outboxes under ingress budgets, reordered/duplicate parts, backpressure,
coalescing, byte/count limits, teardown, IPC sender checks, and voice overflow on
desktop and guest media-session implementations. An unpaged 500-file legacy
greeting is also checked for complete, bounded persistence.

`manifest-pages-v1` and `voice-mesh-v1` are advertised capabilities. Older clients
can merge paged file additions, but do not assemble complete availability or
share the new voice admission rule. Update all clients for these guarantees.
Guest assets are built locally; publishing the updated guest page is separate.

Tests use synthetic media and isolated storage. Real 5000-file disk/seeding
performance, audibility across devices, restrictive NAT/TURN, VPN changes and
sleep/resume remain manual acceptance in stage 7. These checks do not establish
a universal download speed or a fixed global process-memory ceiling.
