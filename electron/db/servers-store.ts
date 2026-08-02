/**
 * servers.json — persistence for game-server instances.
 *
 * A dedicated file rather than more keys in rooms.json, following the split this
 * app already migrated to (see the header of db/store.ts): electron-store
 * rewrites a whole file on every set(), so an instance's config edit has no
 * business rewriting every room manifest.
 *
 * What is NOT here: console output (it goes to the instance's logs/ directory,
 * not into a JSON blob that gets rewritten wholesale), and live status, which is
 * derived from the supervisor and never survives a restart by design.
 */
import Store from 'electron-store';
import type { ServerRole } from '../../shared/gameserver-types';

/** One instance as it survives a restart. */
export interface PersistedInstance {
  instanceId: string;
  moduleId: string;
  /** Room this instance belongs to. */
  roomId: string;
  name: string;
  /** The resolved catalog entry, so an instance can be relaunched offline.
   *  Stored as JSON because GameVersionRef carries a module-private `meta`. */
  ref: unknown;
  /** Havvn-side settings that do not live in the game's own config file. */
  config: Record<string, string>;
  createdAt: number;
  /** Install finished — until then the instance exists but cannot start. */
  installed: boolean;
  /** Restart automatically after an unexpected exit. */
  autoRestart: boolean;
  /** Bumped whenever the required content set changes. */
  contentRev: number;
}

interface ServersSchema {
  instances: Record<string, PersistedInstance>;
  /** moduleId → when its legal gate was accepted (0 = never). Accepting a
   *  licence is an act by the user; it is recorded, never inferred. */
  legalAccepted: Record<string, number>;
  /** sha256 of executable content → when and by whom it was approved. Consent is
   *  once per HASH, so a re-shared identical mod does not re-prompt, and a
   *  modified one does. */
  contentConsents: Record<string, { at: number; by: string }>;
  /** instanceId → memberIds granted the operator role. */
  operators: Record<string, string[]>;
  /** instanceId → (memberId → revokedAt). Sticky and beats `operators`, the same
   *  terminal-evict discipline the LAN admission uses: a replayed old grant can
   *  never resurrect a revoked operator. */
  operatorRevokes: Record<string, Record<string, number>>;
}

const serversStore = new Store<ServersSchema>({
  name: 'servers',
  defaults: {
    instances: {},
    legalAccepted: {},
    contentConsents: {},
    operators: {},
    operatorRevokes: {},
  },
});

const MAX_INSTANCES = 50;
const MAX_CONSENTS = 2000;

// === Instances ===

export function getInstances(): Record<string, PersistedInstance> {
  return serversStore.get('instances') ?? {};
}

export function getInstance(instanceId: string): PersistedInstance | null {
  return getInstances()[instanceId] ?? null;
}

export function listInstancesForRoom(roomId: string): PersistedInstance[] {
  return Object.values(getInstances()).filter((i) => i.roomId === roomId);
}

export function upsertInstance(instance: PersistedInstance): void {
  const all = getInstances();
  if (!(instance.instanceId in all) && Object.keys(all).length >= MAX_INSTANCES) {
    throw new Error(`too many server instances (limit ${MAX_INSTANCES})`);
  }
  all[instance.instanceId] = instance;
  serversStore.set('instances', all);
}

export function removeInstance(instanceId: string): void {
  const all = getInstances();
  if (!(instanceId in all)) return;
  delete all[instanceId];
  serversStore.set('instances', all);

  for (const key of ['operators', 'operatorRevokes'] as const) {
    const map = serversStore.get(key) ?? {};
    if (instanceId in map) {
      delete (map as Record<string, unknown>)[instanceId];
      serversStore.set(key, map as never);
    }
  }
}

// === Legal gates ===

export function isLegalAccepted(moduleId: string): boolean {
  return Number(((serversStore.get('legalAccepted') ?? {})[moduleId]) ?? 0) > 0;
}

export function acceptLegal(moduleId: string): void {
  const all = serversStore.get('legalAccepted') ?? {};
  all[moduleId] = Date.now();
  serversStore.set('legalAccepted', all);
}

export function revokeLegal(moduleId: string): void {
  const all = serversStore.get('legalAccepted') ?? {};
  delete all[moduleId];
  serversStore.set('legalAccepted', all);
}

// === Content consent ===

export function hasContentConsent(sha256: string): boolean {
  return sha256 in (serversStore.get('contentConsents') ?? {});
}

export function recordContentConsent(sha256: string, by: string): void {
  const all = serversStore.get('contentConsents') ?? {};
  all[sha256] = { at: Date.now(), by };
  const entries = Object.entries(all);
  if (entries.length > MAX_CONSENTS) {
    entries.sort((a, b) => a[1].at - b[1].at);
    entries.splice(0, entries.length - MAX_CONSENTS);
    serversStore.set('contentConsents', Object.fromEntries(entries));
    return;
  }
  serversStore.set('contentConsents', all);
}

// === Operator grants ===

export function listOperators(instanceId: string): string[] {
  const granted = (serversStore.get('operators') ?? {})[instanceId] ?? [];
  const revoked = (serversStore.get('operatorRevokes') ?? {})[instanceId] ?? {};
  return granted.filter((m) => !(m in revoked));
}

export function grantOperator(instanceId: string, memberId: string): void {
  const revokes = serversStore.get('operatorRevokes') ?? {};
  const forInstance = revokes[instanceId];
  if (forInstance && memberId in forInstance) {
    // A revoke is terminal for the pair. Re-granting requires clearing it
    // explicitly, so a stale grant replayed from anywhere cannot undo a kick.
    delete forInstance[memberId];
    revokes[instanceId] = forInstance;
    serversStore.set('operatorRevokes', revokes);
  }
  const all = serversStore.get('operators') ?? {};
  const list = new Set(all[instanceId] ?? []);
  list.add(memberId);
  all[instanceId] = [...list].slice(0, 64);
  serversStore.set('operators', all);
}

export function revokeOperator(instanceId: string, memberId: string): void {
  const revokes = serversStore.get('operatorRevokes') ?? {};
  const forInstance = { ...(revokes[instanceId] ?? {}) };
  forInstance[memberId] = Date.now();
  revokes[instanceId] = forInstance;
  serversStore.set('operatorRevokes', revokes);
}

/** Our role for an instance, given who hosts it and who we are. */
export function roleFor(instanceId: string, hostId: string, selfId: string): ServerRole {
  if (hostId === selfId) return 'host';
  return listOperators(instanceId).includes(selfId) ? 'operator' : 'viewer';
}
