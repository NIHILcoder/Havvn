import type { RoomDiagnosticReport } from './room-diagnostics';
export type ProbeState = 'ok' | 'failed' | 'unknown' | 'skipped';
export interface RoomEndpointProbe { index: number; dns: ProbeState; tcp: ProbeState; tls: ProbeState; websocket: ProbeState }
export interface RoomNetworkProbe { checkedAt: number; endpoints: RoomEndpointProbe[]; turnEnabled: boolean; turnConfigured: boolean; customDiscovery: boolean }
export function roomConnectionHelp(report: RoomDiagnosticReport) {
  const { phase, trackers, channels, observations } = report.connection;
  if (phase === 'removed') return 'removed';
  if (phase === 'suspended') return 'suspended';
  if (phase === 'engine-failed' || phase === 'offline') return 'engine';
  if (phase === 'syncing') return 'sync';
  if (phase === 'ready' || channels.identified > 0) return 'ready';
  if (observations['identity-rejected'] || phase === 'authenticating') return 'identity';
  if (channels.pending > 0 || observations['peer-found'] > 0) return 'channel';
  if (!trackers.configured) return 'noDiscovery';
  return trackers.acknowledged > 0 ? 'waiting' : 'discovery';
}
