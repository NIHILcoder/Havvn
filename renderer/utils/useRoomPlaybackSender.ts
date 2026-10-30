import { useCallback, useEffect, useRef } from 'react';
import type { WatchInput } from '../../shared/room-watch-sync';

/** Only deliberate requests report a result; heartbeat failures stay quiet. */
export function useRoomPlaybackSender(roomId: string, policy: string, notices: { sent: () => void; failed: () => void }) {
  const current = useRef({ roomId, policy, notices });
  current.current = { roomId, policy, notices };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return useCallback(async (input: WatchInput) => {
    // Keep media listeners attached when the host policy changes. Each send still
    // captures its own authority context so a late result cannot notify a new one.
    const attempt = current.current;
    const active = () => mounted.current && current.current.roomId === attempt.roomId && current.current.policy === attempt.policy;
    try {
      const result = await window.api.rooms.broadcastSync(attempt.roomId, input);
      if (!result?.ok) throw new Error('Watch command was not sent');
      if (input.action === 'request' && active()) current.current.notices.sent();
    } catch {
      if (input.action === 'request' && active()) current.current.notices.failed();
    }
  }, []);
}
