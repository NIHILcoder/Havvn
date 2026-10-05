# Signed room bans v1

Implemented in plan step 3.4. A ban excludes a known profile/memberId. It is not a permanent ban of a person, owner approval of every join, or revocation of files and keys already received. Anyone with the current invite can join using a new identity. The full invite's owner pin and verified transfer chain authenticate owner authority; the short code retains the existing first-seen trust model.

## Snapshot and trust

Updated desktop owners mint `banState` containing `{v:1, ownerId, revision, bans, pub, sig}`. The list is strictly sorted, unique, excludes the signing owner, and contains at most 2048 IDs, each at most 128 characters. A positive safe-integer revision orders snapshots from the same owner. Ed25519 signs the UTF-8 JSON bytes of:

```text
["th-room-bans:v1", topic, ownerId, revision, bans]
```

The signature binds the current gossip topic: a snapshot from before a code rotation cannot apply after it. The signing pubkey must derive the claimed memberId and match its known binding. Only the current owner, established by the invite pin/verified chain or the existing first-seen model, can supply a snapshot. A replacement must include every ban already held locally; lower revisions and conflicting signatures at the same revision are refused. No implicit unban is supported. Unknown extension fields are discarded before persistence.

HELLO carries the independent proof. Public ban/owner-chain proofs may appear in the initial slim greeting; it still withholds content secrets, cfg, manifest and chat data. This lets an excluded profile learn its status before receiving private file data. Incoming proofs pass schema, identity, signature and work budgets. Owner-chain adoption precedes ban authority checks. Wrong-owner or stale valid extensions are removed before relay; a forged signature rejects the frame. Apply bans before full greeting/backfill, file adoption and relay from that sender. Known banned wires, presence, typing, voice and LAN membership are removed. Learning that self is banned stops desktop room file swarms as well as gossip/voice/LAN, without deleting source or downloaded files.

Accepted snapshots are saved with the complete local ban list and re-served by holders when the owner is offline. The topic-bound signed proof is stored inside the OS-protected room envelope alongside the invite code and content keys; public ban IDs remain metadata. Legacy records, including already protected records that hold this proof in public fields, migrate atomically before use. A locked or damaged envelope remains preserved and does not start room networking. Repeated identical proofs cause no additional persistence or adoption-triggered flood. Legacy local bans remain in place during migration. The room manager accepts persistence events only from its current engine main frame; failed writes retain the complete update for the existing recovery/retry flow.

## Rotation and ownership

An owner re-signs all held bans after a code rotation. Other members retain their bans, clear the stale snapshot and learn the fresh proof. No ban is silently evicted at capacity: another new ban is refused before sending kick/rekey.

A live handover carries an independently signed current-owner snapshot beside its frozen v1 transfer signature. Recipients consume it before the handover, and the new owner re-signs held bans with its own key. A handover to an ID in that snapshot is refused. A HELLO presenting an advancing chain applies the chain first; a deposed owner's snapshot cannot poison the new owner. A holder with the current-owner snapshot can authenticate a late join even after a past owner was banned. A previously accepted ownership chain can only be extended; a newer signed fork cannot replace it and is dropped before HELLO relay. Historical chain-link signatures remain valid despite that signer's later ban; this grants no live authority to the banned signer. Local handover is refused while a deferred kick/rekey is pending.

## Compatibility and limits

Updated desktop and guest clients advertise `ban-state-v1`. Existing transfer/rekey/cfg canonical bytes are unchanged; older peers ignore the extra proof and cannot be relied upon to preserve/re-serve it. This feature requires updated owners/holders along the sync route. A peer can strip or withhold a snapshot; a fresh joiner cannot infer a ban it never received. The snapshot is evidence from the owner, not proof of completeness of all network state. A fresh joiner without a known chain checkpoint cannot independently select the latest branch of an equivocating v1 root; use the current owner-pinned invite when available. Legacy HELLO/presence is still not a signed possession-of-identity handshake. Strict membership with owner-approved joins remains a separate optional design.

Profile resets or a newly shared current invite can change access. Previously received plaintext, ciphertext, old content keys and public file swarm identifiers cannot be revoked remotely. Browser guests do not gain owner management or E2E file playback. This change does not alter guest-page hosting/deployment.

## Verification

`shared/room-bans.test.ts` checks Node/WebCrypto bytes, tampering, topic replay, revision/superset rules, bounds and proof filtering. Desktop preload integration verifies kick/rotation, holder restart, owner departure, late join, delivery to an actual GuestRoom, excluded self without content-key adoption, stopping a file swarm, ownership handover and banning a past chain owner. Guest regressions cover forged/foreign/stale proofs, pre-reply exclusion, current-owner handover and poisoning via deposed-owner HELLO and a genuinely signed newer fork from a banned past owner, rejected before relay. Store/manager tests verify signed-byte preservation, import/export, engine sender validation and retry after a failed write. Network transport is in memory; Ed25519 and encrypted gossip are real. Two physical devices, real VPN/NAT and old-version compatibility still need manual acceptance.

Final local validation on 3 October 2026: 187 Vitest suites / 2635 tests plus 7 Node launcher tests passed. Electron/renderer/guest type checks and production builds passed. The real Electron isolated-storage smoke verified Windows DPAPI, protected ban proof, intact signatures, migration/reopen/import and corrupt-record preservation. The separate lifecycle smoke passed with synthetic audio. Repository lint still reports 42 existing errors; the package introduces no new lint errors.
