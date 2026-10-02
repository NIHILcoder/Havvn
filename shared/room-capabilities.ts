/** Advertisements guide UI/compatibility only; they never grant authority. */
export const ROOM_PROTOCOL_VERSION = 2;
export const DESKTOP_ROOM_CAPABILITIES = ['chat-v2', 'manifest-pages-v1', 'voice-mesh-v1', 'voice-state-v2', 'watch-v2', 'watch-host-v1', 'files', 'file-proofs-v1', 'owner-transfer-v1', 'ban-state-v1', 'owner-manage', 'e2e-files', 'e2e-keys-v2', 'lan', 'server'] as const;
export const GUEST_ROOM_CAPABILITIES = ['chat-v2', 'manifest-pages-v1', 'voice-mesh-v1', 'voice-state-v2', 'watch-v2', 'watch-host-v1', 'files', 'file-proofs-v1', 'owner-transfer-v1', 'ban-state-v1'] as const;
export type RoomCapability = typeof DESKTOP_ROOM_CAPABILITIES[number];
export interface RoomCapabilities { protocolVersion?: number; capabilities?: RoomCapability[] }
export function validRoomCapabilities(m: { protocolVersion?: unknown; capabilities?: unknown }): boolean {
  return (m.protocolVersion === undefined || Number.isSafeInteger(m.protocolVersion) && (m.protocolVersion as number) > 0 && (m.protocolVersion as number) <= 65535)
    && (m.capabilities === undefined || Array.isArray(m.capabilities) && m.capabilities.length <= 32
      && m.capabilities.every(c => typeof c === 'string' && c.length > 0 && c.length <= 64) && new Set(m.capabilities).size === m.capabilities.length);
}
export function readRoomCapabilities(m: { protocolVersion?: number; capabilities?: string[] }): RoomCapabilities {
  return {
    ...(m.protocolVersion === undefined ? {} : { protocolVersion: m.protocolVersion }),
    ...(m.capabilities === undefined ? {} : { capabilities: m.capabilities.filter((c): c is RoomCapability => (DESKTOP_ROOM_CAPABILITIES as readonly string[]).includes(c)) }),
  };
}
