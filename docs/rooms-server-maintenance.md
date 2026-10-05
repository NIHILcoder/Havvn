# Game server maintenance — stage 6.4

Backup, restore and content sync use the existing server manager. They require a
fully stopped process: `stopping` and a child still alive after a stop timeout
are refused. During maintenance the same instance cannot start, restart,
install, delete or change its config/content bindings. Queued automatic
restarts are cancelled; a subsequent explicit or scheduled start restores the
configured restart preference.

## Worlds

- Backups include the configured `level-name` and separate Paper nether/end
  folders, when present. Vanilla/NeoForge dimensions inside the world are copied
  with that tree. Datapacks also use the configured world name.
- Space is checked before copying, with a 16 MiB reserve. An unavailable disk
  measurement is treated as unknown; copy failures still preserve the original.
- Backups are copied into a hidden staging folder, hashed and published only
  after metadata is written. Partial staging folders do not appear in the list.
- Restore verifies new backup digests, stages the full replacement, verifies its
  digests again and then swaps directories. A copy failure leaves the original
  in place; a publish failure attempts rollback. Directory junctions/symlinks
  in maintenance paths/trees are refused.
- Existing backups remain readable. Legacy backups have no integrity digests
  and only restore the dimensions actually present; an unrecorded Paper
  dimension is preserved.

## Room content

All requested files must be available and staged before installed files change.
The executable approval hash is calculated from the staged bytes, preventing a
source replacement between hashing and copying from installing unapproved
code. Missing or unapproved replacements leave the installed pack intact. A
failed publish rolls back changes. Pending executable content blocks Start.
Renamed files change the manifest; duplicate filenames ignoring case are
refused to avoid ambiguous Windows installs.

## Interrupted maintenance

This is not a filesystem-wide transaction or a guarantee against power loss.
If rollback also fails, or Havvn terminates during replacement, retained files
remain in `root/.restore-*` or `root/.content-*`. Havvn refuses starting or
another maintenance operation while those folders remain, preventing a fresh
world from overwriting recovery material.

Keep the server stopped, make a separate copy of the instance folder, and inspect
the retained files before recovering. In `.restore-*`, `previous-world`,
`previous-world_nether` and `previous-world_the_end` contain the original
directories; their live names follow `server.properties`'s `level-name`.
Do not blindly delete scratch folders. `recovery.json` records original
destinations before each destructive rename. Content rollback failure reports
the recovery path; `old-*` files contain originals mapped by that journal.
Full automated recovery after power loss remains a separate improvement.

## Reproduce actual-server acceptance

Build with `npm run build:electron`, then run:

```powershell
node scripts/smoke-gameserver-maintenance.cjs --source "<installed NeoForge server root>" --java "<managed Java 21 java.exe>"
```

The source must contain an already accepted `eula.txt`. The script does not
accept a new licence or copy a user's worlds, settings or mods. It reads cached
libraries and creates an isolated temporary profile, a new world, and a listener
bound to `127.0.0.1`. It does not join a room or request a firewall rule.

The test starts Minecraft 1.20.6 / NeoForge 20.6.139 through the actual manager
and supervisor. It saves a diamond block, backs up, changes it to gold,
restores and verifies both all saved-world file hashes and the block loaded by
Minecraft. It checks process guards, copying versus concurrent start/delete,
damaged backups, injected low-space/copy errors, executable consent and changed
hashes. Two generated harmless datapacks emit distinct messages on real server
startup to prove that a content revision loads from the custom world folder.
`evidence.json` and `console.txt` are retained in the reported temporary folder.

The executable consent fixture is a cached Java library, not a gameplay mod.
It checks that unapproved bytes are absent from `mods/` and cannot start a JVM;
it does not claim compatibility of arbitrary approved mods/plugins. Paper's
separate dimensions and locked-file/rollback failures have fault-injection
regression coverage using real temporary files; a live Paper process is not part of this run. This also does not
replace stage 7 testing across real peers, NAT, VPN or sleep/resume.
