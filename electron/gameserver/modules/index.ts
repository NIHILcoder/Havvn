/**
 * Registry of the game modules compiled into this build — the mirror of
 * createEngine() in electron/torrent/host/torrent-host.ts and of the provider
 * switch in electron/services/search-service.ts: first-party implementations
 * behind one contract, selected by id.
 *
 * Registration here is what makes a module trust tier A. Nothing outside this
 * file can add one, which is the property the whole security model rests on:
 * a shared preset can pick a version out of a registered module's catalog, but
 * it can never introduce a module, and therefore can never introduce code.
 */
import type { GameModule } from '../../../shared/gameserver-types';
import { genericModule } from './generic';
import { minecraftModule } from './minecraft';

const MODULES: readonly GameModule[] = [minecraftModule, genericModule];

const BY_ID = new Map<string, GameModule>(MODULES.map((m) => [m.id, m]));

export function listModules(): readonly GameModule[] {
  return MODULES;
}

export function getModule(id: string): GameModule | null {
  return BY_ID.get(id) ?? null;
}

/** The list the renderer's "new server" picker shows.
 *  `generic` stays registered (tests and the supervisor fixture need it) but is
 *  not a choice a person setting up a room should be offered. */
export function moduleSummaries(): { id: string; displayName: string; caps: GameModule['caps'] }[] {
  return MODULES
    .filter((m) => m.id !== 'generic')
    .map((m) => ({ id: m.id, displayName: m.displayName, caps: m.caps }));
}
