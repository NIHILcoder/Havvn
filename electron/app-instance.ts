/**
 * Profile location concerns that must run before ANYTHING reads
 * `app.getPath('userData')` — electron-store and the logger both resolve it at
 * module-load time, which is why this file is the very first import in main.ts.
 * Changing the path after that would be too late.
 *
 * Two jobs live here:
 *
 * 1. Legacy-profile migration (TorrentHunt → Havvn rebrand). Electron derives
 *    userData from package.json `name`, so the rename moved the profile from
 *    `…/torrenthunt` to `…/havvn`. On first Havvn launch we copy the old
 *    profile (settings, downloads DB, room identity keys — losing rooms.json
 *    would break the user's friend-room TOFU identity) into the new location.
 *    The old dir is left in place as a safety net for downgrades.
 *
 * 2. Multi-instance support for LOCAL TESTING of peer-to-peer features (rooms,
 *    share links) on a single machine. Havvn is normally single-instance: one
 *    profile, one tray, one identity. Set the env var `TH_INSTANCE=<name>`
 *    (historic name, kept stable) to launch an isolated second copy that:
 *      - uses its own userData dir (separate DB / config / room identity), so
 *        the two copies are genuinely different "people" in a room;
 *      - skips the single-instance lock, so it doesn't just focus the first
 *        window.
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

/** Non-empty when this process was launched as an isolated test instance. */
export const INSTANCE_ID = (process.env.TH_INSTANCE || '').trim();
export const isSecondaryInstance = INSTANCE_ID.length > 0;

/**
 * True when this process was relaunched as the elevated Virtual-LAN helper
 * (`Havvn.exe --lan-helper`). Must be read BEFORE any userData side-effect below:
 * the helper runs under the ADMIN token (over-the-shoulder UAC = a DIFFERENT SID),
 * so it must NOT redirect userData or migrate the profile — it reads its handshake
 * from the ABSOLUTE path passed via argv (plan §0.1 #3). It also bypasses the
 * single-instance lock in main.ts (else it self-quits when the primary holds it).
 */
export const isLanHelper = process.argv.includes('--lan-helper');

/**
 * Marker written ONLY after a fully successful migration. It — not the presence
 * of config.json — is the "already migrated" anchor: config.json cannot serve
 * that role because electron-store (loaded moments later in store.ts) writes it
 * on the very same launch regardless of migration outcome, and a copy
 * interrupted after config.json but before downloads.json/rooms.json would
 * otherwise latch as "done" and silently strand the user's data.
 *
 * Declared BEFORE the top-level migrateLegacyProfile() call below: a `const`
 * placed after that call sits in the temporal dead zone when the function runs
 * at module evaluation, which made the migration throw on every launch.
 */
const MIGRATION_SENTINEL = '.migrated-from-torrenthunt';

if (isLanHelper) {
  // The elevated helper reads its handshake from the absolute argv path — it needs
  // no electron-store, and redirecting userData to the admin profile would be wrong
  // (and cross-SID pointless). Leave userData untouched and skip the migration.
} else if (isSecondaryInstance) {
  // Derive the isolated profile dir from the default one, e.g.
  //   …/havvn  ->  …/havvn-peer2
  const base = app.getPath('userData');
  app.setPath('userData', `${base}-${INSTANCE_ID}`);
  // Distinct name so the tray tooltip / OS notifications make the two copies
  // distinguishable while testing.
  app.setName(`Havvn (${INSTANCE_ID})`);
} else {
  migrateLegacyProfile();
}

/**
 * One-time copy of the pre-rebrand `…/torrenthunt` profile into `…/havvn`.
 *
 * Robustness (a botched migration means a silent factory-reset — lost downloads
 * list and, worse, the room-identity keypair):
 *  - Anchor on MIGRATION_SENTINEL, written last. Any failure/interrupt leaves it
 *    absent, so the next launch retries instead of latching as done.
 *  - Stage into a sibling temp dir and only then merge into the real profile, so
 *    a half-written file never lands in the profile Havvn actually reads.
 *  - Merge with force:false: never clobber anything Electron/electron-store may
 *    already have written to the new dir since launch.
 */
function migrateLegacyProfile(): void {
  const newDir = app.getPath('userData'); // …/havvn
  const legacyDir = path.join(path.dirname(newDir), 'torrenthunt');
  const staging = `${newDir}.migrating`;
  try {
    if (fs.existsSync(path.join(newDir, MIGRATION_SENTINEL))) return; // already migrated
    if (!fs.existsSync(path.join(legacyDir, 'config.json'))) return;  // fresh install, nothing to migrate

    // Fresh staging copy each attempt (a prior interrupt may have left a partial one).
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(legacyDir, staging, { recursive: true });

    fs.mkdirSync(newDir, { recursive: true });
    fs.cpSync(staging, newDir, { recursive: true, force: false, errorOnExist: false });
    fs.rmSync(staging, { recursive: true, force: true });

    fs.writeFileSync(path.join(newDir, MIGRATION_SENTINEL), 'ok');
    // Can't use the logger here (it would lock in the userData path mid-copy);
    // stdout is picked up in dev and harmless when packaged.
    console.log(`[app-instance] migrated legacy TorrentHunt profile: ${legacyDir} -> ${newDir}`);
  } catch (e) {
    // Never brick startup: leave the sentinel absent (retry next launch) and the
    // legacy dir intact. Drop the partial staging dir so the retry starts clean.
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    console.error('[app-instance] legacy profile migration failed (will retry next launch):', e);
  }
}
