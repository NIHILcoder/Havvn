/**
 * Read/write Minecraft player access lists (`whitelist.json`, `banned-players.json`).
 *
 * These files belong to the SERVER, not to us. It writes them, it reads them
 * back on start and on `/whitelist reload`, and it puts more in them than a name:
 * a ban carries `created`, `source`, `expires` and `reason`. Editing one entry
 * means rewriting the whole file, so anything this module does not understand
 * has to survive the trip — otherwise removing one ban silently rewrites every
 * other one, turning a week-long ban into a permanent one and erasing the
 * reason the player is shown.
 */
import fs from 'fs';
import path from 'path';
import type { MinecraftPlayerEntry } from '../../shared/gameserver-types';

export type { MinecraftPlayerEntry };

/** What the server itself uses for a player it could not resolve. */
const NULL_UUID = '00000000-0000-0000-0000-000000000000';

/** A copy without the two fields this module owns and always writes itself. */
function withoutOwnFields(rec: Record<string, unknown>): Record<string, unknown> {
  const out = { ...rec };
  delete out.uuid;
  delete out.name;
  return out;
}

function readJsonList(file: string): MinecraftPlayerEntry[] {
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) return [];
    const out: MinecraftPlayerEntry[] = [];
    for (const item of raw) {
      // Anything that is not an object contributes no name and is dropped below.
      const rec: Record<string, unknown> = (item && typeof item === 'object' && !Array.isArray(item))
        ? item as Record<string, unknown>
        : {};
      const name = String(rec.name ?? '').trim();
      if (!name) continue;
      const extra = withoutOwnFields(rec);
      out.push({
        uuid: String(rec.uuid ?? ''),
        name,
        ...(Object.keys(extra).length ? { extra } : {}),
      });
    }
    return out;
  } catch {
    // These files are rewritten by a live server; a kill mid-write leaves half
    // of one behind. The panel asking for a list must not get an exception.
    return [];
  }
}

function writeJsonList(file: string, entries: MinecraftPlayerEntry[]): void {
  const clean: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const name = String(entry?.name ?? '').trim();
    if (!name) continue;
    // `uuid` and `name` are ours. readJsonList keeps them out of `extra`, but an
    // entry arriving over IPC has been through the renderer and is not bound by
    // that — so they are stripped again here rather than trusted, or a forged
    // `extra.name` would decide which player the entry is about.
    const rest = withoutOwnFields(entry.extra ?? {});
    clean.push({ uuid: String(entry.uuid ?? '') || NULL_UUID, name, ...rest });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(clean, null, 2), 'utf8');
}

export function readWhitelist(instanceRoot: string): MinecraftPlayerEntry[] {
  return readJsonList(path.join(instanceRoot, 'whitelist.json'));
}

export function writeWhitelist(instanceRoot: string, entries: MinecraftPlayerEntry[]): void {
  writeJsonList(path.join(instanceRoot, 'whitelist.json'), entries);
}

export function readBannedPlayers(instanceRoot: string): MinecraftPlayerEntry[] {
  return readJsonList(path.join(instanceRoot, 'banned-players.json'));
}

export function writeBannedPlayers(instanceRoot: string, entries: MinecraftPlayerEntry[]): void {
  writeJsonList(path.join(instanceRoot, 'banned-players.json'), entries);
}
