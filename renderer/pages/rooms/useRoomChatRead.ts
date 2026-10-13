import { useEffect, useRef, type RefObject } from 'react';
import type { RoomChatMessage } from '../../../shared/types';

/** Read only rows actually visible in the focused window that owns the chat. */
export function useRoomChatRead(roomId: string, messages: RoomChatMessage[], lastRead: number, list: RefObject<HTMLDivElement>, enabled: boolean) {
  const sent = useRef({ roomId, at: lastRead });
  const latest = useRef({ roomId, messages, lastRead, enabled });
  latest.current = { roomId, messages, lastRead, enabled };
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const doc = el.ownerDocument, win = doc.defaultView;
    if (!win) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const data = latest.current;
      if (!data.enabled || doc.visibilityState !== 'visible' || !doc.hasFocus() || !el.isConnected || !el.getClientRects().length) return;
      const box = el.getBoundingClientRect();
      if (!box.height || !box.width) return;
      const ids = new Set([...el.querySelectorAll<HTMLElement>('[data-chat-id]')].filter(row => {
        const r = row.getBoundingClientRect();
        return r.bottom > Math.max(box.top, 0) && r.top < Math.min(box.bottom, win.innerHeight);
      }).map(row => row.dataset.chatId));
      const visible = data.messages.filter(m => ids.has(m.id));
      const target = visible.reduce<RoomChatMessage | undefined>((best, m) => !best || (m.receivedAt ?? m.at) > (best.receivedAt ?? best.at) ? m : best, undefined);
      if (!target) return;
      const at = target.receivedAt ?? target.at;
      if (sent.current.roomId !== data.roomId) sent.current = { roomId: data.roomId, at: data.lastRead };
      if (at <= Math.max(data.lastRead, sent.current.at)) return;
      sent.current.at = at;
      window.api.rooms.markRead(data.roomId, target.id).catch(() => { if (sent.current.roomId === data.roomId && sent.current.at === at) sent.current.at = data.lastRead; });
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(read, 200); };
    el.addEventListener('scroll', schedule); win.addEventListener('focus', schedule); doc.addEventListener('visibilitychange', schedule);
    const observer = new (win as Window & typeof globalThis).ResizeObserver(schedule); observer.observe(el);
    schedule();
    return () => { clearTimeout(timer); observer.disconnect(); el.removeEventListener('scroll', schedule); win.removeEventListener('focus', schedule); doc.removeEventListener('visibilitychange', schedule); };
  }, [roomId, messages, lastRead, enabled, list]);
}
