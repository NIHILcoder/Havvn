# Room secrets and content-key history v2

Implemented in plan step 3.3 on 3 October 2026. The historical v1 cfg, previous-key, transfer and file cipher formats remain unchanged. New clients add an independently signed history descriptor and page messages; they do not modify the bytes an older client verifies.

## Storage and recovery

Each room in `rooms.json` retains its public metadata and a `secrets` envelope with `version: 1` and an `enc:v1:` payload. The protected JSON contains the roomId, invite code, current secret, previous secrets, complete owner-signed cfg and signed key pages. Step 3.4 also protects the topic-bound owner-signed ban snapshot in this envelope; public ban IDs remain metadata. Already protected records with a public ban snapshot migrate atomically to this format before use. Protecting the entire cfg/pages also protects every duplicate copy of a key. Signed fields survive JSON round trips unchanged.

This uses the existing [Electron safeStorage layer](https://www.electronjs.org/docs/latest/api/safe-storage). New writes fail when OS protection is unavailable; Linux `basic_text` is not accepted as protection. This is local OS account protection, not a portable password-protected backup or protection against every application running as the same user.

Legacy rooms are prepared in memory, then migrated with one atomic store write. Encryption or disk failure preserves the original record and reports a recoverable status instead of returning an empty key as success. An inaccessible, corrupt, swapped or unsupported ciphertext remains untouched; other rooms remain available. No room with a locked record is rejoined. Retry rereads OS storage access.

Failed live room-record writes retain the latest complete record in main-process memory and report `write-failed`. Explicit retry saves that record before returning the cached/live room. This is not durable until the retry succeeds; the UI says to retry before closing Havvn. The old disk record remains intact.

Portable identity import prepares protected room records, keypair and profile before one atomic commit. Export refuses locked records to avoid an incomplete backup. Stage 5.4 now exposes password-protected recovery files, with single-room and all-room export. Plaintext JSON is no longer written by the UI. Restore into a profile without joined rooms, with new local folders and auto-fetch off; signing identity, old keys and signed recovery proofs are retained. See [rooms-local-data.md](rooms-local-data.md).

## Content epoch and cfg extension

A new encrypted manifest entry has `keyEpoch`, a lowercase 64-character hex identifier. Ciphertext remains the existing `[12-byte IV][AES-256-GCM ciphertext][16-byte tag]`; its infoHash and integrity rules are unchanged.

The epoch is SHA-256 of the UTF-8 domain `th-room-content-epoch:v2`, a NUL byte, then the 32 raw key bytes. It identifies a random content key, not the rotating gossip topic. Seeding captures the key and epoch before asynchronous encryption; a concurrent rekey cannot label ciphertext with a different key. A legacy file gains an epoch only after successful GCM authentication. Missing epoch keys produce `waiting-key`; known epochs select their matching key directly. Legacy files without an epoch still try retained keys.

The v1 cfg continues to sign exactly:

```text
["th-room-e2e:v1", topic, ownerId, e2e, secret]
```

Its optional previous-key proof still signs exactly:

```text
["th-room-e2e-prev:v1", topic, ownerId, prevSecrets]
```

That compatibility list contains at most eight keys. It no longer limits the local history. The optional `cfg.keys` descriptor contains `{v:2, epoch, root, total, pages, sig}` and signs:

```text
["th-room-e2e-keys:v2", topic, ownerId, e2e, secret, epoch, root, total, pages]
```

The root is SHA-256 of the UTF-8 JSON array `[[epoch,secret],...]` for every unique held key, sorted by lowercase epoch using lexical comparison. The current key is included. Each page contains 32 entries, except the last. History is bounded to 2048 keys / 64 pages; reaching the limit explicitly blocks another content-key rotation, before a kick/rekey is sent. It never evicts an old key. A new room can be used at that limit; dependency-aware/manual key cleanup remains part of 5.4. Retention is deliberately conservative for legacy files whose epochs are not yet known.

## Page request and proof

Updated clients advertise `e2e-keys-v2`. A member requests a missing page with `{t:'e2e-key-request', memberId, root, page}`. Known-member, room ban, frame/byte/signature and relay budgets apply. Requests for a missing page retry at most once per ten seconds; the fifteen-second heartbeat also retries. A holder responds along the requesting wire with a relayable proof, even when the owner is offline. Outgoing answers are limited to once per page per ten seconds.

The proof contains `{t:'e2e-keys', ownerId, epoch, root, page, total, entries:[{epoch,secret}], pub, sig}` and signs:

```text
["th-room-e2e-key-page:v2", topic, ownerId, epoch, root, page, total,
 [[entryEpoch,entrySecret],...]]
```

Before adoption or relay, its signature, owner key, content-key IDs, bounds and matching authenticated cfg descriptor are checked. The complete set must reproduce the cfg root with no duplicated page/key. Out-of-order pages are valid. Duplicate pages do not grow storage; unknown extension fields and gossip IDs are not retained as key proofs. Stripping the optional descriptor cannot erase an already authenticated local history. Old-topic, wrong-root, wrong-owner and tampered proofs are rejected.

After ownership transfer, a new owner finishes the signed history before re-signing it under the new identity. A past chain owner's cfg/pages remain valid for this recovery on the current topic; they do not roll ownership back. Once a current-owner cfg is authenticated, a past owner cannot replace it; a recovery cfg also cannot change an already authenticated content secret. Kicking while that history is incomplete is refused. Concurrent kick requests cannot schedule conflicting key rotations.

## Compatibility and validation

Older clients retain the current key and their historical eight-key behavior. They cannot fetch/serve v2 history or reliably relay its new message types. Reading older files after many rotations requires an updated client and a route through updated peers. Browser guests still do not support encrypted room files. Keys already discarded by an older build cannot be reconstructed by this update; a participant with a readable plaintext copy can publish that file again.

Regression tests cover Node/WebCrypto proof bytes, modified signed fields, bounded pages, stripped descriptors, transfer before pages, retry after dropped pages, the retention limit, simultaneous kicks, OS/disk failures and atomic import. The real preload integration preserves and authenticates the original file after twelve kicks, restarts a holder with its signed history, removes the owner and decrypts the file on a late joiner. The transport boundary is in memory; torrent metadata and file/Ed25519/GCM cryptography are real.

`node scripts/smoke-room-secrets.cjs` uses a temporary isolated profile and actual Electron OS protection to check legacy migration, store reopen, proof verification, protected import and corrupt-record preservation. It opens no user room or remote connection. `docs/testing-rooms.md` covers the remaining two-device checks.
