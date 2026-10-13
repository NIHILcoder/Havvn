import { useEffect, useRef, useState } from 'react';
import { chatFilterActive, type RoomChatFilter, type RoomChatSearchPage } from '../../../shared/room-chat-tools';

const EMPTY_PAGE: RoomChatSearchPage = { messages: [], edits: {} };
export function useRoomChatSearch(roomId: string, filter: RoomChatFilter, revision: string) {
  const key = JSON.stringify([roomId, filter, revision]);
  const generation = useRef(0);
  const morePending = useRef<number>();
  const [result, setResult] = useState({ key: '', page: EMPTY_PAGE, busy: false, error: '' });
  const current = useRef(key); current.current = key;
  const active = chatFilterActive(filter);
  useEffect(() => {
    const id = ++generation.current;
    if (!active) return;
    setResult({ key, page: EMPTY_PAGE, busy: true, error: '' });
    const timer = window.setTimeout(() => {
      window.api.rooms.searchChat(roomId, filter).then(page => {
        if (generation.current === id && current.current === key) setResult({ key, page, busy: false, error: '' });
      }).catch(e => {
        if (generation.current === id && current.current === key) setResult({ key, page: EMPTY_PAGE, busy: false, error: String(e instanceof Error ? e.message : e) });
      });
    }, 250);
    return () => { window.clearTimeout(timer); generation.current = id + 1; };
  }, [key, active, roomId, filter]);
  const more = async () => {
    if (result.busy || !result.page.next || result.key !== key || morePending.current === generation.current) return;
    const id = generation.current, cursor = result.page.next;
    morePending.current = id;
    setResult(r => ({ ...r, busy: true, error: '' }));
    try {
      const page = await window.api.rooms.searchChat(roomId, filter, cursor);
      if (generation.current !== id || current.current !== key) return;
      setResult(r => ({ key, busy: false, error: '', page: { next: page.next,
        messages: [...page.messages, ...r.page.messages.filter(m => !page.messages.some(p => p.id === m.id))], edits: { ...r.page.edits, ...page.edits } } }));
    } catch (e) { if (generation.current === id && current.current === key) setResult(r => ({ ...r, busy: false, error: String(e instanceof Error ? e.message : e) })); }
    finally { if (morePending.current === id) morePending.current = undefined; }
  };
  return { active, ...(result.key === key ? result : { key, page: EMPTY_PAGE, busy: active, error: '' }), more };
}
