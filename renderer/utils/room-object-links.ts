import type { RoomWorkspaceObject } from '../../shared/room-object-links';
export const ROOM_OBJECT_OPEN = 'havvn:room-object-open';
export interface RoomObjectOpenRequest { roomId: string; target: RoomWorkspaceObject; claimed: boolean }
export function requestRoomObject(roomId: string, target: RoomWorkspaceObject): boolean {
  const detail: RoomObjectOpenRequest = { roomId, target, claimed: false };
  window.dispatchEvent(new CustomEvent(ROOM_OBJECT_OPEN, { detail })); return detail.claimed;
}
