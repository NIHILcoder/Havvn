/**
 * Read/write Minecraft player access lists (`whitelist.json`, `banned-players.json`).
 */
import fs from 'fs';
import path from 'path';

export interface MinecraftPlayerEntry {
  uuid: string;
  name: string;
}

function readJsonList(file: string): MinecraftPlayerEntry[] {
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw
      .map((e) => ({ uuid: String(e?.uuid ?? ''), name: String(e?.name ?? '').trim() }))
      .filter((e) => e.name);
  } catch {
    return [];
  }
}

function writeJsonList(file: string, entries: MinecraftPlayerEntry[]): void {
  const clean = entries
    .map((e) => ({ uuid: e.uuid || '00000000-0000-0000-0000-000000000000', name: e.name.trim() }))
    .filter((e) => e.name);
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
