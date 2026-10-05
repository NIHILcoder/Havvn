# Room local data — stage 5.4

Open the room gear menu → **Room data**. All controls use the shared themed Modal, Button, Select and Toggle, including custom themes and narrow layouts. The dialog provides refresh, explicit errors and retry, a file selection and confirmation with the selected byte count.

## Disk accounting and copy cleanup

Plaintext accounting covers `.havvn-files` in the room's download folder; encrypted accounting covers that room's `room-enc` cache. It includes abandoned slots, without following symlinks/junctions. Source files are counted separately, once per path. Values are file sizes, not filesystem allocation units. Traversal is bounded; inaccessible, unsafe or excessive entries are reported as skipped. Bytes with no publication mapping are shown but never offered for automatic deletion.

Only tracked, managed copies can be selected. Originals and the ciphertext backing an original E2E publication are protected. Encrypting an original again creates different ciphertext and a different torrent info hash, so that cache is not disposable merely because the plaintext still exists.

The engine issues a one-use, five-minute preview bound to its live room. Before deleting, it checks each target's filesystem identity and every ancestor. It rejects junctions, symlinks, hard links, an external path, another file ID and a changed preview. Deletion is per file, never a recursive folder sweep. A changing file may require pausing receiving and refreshing the preview first.

For selected files it closes playback streams, invalidates pending work, closes the torrent's store and waits for outstanding operations. A per-file barrier serializes a racing manual fetch. It preserves publications, names, signatures, folders, deletion/revive proofs, bans, all old content keys and TOFU bindings. The local receive hold is persisted and prevents automatic re-download, including after restart. Use **Download** to fetch again. A failed batch can have cleaned earlier files; the dialog shows an error and Refresh recalculates what remains.

Cleanup cannot create a remote source. If the removed bytes were the last surviving copy of that torrent, the retained publication and keys alone cannot recover them. This is stated before confirmation.

## Local history

The network/rejoin chat window remains 200 messages. Desktop has a separate archive of up to **5,000 messages and 5,000 activity events per room**, loaded in pages of **50**. A browser guest retains its existing in-memory window; this is not a shared server archive.

Retention choices are 7, 30 (default for new rooms), 90 or 365 days, or no expiry with the same record cap. Existing rooms without this preference keep their previous no-expiry behavior until you explicitly change it. Message expiry uses the locally stamped receipt time, not the sender's clock. Activity events use their locally generated time. Shortening retention requires confirmation and atomically prunes messages, events and corresponding stored edit bodies. A manager timer checks at startup and every hour even without traffic. Encrypted text and reply quotes remain OS-protected; loading a page decrypts its messages rather than expanding the wire payload. Edits are retained with their archived messages; the history view displays their latest stored text.

ID cursors survive new arrivals. An expired cursor returns an explicit result and reloads the latest page. Archive duplicates do not produce a second unread notification; archived outgoing IDs also reject conflicting retries after the small recent-message/receipt window expires. Leaving a room clears its local archive and retention preference. Expiry is local: other participants can deliver an old message again after this install forgets it.

History is **not included in the identity recovery file**. Save needed text separately before reducing retention. Local deletion does not erase another participant's copy or copies in filesystem backups.

## Protected recovery

Room data exports this room plus the signing identity. Settings → Sharing exports the identity and all joined rooms. Both require a password of at least 12 characters, its confirmation and an acknowledgement. The `.havvn-backup` file contains authenticated ciphertext only; passwords and payloads are redacted from IPC argument logs and are never saved in settings. Cancel and failed writes preserve the existing backup; ciphertext is written to an exclusive temporary file and renamed after flush.

