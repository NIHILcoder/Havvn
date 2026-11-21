# Manual and scheduled room key rotation

The owner opens **Room settings → Rotate room key**. **Rotate key now** replaces
the invite code without removing anyone. Automatic rotation accepts an interval
of 1–1440 minutes and 1–1000 successful rotations; a count of 0 repeats until
stopped. The first rotation happens after one full interval. A manual rotation
does not consume a scheduled repetition.

Each change is an owner-signed `rekey` with an empty `kickedId`. Its signed bytes
are unchanged from the kick protocol. Updated desktop and browser clients
advertise `key-rotation-v1`; manual rotation and schedule creation refuse live
participants lacking it, and unidentified connected channels must finish greeting
first. Peers forward the verified message under the previous room key before
switching. Empty targets never enter the ban list or produce a kick event.

Connected peers keep their transport connections. Offline peers need the latest
invite to rejoin. Delivery uses the existing reliable data channels; a peer that
disconnects before receiving a change may also need the new invite. The owner
and peers persist the new code. In encrypted-file rooms, each rotation also
generates a new random content secret and retains authenticated old secrets for
reading old files. Existing ciphertext is not rewritten. The existing 2048-key
history limit applies; automatic rotation pauses if the history is full or
incomplete, rather than discarding keys.

The schedule is local to the owner's installation and is persisted with the
room. A single timer runs while that installation and room are active. Leaving,
network suspension, removal, and ownership transfer cancel its timer. Transfer
clears the old owner's schedule. On restart, a future deadline is retained;
an overdue deadline starts a fresh interval. Waking an active process performs
at most one overdue rotation, then starts the next interval from completion.
There is no burst of catch-up rotations. A pending kick delays the scheduled
attempt. Other failures pause it with the remaining count intact and an error
visible in the dialog; starting a new schedule resumes operation.

## Security scope

Changing the invite closes admission through the previous code; it does not
expel an existing participant, who receives the replacement key. Use **Remove
participant** to revoke access. Existing WebRTC media sessions have independent
DTLS-SRTP keys and remain connected: this feature does not rotate their keys,
provide a media ratchet, protect a compromised endpoint, or stop a participant
recording audio. Retained file keys preserve old-file access, not forward secrecy
for that stored content.

## Validation

- `shared/room-key-rotation.test.ts`: bounded plans, finite/unlimited repetition,
  owner-scoped restore, overdue deadlines, and paused errors.
- `shared/room-protocol.test.ts`: victim-free rekeys and signature tampering.
- `electron/sharing/room-e2e-adopt.test.ts`: actual engine instances with real
  Ed25519/AES/KDF operations over in-memory channels; authorization, connected
  peer convergence, retained content keys, scheduled counts, cancellation and
  compatibility failures.
- `guest/mesh-chat.test.ts`: browser rekey authentication and relay before rekey.
- `electron/sharing/room-manager.test.ts`: trusted schedule persistence and
  restoring the schedule in the engine's join payload.
- `node scripts/smoke-room-key-rotation.cjs`: real React dialog in a hidden,
  isolated Electron profile, with fixture IPC; manual/finite/unlimited actions,
  cancellation, validation, errors, disabled pending actions and a screenshot.

These checks mock network and hardware boundaries; they do not establish
delivery guarantees during real network failures or verify live microphone use.
