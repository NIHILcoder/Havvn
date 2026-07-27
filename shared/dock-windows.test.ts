import { describe, it, expect } from 'vitest';
import {
  DOCK_WINDOW_POOL_SIZE, DOCK_WINDOW_PREFIX, DOCK_WINDOW_FRAME_NAMES,
  POPOUT_FRAME_PREFIX, LEGACY_CHAT_FRAME_NAME,
  dockWindowFrameName, isDockWindowFrame, isPopoutFrameName,
} from './dock-windows';

describe('dock window pool', () => {
  it('exposes exactly POOL_SIZE names, in allocation order, 1-based', () => {
    expect(DOCK_WINDOW_FRAME_NAMES).toEqual(['havvn-dock-1', 'havvn-dock-2', 'havvn-dock-3', 'havvn-dock-4']);
    expect(DOCK_WINDOW_FRAME_NAMES).toHaveLength(DOCK_WINDOW_POOL_SIZE);
  });

  it('has no duplicate names (a duplicate would silently shrink the pool)', () => {
    expect(new Set(DOCK_WINDOW_FRAME_NAMES).size).toBe(DOCK_WINDOW_FRAME_NAMES.length);
  });

  it('keeps every pool name under the pop-out prefix', () => {
    expect(DOCK_WINDOW_PREFIX.startsWith(POPOUT_FRAME_PREFIX)).toBe(true);
    for (const n of DOCK_WINDOW_FRAME_NAMES) expect(isPopoutFrameName(n)).toBe(true);
  });

  it('maps 1-based slots to names and refuses anything out of range', () => {
    expect(dockWindowFrameName(1)).toBe('havvn-dock-1');
    expect(dockWindowFrameName(DOCK_WINDOW_POOL_SIZE)).toBe(`${DOCK_WINDOW_PREFIX}${DOCK_WINDOW_POOL_SIZE}`);
    expect(dockWindowFrameName(0)).toBeNull();
    expect(dockWindowFrameName(DOCK_WINDOW_POOL_SIZE + 1)).toBeNull();
    expect(dockWindowFrameName(1.5)).toBeNull();
    expect(dockWindowFrameName(Number.NaN)).toBeNull();
  });

  it('dockWindowFrameName agrees with the frame-name array for every slot', () => {
    for (let i = 1; i <= DOCK_WINDOW_POOL_SIZE; i++) {
      expect(dockWindowFrameName(i)).toBe(DOCK_WINDOW_FRAME_NAMES[i - 1]);
    }
  });

  it('isDockWindowFrame is exact membership, not a prefix test', () => {
    expect(isDockWindowFrame('havvn-dock-1')).toBe(true);
    // The pool-exhaustion backstop: a slot beyond the pool is NOT a dock window,
    // so main.ts denies it and the renderer gets a `not-allowed` reason.
    expect(isDockWindowFrame(`${DOCK_WINDOW_PREFIX}${DOCK_WINDOW_POOL_SIZE + 1}`)).toBe(false);
    expect(isDockWindowFrame('havvn-dock-')).toBe(false);
    expect(isDockWindowFrame('havvn-dock-01')).toBe(false);
    expect(isDockWindowFrame('havvn-theme-editor')).toBe(false);
    expect(isDockWindowFrame('')).toBe(false);
  });

  it('isPopoutFrameName separates our windows from ordinary external links', () => {
    expect(isPopoutFrameName('havvn-theme-editor')).toBe(true);
    expect(isPopoutFrameName(LEGACY_CHAT_FRAME_NAME)).toBe(true);
    // window.open('https://…') and <a target="_blank"> arrive with these.
    expect(isPopoutFrameName('')).toBe(false);
    expect(isPopoutFrameName('_blank')).toBe(false);
  });

  it('does not collide the legacy chat name with a pool slot', () => {
    expect(isDockWindowFrame(LEGACY_CHAT_FRAME_NAME)).toBe(false);
  });
});
