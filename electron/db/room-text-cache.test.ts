import { describe, expect, it, vi } from 'vitest';
import { RoomTextCache } from './room-text-cache';

describe('bounded protected text cache', () => {
  it('decodes repeated text once and evicts the least recently used entry', () => {
    const cache = new RoomTextCache(20), decode = vi.fn((value: string) => value.toUpperCase());
    cache.get('a', decode); cache.get('bb', decode); cache.get('a', decode);
    cache.get('ccc', decode); // 4+8+12 exceeds the budget: evict bb.
    expect(cache.get('a', decode)).toBe('A'); expect(decode).toHaveBeenCalledTimes(3);
    cache.get('bb', decode); expect(decode).toHaveBeenCalledTimes(4);
    cache.clear(); cache.get('bb', decode); expect(decode).toHaveBeenCalledTimes(5);
  });
  it('never caches decryption failures or values larger than its budget', () => {
    const cache = new RoomTextCache(8), decode = vi.fn(() => '');
    cache.get('locked', decode); cache.get('locked', decode); expect(decode).toHaveBeenCalledTimes(2);
    decode.mockReturnValue('long body'); cache.get('large', decode); cache.get('large', decode);
    expect(decode).toHaveBeenCalledTimes(4);
  });
});
