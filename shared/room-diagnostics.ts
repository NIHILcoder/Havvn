import type { RoomEngineStatus, RoomState } from './types';
import { ROOM_PROTOCOL_VERSION } from './room-capabilities';

export const ROOM_CONNECTION_EVENTS = ['tracker-started', 'tracker-ack', 'tracker-unavailable', 'peer-found',
  'channel-open', 'peer-connect-failed', 'peer-closed', 'frame-unreadable', 'message-rejected',
  'identity-rejected', 'rate-limited', 'sync-received', 'discovery-retry'] as const;
export type RoomConnectionEvent = typeof ROOM_CONNECTION_EVENTS[number];
export type RoomConnectionPhase = 'discovering' | 'waiting' | 'connecting' | 'authenticating' | 'syncing' | 'ready' | 'offline' | 'engine-failed' | 'suspended' | 'removed';
export type RoomChannelPath = 'direct' | 'turn' | 'unknown';
export interface RoomConnectionDiagnostics {
  phase: RoomConnectionPhase;
  trackers: { configured: number; acknowledged: number };
  channels: { pending: number; open: number; identified: number; syncing: number; direct: number; turn: number; unknown: number };
  observations: Record<RoomConnectionEvent, number>;
  startedAt: number;
  lastConnectedAt?: number;
  lastSyncAt?: number;
  events: Array<{ at: number; event: RoomConnectionEvent }>;
}
export interface RoomDiagnosticReport {
  schema: 1;
  generatedAt: number;
  appVersion: string;
  protocolVersion: number;
  engine: { state: RoomEngineStatus['state']; suspended: boolean };
  connection: RoomConnectionDiagnostics;
  people: { online: number; viaPeerRelay: number };
  files: { total: number; receiving: number; queued: number; paused: number; checking: number; waitingKey: number; ready: number;
    failures: Record<'authentication' | 'missing-file' | 'disk-full' | 'permission' | 'changed-file' | 'failed' | 'unknown', number> };
  voice: { joined: boolean; connected: number; connecting: number; failed: number; poor: number; unknown: number };
  lan: { active: boolean; available: boolean; connected: number; viaPeerRelay: number; failed: number; poor: number; unknown: number };
}

const count = (n: unknown): number => typeof n === 'number' && Number.isFinite(n) ? Math.min(1_000_000, Math.max(0, Math.floor(n))) : 0;
const timestamp = (n: unknown): number | undefined => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 8_640_000_000_000_000 ? n : undefined;
const phases: RoomConnectionPhase[] = ['discovering', 'waiting', 'connecting', 'authenticating', 'syncing', 'ready', 'offline', 'engine-failed', 'suspended', 'removed'];

/** Fixed-size, session-only observations. No peer IDs, URLs, errors or packets. */
export class RoomConnectionMonitor {
  private observations = Object.fromEntries(ROOM_CONNECTION_EVENTS.map(e => [e, 0])) as Record<RoomConnectionEvent, number>;
  private events: RoomConnectionDiagnostics['events'] = [];
  private acknowledged = new Set<number>();
  private startedAt: number;
  private lastConnectedAt?: number;
  private lastSyncAt?: number;
  constructor(private configured: number, private now: () => number = Date.now) { this.startedAt = now(); }
  observe(event: RoomConnectionEvent): void {
    this.observations[event] = count(this.observations[event] + 1);
    const at = this.now(), last = this.events[this.events.length - 1];
    if (last?.event !== event || at - last.at >= 1000) {
      this.events.push({ at, event }); this.events = this.events.slice(-24);
    }
  }
  resetTrackers(configured: number): void {
    this.configured = configured; this.acknowledged.clear(); this.observe('tracker-started');
  }
  trackerAck(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.configured) return;
    this.acknowledged.add(index); this.observe('tracker-ack');
  }
  identified(): void { this.lastConnectedAt = this.now(); }
  synced(): void { this.lastSyncAt = this.now(); this.observe('sync-received'); }
  snapshot(channels: RoomConnectionDiagnostics['channels'], keyPending: boolean, removed: boolean): RoomConnectionDiagnostics {
    const phase: RoomConnectionPhase = removed ? 'removed' : channels.identified > 0
      ? channels.syncing > 0 || keyPending ? 'syncing' : 'ready'
      : channels.open > 0 ? 'authenticating' : channels.pending > 0 ? 'connecting'
      : this.acknowledged.size > 0 || this.lastConnectedAt ? 'waiting' : 'discovering';
    return { phase, trackers: { configured: count(this.configured), acknowledged: Math.min(count(this.configured), this.acknowledged.size) },
      channels: { ...channels }, observations: { ...this.observations }, startedAt: this.startedAt,
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
      ...(this.lastSyncAt ? { lastSyncAt: this.lastSyncAt } : {}), events: this.events.map(e => ({ ...e })) };
  }
}

/** Only the SELECTED ICE pair can explain the path. A configured TURN server cannot. */
export function selectedRoomChannelPath(stats: Iterable<{ type?: string; id?: string; [key: string]: unknown }>): RoomChannelPath {
  const rows = Array.from(stats), selectedId = rows.find(r => r.type === 'transport' && r.selectedCandidatePairId)?.selectedCandidatePairId;
  const nominated = rows.filter(r => r.type === 'candidate-pair' && r.nominated === true && r.state === 'succeeded');
  const pair = selectedId ? rows.find(r => r.id === selectedId && r.type === 'candidate-pair')
    : rows.find(r => r.type === 'candidate-pair' && r.selected === true) ?? (nominated.length === 1 ? nominated[0] : undefined);
  if (!pair) return 'unknown';
  const local = rows.find(r => r.id === pair.localCandidateId)?.candidateType;
  const remote = rows.find(r => r.id === pair.remoteCandidateId)?.candidateType;
  if (local === 'relay' || remote === 'relay') return 'turn';
  const direct = ['host', 'srflx', 'prflx'];
  return direct.includes(String(local)) && direct.includes(String(remote)) ? 'direct' : 'unknown';
}

