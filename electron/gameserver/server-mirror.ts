/**
 * Compact server state a member gossips so other members see their instances.
 *
 * "Host" here means the host OF THESE INSTANCES, not the room owner: any member
 * can run a server, so a room can carry several mirrors at once and each is
 * keyed by its publisher. Collapsing them into one slot made two members with
 * servers overwrite each other, and a shared `at` floor made the loser
 * permanently invisible.
 */
import type {
  MirroredServerInstance, RoomServerInstance, ServerMirrorState, ServerRole, ServerStatus,
} from '../../shared/gameserver-types';

const MAX_CONSOLE_TAIL = 8;
const MAX_LINE = 240;
const MAX_INSTANCES = 16;

export function trimConsoleTail(lines: string[]): string[] {
  return lines
    .slice(-MAX_CONSOLE_TAIL)
    .map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l));
}

/** The console tail of one instance, with the host sequence of its last line. */
export interface ConsoleTailSample {
  lines: string[];
  /** Host-side seq of `lines[lines.length - 1]`. */
  lastSeq: number;
}

export function buildMirrorPayload(
  hostId: string,
  instances: RoomServerInstance[],
  consoleTails: Record<string, ConsoleTailSample>,
): ServerMirrorState {
  const mirrored: MirroredServerInstance[] = instances.map((i) => {
    const sample = consoleTails[i.instanceId];
    // Trimming drops the OLDEST lines, so the last line — and therefore the
    // sequence that anchors the rest — is unaffected.
    const tail = sample?.lines.length ? trimConsoleTail(sample.lines) : [];
    return {
      instanceId: i.instanceId,
      moduleId: i.moduleId,
      name: i.name,
      version: i.version,
      status: i.status,
      since: i.since,
      ...(i.address ? { address: i.address } : {}),
      ...(i.port !== undefined ? { port: i.port } : {}),
      ...(i.players ? { players: { online: i.players.online, max: i.players.max } } : {}),
      operators: i.operators ?? [],
      autoRestart: i.autoRestart,
      ...(i.scheduleEnabled ? { scheduleEnabled: true } : {}),
      ...(i.failReason ? { failReason: i.failReason, ...(i.failDetail ? { failDetail: i.failDetail } : {}) } : {}),
      ...(tail.length ? { consoleTail: tail, consoleTailSeq: sample.lastSeq } : {}),
    };
  });
  return { hostId, at: Date.now(), instances: mirrored };
}

export function parseMirrorBody(body: string): ServerMirrorState | null {
  try {
    const raw = JSON.parse(body) as ServerMirrorState;
    if (!raw || typeof raw.hostId !== 'string' || !Array.isArray(raw.instances)) return null;
    const at = Number(raw.at);
    if (!Number.isFinite(at)) return null;
    const instances: MirroredServerInstance[] = [];
    for (const item of raw.instances.slice(0, MAX_INSTANCES)) {
      if (!item || typeof item.instanceId !== 'string') continue;
      const tail = item.consoleTail?.length ? item.consoleTail.map(String).slice(-MAX_CONSOLE_TAIL) : [];
      const tailSeq = Number(item.consoleTailSeq);
      instances.push({
        instanceId: String(item.instanceId),
        moduleId: String(item.moduleId || ''),
        name: String(item.name || 'Server'),
        version: String(item.version || ''),
        status: (item.status as ServerStatus) || 'stopped',
        since: Number(item.since) || at,
        ...(item.address ? { address: String(item.address) } : {}),
        ...(item.port !== undefined ? { port: Number(item.port) } : {}),
        ...(item.players ? { players: { online: Number(item.players.online) || 0, max: Number(item.players.max) || 0 } } : {}),
        operators: Array.isArray(item.operators) ? item.operators.map(String).slice(0, 64) : [],
        autoRestart: item.autoRestart === true,
        ...(item.scheduleEnabled ? { scheduleEnabled: true } : {}),
        // A tail without a usable sequence is dropped rather than renumbered:
        // inventing one would resurrect the duplicate-line bug it exists to fix.
        ...(tail.length && Number.isFinite(tailSeq) && tailSeq > 0
          ? { consoleTail: tail, consoleTailSeq: tailSeq }
          : {}),
        ...(item.failReason ? { failReason: item.failReason, ...(item.failDetail ? { failDetail: String(item.failDetail) } : {}) } : {}),
      });
    }
    return { hostId: raw.hostId, at, instances };
  } catch {
    return null;
  }
}

export function serializeMirrorBody(state: ServerMirrorState): string {
  return JSON.stringify(state);
}

/**
 * Stable fingerprint of what a mirror SAYS, ignoring when it was said. Used to
 * skip republishing an unchanged payload: `at` is a fresh `Date.now()` every
 * time, so hashing the whole thing would never match and every probe tick would
 * flood the mesh again.
 */
export function mirrorFingerprint(state: ServerMirrorState): string {
  return JSON.stringify(state.instances);
}

/**
 * Our role for a mirrored instance, read from the operator list its HOST
 * published.
 *
 * The grant is recorded on the host's machine, so the operator's own
 * `servers-store` knows nothing about it — deciding this from the local store
 * meant every remote instance came back `viewer` and no grant ever took effect.
 * The mirror is the only place the host's answer is visible to us, which makes
 * it the authority here.
 */
export function mirroredRole(hostId: string, m: MirroredServerInstance, selfId: string): ServerRole {
  if (hostId === selfId) return 'host';
  return m.operators.includes(selfId) ? 'operator' : 'viewer';
}
