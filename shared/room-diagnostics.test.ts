import { describe, expect, it } from 'vitest';
import { buildRoomDiagnosticReport, RoomConnectionMonitor, selectedRoomChannelPath } from './room-diagnostics';
import type { RoomConnectionDiagnostics } from './room-diagnostics';
import type { RoomState } from './types';

const emptyChannels = () => ({ pending: 0, open: 0, identified: 0, syncing: 0, direct: 0, turn: 0, unknown: 0 });
const connection = (): RoomConnectionDiagnostics => {
  const monitor = new RoomConnectionMonitor(2, () => 1000);
  monitor.trackerAck(0); monitor.identified(); monitor.synced();
  return monitor.snapshot({ ...emptyChannels(), open: 1, identified: 1, direct: 1 }, false, false);
};
const state = (overrides: Partial<RoomState> = {}): RoomState => ({
  roomId: 'PRIVATE_ROOM_ID', name: 'PRIVATE_ROOM_NAME', code: 'PRIVATE_INVITE', folder: 'PRIVATE_LOCAL_PATH',
  members: [{ memberId: 'PRIVATE_SELF_ID', name: 'PRIVATE_NAME', online: true, isSelf: true },
    { memberId: 'PRIVATE_PEER_ID', name: 'PRIVATE_PEER_NAME', online: true }],
  files: [], transfers: {}, connection: connection(),
  ...overrides,
} as RoomState);
const report = (s?: RoomState) => buildRoomDiagnosticReport(s, { state: 'ready' }, false, '3.0.7', undefined, 2000);

describe('observed room connection phases', () => {
  it('does not call a tracker start a successful connection; an empty acknowledged room waits', () => {
    const monitor = new RoomConnectionMonitor(2, () => 1000), channels = emptyChannels();
    monitor.resetTrackers(2);
    expect(monitor.snapshot(channels, false, false).phase).toBe('discovering');
    monitor.trackerAck(-1); monitor.trackerAck(2);
    expect(monitor.snapshot(channels, false, false).trackers.acknowledged).toBe(0);
    monitor.trackerAck(0); monitor.trackerAck(0);
    expect(monitor.snapshot(channels, false, false)).toMatchObject({ phase: 'waiting', trackers: { acknowledged: 1 } });
    expect(monitor.snapshot({ ...channels, pending: 1 }, false, false).phase).toBe('connecting');
    expect(monitor.snapshot({ ...channels, open: 1 }, false, false).phase).toBe('authenticating');
    expect(monitor.snapshot({ ...channels, open: 1, identified: 1, syncing: 1 }, false, false).phase).toBe('syncing');
    expect(monitor.snapshot({ ...channels, open: 1, identified: 1 }, false, false).phase).toBe('ready');
  });
  it('keeps a missing content key separate from a transport failure', () => {
    const monitor = new RoomConnectionMonitor(1);
    expect(monitor.snapshot({ ...emptyChannels(), open: 1, identified: 1 }, true, false).phase).toBe('syncing');
    expect(monitor.snapshot({ ...emptyChannels(), open: 1, identified: 1 }, false, true).phase).toBe('removed');
  });
  it('retains last successful times when a channel closes or discovery restarts', () => {
    let now = 1000; const monitor = new RoomConnectionMonitor(2, () => now);
    monitor.identified(); now = 2000; monitor.synced(); now = 3000; monitor.resetTrackers(3);
    expect(monitor.snapshot(emptyChannels(), false, false)).toMatchObject({ phase: 'waiting',
      lastConnectedAt: 1000, lastSyncAt: 2000, trackers: { configured: 3, acknowledged: 0 } });
    expect(monitor.snapshot({ ...emptyChannels(), open: 1, identified: 1 }, false, false).phase).toBe('ready');
  });
  it('bounds and coalesces history while keeping occurrence counts', () => {
    let now = 1000; const monitor = new RoomConnectionMonitor(1, () => now);
    for (let i = 0; i < 100; i++) monitor.observe('frame-unreadable');
    const first = monitor.snapshot(emptyChannels(), false, false);
    expect(first.events).toHaveLength(1); expect(first.observations['frame-unreadable']).toBe(100);
    for (let i = 0; i < 40; i++) { now += 1000; monitor.observe('peer-closed'); }
    const last = monitor.snapshot(emptyChannels(), false, false); expect(last.events).toHaveLength(24);
    last.events[0].event = 'rate-limited'; last.observations['peer-closed'] = 0;
    expect(monitor.snapshot(emptyChannels(), false, false).observations['peer-closed']).toBe(40);
    expect(monitor.snapshot(emptyChannels(), false, false).events[0].event).toBe('peer-closed');
  });
});

