import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { RoomChatComposer } from './roomChatComposer';

// Dock portals/remounts share this renderer realm; room identities stay separate.
const composers = new Map<string, RoomChatComposer>();
export function discardRoomChatComposer(roomId: string) {
  composers.get(roomId)?.dispose(); composers.delete(roomId);
}
export function useRoomChatComposer(roomId: string) {
  const composer = useMemo(() => {
    let value = composers.get(roomId);
    if (!value) { value = new RoomChatComposer(roomId, window.api.rooms); composers.set(roomId, value); }
    return value;
  }, [roomId]);
  const state = useSyncExternalStore(composer.subscribe, composer.getSnapshot);
  useEffect(() => () => { void composer.flush().catch(() => {}); }, [composer]);
  return { composer, state };
}