/** Allowlist projection: never serialize RoomState or log/error strings into an export. */
export function buildRoomDiagnosticReport(state: RoomState | undefined, engine: RoomEngineStatus, suspended: boolean,
  appVersion: string, previous?: RoomConnectionDiagnostics, now = Date.now()): RoomDiagnosticReport {
  const raw = state?.connection ?? previous;
  const observations = Object.fromEntries(ROOM_CONNECTION_EVENTS.map(e => [e, count(raw?.observations?.[e])])) as Record<RoomConnectionEvent, number>;
  const live = engine.state === 'ready' && !suspended && !state?.kicked && !!state;
  const channels = { pending: 0, open: 0, identified: 0, syncing: 0, direct: 0, turn: 0, unknown: 0 };
  if (live) for (const key of Object.keys(channels) as Array<keyof typeof channels>) channels[key] = count(raw?.channels?.[key]);
  const phase: RoomConnectionPhase = state?.kicked ? 'removed' : suspended ? 'suspended' : engine.state === 'failed' ? 'engine-failed'
    : !live ? 'offline' : raw && phases.includes(raw.phase) ? raw.phase : state?.peerCount ? 'ready' : 'discovering';
  const connection: RoomConnectionDiagnostics = { phase, channels,
    trackers: { configured: count(raw?.trackers?.configured), acknowledged: live ? count(raw?.trackers?.acknowledged) : 0 },
    observations, startedAt: timestamp(raw?.startedAt) ?? now,
    ...(timestamp(raw?.lastConnectedAt) ? { lastConnectedAt: timestamp(raw?.lastConnectedAt) } : {}),
    ...(timestamp(raw?.lastSyncAt) ? { lastSyncAt: timestamp(raw?.lastSyncAt) } : {}),
    events: (Array.isArray(raw?.events) ? raw.events : []).slice(-24)
      .filter(e => timestamp(e?.at) && ROOM_CONNECTION_EVENTS.includes(e?.event)).map(e => ({ at: e.at, event: e.event })) };
  const files: RoomDiagnosticReport['files'] = { total: count(state?.files?.length), receiving: 0, queued: live ? count(state?.receiveQueue?.waiting) : 0, paused: 0, checking: 0, waitingKey: 0, ready: 0,
    failures: { authentication: 0, 'missing-file': 0, 'disk-full': 0, permission: 0, 'changed-file': 0, failed: 0, unknown: 0 } };
  for (const transfer of Object.values(state?.transfers ?? {})) {
    if (transfer.error) {
      const code = Object.hasOwn(files.failures, transfer.error.code) ? transfer.error.code : 'unknown'; files.failures[code]++;
    }
    if (transfer.receivePaused) files.paused++;
    else if (transfer.phase === 'downloading' && live) files.receiving++;
    if (live && (transfer.phase === 'verifying' || transfer.phase === 'decrypting')) files.checking++;
    if (transfer.phase === 'waiting-key') files.waitingKey++;
    if (transfer.haveLocally) files.ready++;
  }
  const selfId = state?.members?.find(m => m.isSelf)?.memberId;
  const people = new Map((live ? state?.members ?? [] : []).filter(m => !m.isSelf && m.online).map(m => [m.memberId, m]));
  const voice = { joined: live && state?.voice?.inVoice === true, connected: 0, connecting: 0, failed: 0, poor: 0, unknown: 0 };
  for (const p of live ? state?.voice?.participants ?? [] : []) {
    if (p.memberId === selfId) continue;
    if (p.connection === 'connected') voice.connected++;
    else if (p.connection === 'failed') voice.failed++;
    else if (p.connection === 'connecting' || p.connection === 'reconnecting' || p.reconnecting) voice.connecting++;
    if (p.quality === undefined) voice.unknown++;
    if (p.quality === 'poor') voice.poor++;
  }
  const lan = { active: live && state?.lan?.active === true, available: state?.lan?.available === true,
    connected: 0, viaPeerRelay: 0, failed: 0, poor: 0, unknown: 0 };
  for (const p of live ? state?.lan?.participants ?? [] : []) {
    if (p.memberId === selfId) continue;
    if (p.relayVia) lan.viaPeerRelay++;
    else if (p.status === 'connected') lan.connected++;
    else if (p.status === 'failed') lan.failed++;
    if (p.quality === undefined || p.relayVia) lan.unknown++;
    if (!p.relayVia && p.quality === 'poor') lan.poor++;
  }
  const engineStates: RoomEngineStatus['state'][] = ['stopped', 'starting', 'ready', 'failed'];
  return { schema: 1, generatedAt: now, appVersion: /^\d+\.\d+\.\d+(?:[-+][\w.-]{1,40})?$/.test(appVersion) ? appVersion : 'unknown',
    protocolVersion: ROOM_PROTOCOL_VERSION, engine: { state: engineStates.includes(engine.state) ? engine.state : 'failed', suspended: suspended === true },
    connection, people: { online: people.size, viaPeerRelay: [...people.values()].filter(m => m.relayed).length }, files, voice, lan };
}
