import type { RoomServerInstance, ServerSharedContent } from './gameserver-types';
import type { RoomState, RoomFile } from './types';

/** Bounded optional mirror metadata. It never grants authority or runs content. */
export function parseServerSharedContent(raw: unknown): ServerSharedContent[] | undefined {
  if (!Array.isArray(raw) || raw.length > 16) return undefined;
  const result: ServerSharedContent[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.slotId !== 'string' || !p.slotId || p.slotId.length > 128
      || seen.has(p.slotId) || typeof p.folderId !== 'string' || p.folderId.length > 256
      || !Array.isArray(p.extensions) || p.extensions.length > 16 || !p.extensions.length
      || !p.extensions.every((e: unknown) => typeof e === 'string' && /^\.[a-z0-9]{1,16}$/i.test(e))
      || p.compat !== undefined && (typeof p.compat !== 'string' || p.compat.length > 128)) return undefined;
    seen.add(p.slotId);
    result.push({ slotId: p.slotId, folderId: p.folderId, extensions: p.extensions.map((e: string) => e.toLowerCase()), ...(p.compat ? { compat: p.compat } : {}) });
  }
  return result;
}
export type PreparationNetwork = 'local' | 'ready' | 'unknown' | 'suspended' | 'unavailable' | 'join' | 'admission' | 'connecting' | 'failed' | 'host-missing';
export function preparationNetwork(instance: RoomServerInstance, room: RoomState | null): PreparationNetwork {
  if (instance.isHost) return 'local';
  if (!room) return 'unknown';
  const lan = room.lan;
  if (lan.suspended) return 'suspended';
  if (!lan.available) return 'unavailable';
  if (!lan.active) return lan.selfAdmitted ? 'join' : 'admission';
  if (!lan.selfVip || !instance.address) return 'host-missing';
  const peer = lan.participants.find(p => p.memberId === instance.hostId);
  if (!peer?.admitted) return 'host-missing';
  return peer.status === 'connected' || peer.relayVia ? 'ready' : peer.status === 'failed' ? 'failed' : 'connecting';
}
export function preparationFiles(instance: RoomServerInstance, room: RoomState | null): RoomFile[] {
  if (!room) return [];
  return room.files.filter(file => instance.sharedContent?.some(slot =>
    (file.folderId || '') === slot.folderId && slot.extensions.some(e => file.name.toLowerCase().endsWith(e.toLowerCase()))));
}
export function preparationAddress(instance: RoomServerInstance): string | null {
  if (instance.status !== 'running') return null;
  // A peer's missing LAN address must never become the viewer's loopback.
  return instance.isHost && instance.port ? `127.0.0.1:${instance.port}` : instance.address || null;
}
