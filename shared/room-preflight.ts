import type { RoomCapabilities, RoomCapability } from './room-capabilities';
import type { RoomState } from './types';

export const ROOM_ACTIONS = ['watch', 'watch-host', 'lan', 'file-sync', 'documents'] as const;
export type RoomAction = typeof ROOM_ACTIONS[number];
export type RoomActionStatus = 'supported' | 'unsupported' | 'unknown' | 'unavailable';
export type RoomActionReason = 'ready' | 'capability-unknown' | 'capability-missing' | 'room-unavailable'
  | 'removed' | 'suspended' | 'engine-unavailable' | 'peer-unavailable' | 'owner-unknown' | 'owner-required'
  | 'lan-unavailable' | 'lan-busy' | 'lan-invite-required' | 'network-unmeasured' | 'browser-crypto' | 'browser-webrtc';
export type RoomActionNext = 'continue' | 'update' | 'reconnect' | 'wait-owner' | 'ask-owner' | 'configure-lan' | 'wait-lan' | 'browser' | 'try-connection';
export interface RoomActionCheck {
  status: RoomActionStatus;
  reason: RoomActionReason;
  next: RoomActionNext;
  /** An unmeasured route may be attempted. An unknown capability may not. */
  canAttempt: boolean;
}
const result = (status: RoomActionStatus, reason: RoomActionReason, next: RoomActionNext, canAttempt = false): RoomActionCheck => ({ status, reason, next, canAttempt });

/** Missing advertisements are unknown, including legacy clients. No authority is granted here. */
export function checkRoomCapability(peer: RoomCapabilities | undefined, capability: RoomCapability): RoomActionCheck {
  if (!peer?.capabilities) return result('unknown', 'capability-unknown', 'update');
  if (!peer.capabilities.includes(capability)) return result('unsupported', 'capability-missing', 'update');
  return result('supported', 'ready', 'continue', true);
}

export function checkGuestEntry(runtime: { crypto: boolean; webrtc: boolean }): RoomActionCheck {
  if (!runtime.crypto) return result('unsupported', 'browser-crypto', 'browser');
  if (!runtime.webrtc) return result('unsupported', 'browser-webrtc', 'browser');
  return result('unknown', 'network-unmeasured', 'try-connection', true);
}

const required: Record<RoomAction, RoomCapability> = {
  watch: 'watch-v2', 'watch-host': 'watch-host-v1', lan: 'lan', 'file-sync': 'file-sync-v1', documents: 'room-documents-v2',
};
export interface RoomActionContext {
  /** Main may supply its own actual build capabilities, never remote claims. */
  localCapabilities?: RoomCapability[];
  targetId?: string;
  engineReady?: boolean;
  suspended?: boolean;
  lanJoin?: boolean;
}

/** Pure inspection: no joins, permissions, capture, adapter changes or network probes. */
export function checkRoomAction(room: RoomState | undefined, action: RoomAction, context: RoomActionContext = {}): RoomActionCheck {
  if (context.suspended) return result('unavailable', 'suspended', 'reconnect');
  if (!room) return result('unavailable', 'room-unavailable', 'reconnect');
  if (room.kicked) return result('unavailable', 'removed', 'ask-owner');
  if (room.connection?.phase === 'suspended' || action === 'lan' && room.lan?.suspended) return result('unavailable', 'suspended', 'reconnect');
  if (context.engineReady === false || room.connection?.phase === 'engine-failed') return result('unavailable', 'engine-unavailable', 'reconnect');
  const local = checkRoomCapability(context.localCapabilities ? { capabilities: context.localCapabilities } : room.members.find(m => m.isSelf), required[action]);
  if (!local.canAttempt) return local;
  if (action === 'watch-host' && !room.canManage) return result('unavailable', 'owner-required', 'ask-owner');
  if ((action === 'file-sync' || action === 'documents') && !room.ownerId) return result('unavailable', 'owner-unknown', 'wait-owner');
  if (action === 'lan') {
    if (!room.lan?.available) return result('unsupported', 'lan-unavailable', 'configure-lan');
    if (room.lan.blocked) return result('unavailable', 'lan-busy', 'wait-lan');
    if (context.lanJoin && (!room.lan.sessionId || !room.lan.selfAdmitted)) return result('unavailable', 'lan-invite-required', 'ask-owner');
  }
  if (context.targetId) {
    const target = room.members.find(m => m.memberId === context.targetId);
    if (!target?.online) return result('unavailable', 'peer-unavailable', 'reconnect');
    const advertisement = target.isSelf && context.localCapabilities ? { capabilities: context.localCapabilities } : target;
    const remote = checkRoomCapability(advertisement, required[action]);
    if (!remote.canAttempt) return remote;
    if (action === 'watch' && room.watchPolicy?.hostId === context.targetId) {
      const host = checkRoomCapability(advertisement, 'watch-host-v1');
      if (!host.canAttempt) return host;
    }
  }
  // Connection to room discovery does not prove a usable media/LAN/file route.
  const measured = action === 'lan' ? room.lan.active && room.lan.participants.some(p => p.memberId !== room.members.find(m => m.isSelf)?.memberId && p.status === 'connected')
    : (room.connection?.channels.identified ?? 0) > 0;
  return measured ? result('supported', 'ready', 'continue', true) : result('unknown', 'network-unmeasured', 'try-connection', true);
}