describe('selected ICE channel path', () => {
  const rows = [
    { type: 'local-candidate', id: 'local', candidateType: 'host', address: 'PRIVATE_ADDRESS' },
    { type: 'remote-candidate', id: 'remote', candidateType: 'srflx' },
    { type: 'remote-candidate', id: 'unused', candidateType: 'relay' },
    { type: 'candidate-pair', id: 'selected', localCandidateId: 'local', remoteCandidateId: 'remote', nominated: true, state: 'succeeded' },
    { type: 'candidate-pair', id: 'other', localCandidateId: 'local', remoteCandidateId: 'unused', state: 'in-progress' },
  ];
  it('does not infer TURN from an unused relay candidate', () => { expect(selectedRoomChannelPath(rows)).toBe('direct'); });
  it('uses the transport-selected pair ahead of other nominated pairs', () => {
    expect(selectedRoomChannelPath([...rows, { type: 'transport', selectedCandidatePairId: 'other' }])).toBe('turn');
  });
  it('reports unknown when the selected pair or candidate types are missing', () => {
    expect(selectedRoomChannelPath(rows.filter(r => r.type !== 'candidate-pair'))).toBe('unknown');
    expect(selectedRoomChannelPath(rows.filter(r => r.id !== 'remote'))).toBe('unknown');
    expect(selectedRoomChannelPath([...rows, { type: 'transport', selectedCandidatePairId: 'missing' }])).toBe('unknown');
    const competing = { type: 'candidate-pair', id: 'restart', nominated: true, state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'unused' };
    expect(selectedRoomChannelPath([...rows, competing])).toBe('unknown');
    expect(selectedRoomChannelPath([...rows, { ...competing, selected: true }])).toBe('turn');
  });
});

