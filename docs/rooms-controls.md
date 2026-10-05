# Room window controls — stage 5.3

Implemented on 2026-10-05. This stage updates the desktop room UI; server lifecycle and remote-console delivery remain stage 6.

## Changes

- Room speed limits and integer server settings use the shared `NumberInput`, including themeable stepping controls. Server settings reject empty, fractional, unsafe and out-of-range integers before saving.
- Voice, LAN, audio and server actions use the client `Button`. Audio switches use `Toggle`; output devices use `Select`, including in a detached player. Loading buttons retain their label and expose `aria-busy`.
- `Select` and `Toggle` have native button triggers, disabled semantics and optional IDs/accessibility descriptions. Server field labels can focus the actual control. Select menus keep the owning document's top layer, keyboard handling and theme inheritance.
- Voice settings wrap on narrow windows. Meter radii, active controls and audio output styling follow theme tokens rather than native widgets.
- Server overview, settings, players, content, schedule, access and backup panels show initial loading and visible load errors with Retry. Failed reads no longer look like empty data or enabled settings with invented defaults. Replies from an earlier instance cannot replace a newer instance's data.
- Configuration and schedule controls are disabled during saving. Content binding and unbinding hold the operation lock; consent cannot initiate synchronization on a running/locked server. Access changes disable the other toggles until acknowledgement. Server lifecycle actions and member hide/kick/ownership actions suppress duplicate submissions.
- Failed whitelist additions retain the typed name; backup-folder failures are shown; content consent reports the resulting sync status. Server deletion keeps its confirmation open on failure.
- File-removal confirmation explains removal of the shared publication, managed downloaded copies, and preservation of the author's original. Local hide, local voice mute and owner-only exclusion retain their distinct labels and rights.

Specialized dock tabs, drag handles, file tiles and player transport controls retain their own interaction contracts. They are not mechanically replaced by form buttons.

## Verification

`node scripts/smoke-room-controls.cjs` runs actual React controls in isolated Electron with synthetic IPC. It checks numeric stepping/ranges, blocked edits while saving, retained drafts after failure, Retry on six server tabs, locked content consent, stale-instance replies, schedule/access locks, backup-folder errors, Aero, 380px windows, audio controls and a Select in another owning document. It writes screenshots to a temporary directory. It does not touch personal rooms, servers, microphones or credentials.

Four unit cases cover integer validation; existing renderer/room/dock tests cover the surrounding keyboard, realm and permission behavior. The full Vitest run contained 200 suites / 2779 tests: two integration suites first failed on 5s startup deadlines and dependent assertions; all 51 tests in those suites passed on a separate one-worker rerun. The remaining 198 suites passed initially. The seven Node launcher tests passed separately. No new scoped lint findings were introduced.

Electron/renderer/guest type checks and production builds pass. Renderer retains the three existing webpack performance warnings.

## Quick manual check

1. Restart Havvn. Open room settings and change both speed limits using typing and arrows, then blur/Enter. Check the applied values.
2. Open voice settings under the default and custom theme. Resize the window, select devices, switch input mode and detach/reattach settings. Check Tab, Space, Enter and Escape.
3. Open a stopped server's settings. Enter an invalid port, correct it and save. During saving the fields must remain disabled. In schedule editing, check that time, days and actions cannot change while a save is pending.
4. Verify a failed whitelist addition leaves its name intact. On a running server, content consent/synchronization and settings remain locked. Switch server instances during a read and check that the old reply cannot replace the selection.
5. Compare local participant hiding, local voice muting and owner exclusion. Compare local file hiding with removing a publication for everyone.

Actual multi-PC popout, physical audio devices, NAT/VPN and real game-server acceptance remain in stage 7; synthetic UI checks do not replace them.