The versioned envelope uses AES-256-GCM, independent 16-byte salt and 12-byte nonce, and asynchronous scrypt with fixed N=65536, r=8, p=1. The algorithm/version is bound by associated data. Untrusted files cannot request arbitrary KDF costs. Limits are 32 MiB for the decrypted payload and 48 MiB for the envelope. Password/key handling follows the [Node crypto API](https://nodejs.org/api/crypto.html); no cryptographic primitive is reimplemented.

The payload contains the profile and Ed25519 keypair, invitation, current and **every retained previous key**, signed config/key pages, signed bans, ownership chain, manifest, folders, TOFU identities and deletion/revive floors. It excludes file bytes, chat/history, executable/LAN/server configuration and local source/cache paths or write privileges. It does not serialize transient playback-host selections.

Restore is deliberately restricted to a profile with **no joined rooms**. It validates the bounded schema, matching Ed25519 keypair and derived memberId, prepares OS-protected records, then commits identity and recovery records in one store write. Wrong passwords, corrupted data, unavailable OS protection and a failed store write leave the current identity intact. A successful restore stops the old manager immediately and requires restart. The engine re-verifies signed proofs on rejoin; import does not grant unsigned ownership. Restored rooms get fresh local folders with auto-fetch off and files on receive hold.

A new profile normally creates a new memberId; restoring the backup preserves the saved one. Do not run that identity on two machines at once. Havvn does not retain the password and cannot recover a forgotten one. The previous plaintext JSON export is no longer exposed by the UI; it is not accepted as an encrypted backup. Existing installed room records and signing keys continue to use the previous OS-storage migration.

## Manual checks

1. In an encrypted room share a source, fetch a peer's file, and leave a partial download. Compare Room data counts with the managed directories. The source and its cipher must be protected; unknown cache files must be counted but not selected.
2. Select a downloaded copy, confirm its volume, clean, and restart. The publication and old keys must remain; receiving must stay paused until Download. A source selected for publication must never disappear.
3. Change a selected copy after Refresh: cleanup must reject the stale preview. Retry after refresh; no success message should appear if closing a store or removing a file fails.
4. Receive over 200 messages. Local history must show earlier pages, edited bodies and quotes after restart. Reduce retention; old bodies must be removed from storage. Repeat with no new traffic across expiry.
5. Export a room and all rooms separately. Cancel a save, fail a write, try a wrong password and alter the ciphertext. The file must contain neither PEM nor invitation/key text; failed restore must not replace identity.
6. Restore in an empty test profile, restart and compare memberId, signed bans, ownership/deletion floors and paged key history. Download an old-key file from another holder. Do not use your sole working profile for a destructive acceptance experiment.
7. Check dark, light, custom Aero and 380 px layouts. Controls must inherit colors/radii and remain keyboard accessible; long filenames and history bodies must wrap.

Physical peer recovery, loss of the last remote copy, active playback/Windows antivirus locks and restore/restart in a packaged build remain part of stage 7 acceptance. In development, stop the dev process and run `npm run dev` again if relaunch cannot keep the renderer server alive.


## Automated verification (2026-10-05)

- Full final run: 203 Vitest suites / 2810 tests, plus 7 Node launcher tests (2817 total), all passed. The first run exposed outdated test expectations for the new maintenance timer and modal inventory; the complete rerun passed after updating those expectations while retaining shutdown/no-leak assertions.
- Electron, renderer and guest type checks and production builds passed.
- Native UI fixture: actual React components in Electron, history pagination, protected-source exclusion, confirmation/failure/retry, password-repeat validation, password clearing, restore restart, themed controls and 380 px layout. Script: scripts/smoke-room-data-ui.cjs.
- Native Windows storage fixture: actual OS protection on an isolated profile, password encryption, wrong-password refusal, old keys and signed pages/bans/deletion floors after reopening, stripped portable paths and successful old-key file decryption after restore. Script: scripts/smoke-room-storage.cjs. OS protection is unavailable inside the sandbox; this check passed outside it and never fell back to plaintext.
- Regression tests cover stale previews, partial-download store closure and a racing explicit fetch, symlink/junction/hard-link refusal, protected original ciphertext, untracked cache accounting, archive paging/duplicates/edits/physical expiry and atomic failed restoration.