describe('allowlisted room diagnostic export', () => {
  it('excludes identifiers, names, invitations, error text, addresses, chat, paths and unknown fields', () => {
    const input = state({ transfers: {
      secretFile: { phase: 'error', error: { code: 'permission', stage: 'local-file', message: 'PRIVATE_ERROR_PATH' }, localPath: 'PRIVATE_FILE_PATH' },
    } as RoomState['transfers'] });
    Object.assign(input, { chat: [{ text: 'PRIVATE_CHAT' }], topicHash: 'PRIVATE_TOPIC', secret: 'PRIVATE_SECRET',
      files: [{ name: 'PRIVATE_FILE_NAME', magnetURI: 'PRIVATE_MAGNET' }],
      voice: { inVoice: true, participants: [{ memberId: 'PRIVATE_PEER_ID', name: 'PRIVATE_VOICE_NAME', connection: 'connected', quality: 'good' }] } });
    Object.assign(input.connection!, { unknown: 'PRIVATE_EXTRA', events: [{ at: 1000, event: 'PRIVATE_BAD_EVENT' },
      { at: 1000, event: 'tracker-unavailable', error: 'PRIVATE_TRACKER_URL' }] });
    const result = buildRoomDiagnosticReport(input, { state: 'ready', message: 'PRIVATE_ENGINE_MESSAGE' }, false, 'PRIVATE_BAD_VERSION', undefined, 2000);
    expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(result.appVersion).toBe('unknown');
    expect(result.files.failures.permission).toBe(1);
    expect(result.connection.events).toEqual([{ at: 1000, event: 'tracker-unavailable' }]);
    expect(result.voice.connected).toBe(1);
  });
  it('sanitizes invalid counts, timestamps, phases and oversized event history', () => {
    const input = state(); Object.assign(input.connection!, { phase: 'unknown-phase', startedAt: -1,
      lastConnectedAt: Infinity, lastSyncAt: 2.5, channels: { open: NaN, pending: -10, direct: 2e7 },
      observations: { 'tracker-ack': 2e7 }, events: Array.from({ length: 100 }, () => ({ at: 1500, event: 'tracker-ack' })) });
    const result = report(input);
    expect(result.connection.phase).toBe('discovering'); expect(result.connection.startedAt).toBe(2000);
    expect(result.connection.lastConnectedAt).toBeUndefined(); expect(result.connection.lastSyncAt).toBeUndefined();
    expect(result.connection.channels).toMatchObject({ open: 0, pending: 0, direct: 1_000_000 });
    expect(result.connection.observations['tracker-ack']).toBe(1_000_000); expect(result.connection.events).toHaveLength(24);
  });
  it('counts unique remote people and peer relays independently from transport channels', () => {
    const input = state(); input.members.push({ ...input.members[1], relayed: true });
    input.members.push({ memberId: 'offline', name: 'Offline', online: false } as RoomState['members'][number]);
    const result = report(input);
    expect(result.people).toEqual({ online: 1, viaPeerRelay: 1 }); expect(result.connection.channels.direct).toBe(1);
  });
  it('counts the actual receive queue, keeps unmeasured quality unknown and relay quality separate', () => {
    const input = state({ transfers: { manual: { phase: 'queued' }, active: { phase: 'downloading' },
      waiting: { phase: 'waiting-key' }, paused: { phase: 'paused', receivePaused: true }, done: { phase: 'ready', haveLocally: true } } as RoomState['transfers'] });
    Object.assign(input, { receiveQueue: { waiting: 2 },
      voice: { inVoice: true, participants: [{ memberId: 'PRIVATE_SELF_ID', quality: 'poor', connection: 'connected' },
        { memberId: 'B', connection: 'connected' }, { memberId: 'C', connection: 'reconnecting', quality: 'poor' }] },
      lan: { active: true, available: true, participants: [{ memberId: 'B', status: 'connected', relayVia: 'C', quality: 'poor' },
        { memberId: 'C', status: 'connected', quality: 'poor' }] } });
    const result = report(input);
    expect(result.files).toMatchObject({ queued: 2, receiving: 1, waitingKey: 1, paused: 1, ready: 1 });
    expect(result.voice).toEqual({ joined: true, connected: 1, connecting: 1, failed: 0, poor: 1, unknown: 1 });
    expect(result.lan).toEqual({ active: true, available: true, connected: 1, viaPeerRelay: 1, failed: 0, poor: 1, unknown: 1 });
  });
  it.each(['engine-failed', 'offline', 'suspended'] as const)('does not report stale live traffic when %s', phase => {
    const input = state({ transfers: { file: { phase: 'downloading' } } as RoomState['transfers'] });
    const result = buildRoomDiagnosticReport(input, { state: phase === 'engine-failed' ? 'failed' : phase === 'offline' ? 'stopped' : 'ready' }, phase === 'suspended', '3.0.7');
    expect(result.connection.phase).toBe(phase); expect(result.connection.channels).toEqual(emptyChannels());
    expect(result.connection.lastConnectedAt).toBe(1000); expect(result.people.online).toBe(0);
    expect(result.files.receiving).toBe(0); expect(result.voice.joined).toBe(false); expect(result.lan.active).toBe(false);
  });
  it('preserves safe connection history after the engine cache is gone', () => {
    const result = buildRoomDiagnosticReport(undefined, { state: 'failed' }, false, '3.0.7', connection(), 5000);
    expect(result.connection).toMatchObject({ phase: 'engine-failed', lastConnectedAt: 1000, lastSyncAt: 1000 });
    expect(result.connection.trackers).toEqual({ configured: 2, acknowledged: 0 });
  });
});
