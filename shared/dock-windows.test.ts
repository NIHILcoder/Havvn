import { describe, it, expect } from 'vitest';
import {
  DOCK_WINDOW_POOL_SIZE, DOCK_WINDOW_PREFIX, DOCK_WINDOW_FRAME_NAMES,
  POPOUT_FRAME_PREFIX, LEGACY_CHAT_FRAME_NAME,
  dockWindowFrameName, isDockWindowFrame, isPopoutFrameName,
  DOCK_AT_CURSOR_FEATURE, DOCK_AT_CURSOR_FEATURE_STR, DOCK_TEAROFF_GRAB,
  wantsCursorPlacement, dockWindowBoundsAtCursor,
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

describe('cursor placement — the flag a tear-off puts in the features string', () => {
  it('recognises the flag this app actually sends', () => {
    expect(wantsCursorPlacement(DOCK_AT_CURSOR_FEATURE_STR)).toBe(true);
    expect(DOCK_AT_CURSOR_FEATURE_STR).toContain(DOCK_AT_CURSOR_FEATURE);
  });

  it('is false for every ordinary open', () => {
    // Every other pop-out (theme editor, voice settings) passes no features at all,
    // and must keep opening at its own saved bounds.
    expect(wantsCursorPlacement(undefined)).toBe(false);
    expect(wantsCursorPlacement('')).toBe(false);
    expect(wantsCursorPlacement(null)).toBe(false);
    expect(wantsCursorPlacement('width=460,height=700')).toBe(false);
  });

  it('reads OUR key strictly, ignoring anything else in the string', () => {
    // Parsed here rather than left to Electron's own feature interpretation, which
    // is version-dependent — this decides where a user's window appears.
    expect(wantsCursorPlacement('popup=1,havvnAtCursor=1')).toBe(true);
    expect(wantsCursorPlacement(' havvnAtCursor = 1 ')).toBe(true);
    expect(wantsCursorPlacement('havvnAtCursor')).toBe(true);
    expect(wantsCursorPlacement('havvnAtCursor=0')).toBe(false);
    expect(wantsCursorPlacement('xhavvnAtCursor=1')).toBe(false);
    expect(wantsCursorPlacement('havvnAtCursorX=1')).toBe(false);
  });
});

describe('dockWindowBoundsAtCursor', () => {
  const WA = { x: 0, y: 0, width: 1920, height: 1040 };
  const SIZE = { width: 460, height: 700 };

  it('anchors the title area under the pointer, not the corner', () => {
    const b = dockWindowBoundsAtCursor({ x: 800, y: 200 }, SIZE, WA);
    expect(b).toEqual({ x: 800 - DOCK_TEAROFF_GRAB.x, y: 200 - DOCK_TEAROFF_GRAB.y, width: 460, height: 700 });
  });

  it('clamps into the work area on every edge', () => {
    expect(dockWindowBoundsAtCursor({ x: 0, y: 0 }, SIZE, WA).x).toBe(0);
    expect(dockWindowBoundsAtCursor({ x: 0, y: 0 }, SIZE, WA).y).toBe(0);
    expect(dockWindowBoundsAtCursor({ x: 1919, y: 1039 }, SIZE, WA)).toEqual({
      x: 1920 - 460, y: 1040 - 700, width: 460, height: 700,
    });
  });

  it('handles a monitor to the LEFT of the primary (negative origin)', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1080 };
    const b = dockWindowBoundsAtCursor({ x: -1900, y: 20 }, SIZE, left);
    expect(b.x).toBe(-1920);
    expect(b.y).toBe(4);
  });

  it('shrinks a window that cannot fit rather than hiding its titlebar off-screen', () => {
    const small = { x: 0, y: 0, width: 400, height: 300 };
    expect(dockWindowBoundsAtCursor({ x: 200, y: 150 }, SIZE, small)).toEqual({
      x: 0, y: 0, width: 400, height: 300,
    });
  });
});
