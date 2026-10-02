import { describe, expect, it } from 'vitest';
import { historyDays, localHistoryPage, retainLocalHistory } from './room-local-data';
describe('bounded local room history', () => {
  it('pages by stable IDs even when messages arrive between requests', () => {
    const list = Array.from({ length: 133 }, (_, i) => ({ id: String(i) }));
    const page = localHistoryPage(list); expect(page.items).toHaveLength(50); expect(page.next).toBe('83');
    const older = localHistoryPage([...list, { id: 'new' }], page.next);
    expect(older.items.map(i=>i.id)).toEqual(list.slice(33,83).map(i=>i.id)); expect(older.next).toBe('33');
    const earliest = localHistoryPage(list, older.next); expect(earliest.items).toHaveLength(33); expect(earliest.next).toBeUndefined();
  });
  it('does not jump to the latest page when retention prunes the cursor', () => {
    expect(localHistoryPage([{ id: 'latest' }], 'pruned')).toEqual({ items: [], cursorExpired: true });
    expect(()=>localHistoryPage([], 'a'.repeat(257))).toThrow();
  });
  it('uses the local receipt clock and still caps no-expiry history', () => {
    const now = 86400000 * 100;
    expect(retainLocalHistory([{ id: 1, received: now - 31*86400000 }, { id: 2, received: now }], 30, m=>m.received, now).map(m=>m.id)).toEqual([2]);
    expect(retainLocalHistory(Array.from({ length: 5100 }, (_, id) => ({ id })), 0, ()=>1, now)).toHaveLength(5000);
    for (const invalid of [-1, 1, '30', Infinity, null]) expect(()=>historyDays(invalid)).toThrow();
  });
});
