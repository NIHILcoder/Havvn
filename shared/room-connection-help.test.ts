import { describe, it, expect } from 'vitest';
import { buildRoomDiagnosticReport } from './room-diagnostics';
import { roomConnectionHelp } from './room-connection-help';
const report = () => {
  const r = buildRoomDiagnosticReport(undefined, { state: 'ready' }, false, '3.3.0');
  r.connection.phase = 'discovering'; r.connection.trackers.configured = 3;
  return r;
};
describe('connection helper evidence', () => {
  it('does not infer WebRTC failure from missing discovery replies', () => {
    const r = report(); expect(roomConnectionHelp(r)).toBe('discovery');
    r.connection.trackers.acknowledged = 1; expect(roomConnectionHelp(r)).toBe('waiting');
    r.connection.channels.pending = 1; expect(roomConnectionHelp(r)).toBe('channel');
  });
  it('prioritizes live readiness over earlier identity rejection', () => {
    const r = report(); r.connection.observations['identity-rejected'] = 2;
    expect(roomConnectionHelp(r)).toBe('identity');
    r.connection.phase = 'ready'; expect(roomConnectionHelp(r)).toBe('ready');
    r.connection.phase = 'syncing'; expect(roomConnectionHelp(r)).toBe('sync');
  });
  it.each(['removed', 'suspended', 'engine-failed', 'offline'] as const)('respects the %s gate before historical channels', phase => {
    const r = report(); r.connection.phase = phase; r.connection.channels.identified = 1;
    expect(roomConnectionHelp(r)).toBe(phase === 'engine-failed' || phase === 'offline' ? 'engine' : phase);
  });
  it('distinguishes no configuration and peer discovery from an established channel', () => {
    const r = report(); r.connection.trackers.configured = 0; expect(roomConnectionHelp(r)).toBe('noDiscovery');
    r.connection.observations['peer-found'] = 1; expect(roomConnectionHelp(r)).toBe('channel');
    r.connection.channels.identified = 1; expect(roomConnectionHelp(r)).toBe('ready');
  });
});
