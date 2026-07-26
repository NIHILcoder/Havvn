/**
 * Room three-region layout widths (left People+Voice rail, right Chat), persisted
 * per-install so the user's dragged splitter positions survive reloads. The center
 * Stage takes the remaining space. Clamped on load so a stale/garbage value can't
 * squeeze a region to nothing.
 */
export const ROOM_LAYOUT_KEY = 'roomLayout';

export const RAIL_MIN = 180;
export const RAIL_MAX = 360;
export const CHAT_MIN = 260;
export const CHAT_MAX = 460;

export type RoomLayout = { railW: number; chatW: number };

/**
 * The arrangement a fresh install (and "Reset layout") gets. Readonly because it is
 * shared: callers must spread it rather than hand the singleton to setState and then
 * mutate it. Deliberately NOT versioned — stored blobs carry no schema stamp, so a
 * discard-on-mismatch rule would wipe every existing user's dragged widths.
 */
export const DEFAULT_ROOM_LAYOUT: Readonly<RoomLayout> = { railW: 240, chatW: 340 };

const clamp = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : dflt;
};

export function loadRoomLayout(): RoomLayout {
  let p: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(ROOM_LAYOUT_KEY) || '{}');
    // JSON.parse succeeds on scalars/null/arrays too — only trust a plain object,
    // else the property reads below would throw on null.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) p = parsed;
  } catch { /* defaults */ }
  return {
    railW: clamp(p.railW, RAIL_MIN, RAIL_MAX, DEFAULT_ROOM_LAYOUT.railW),
    chatW: clamp(p.chatW, CHAT_MIN, CHAT_MAX, DEFAULT_ROOM_LAYOUT.chatW),
  };
}

export function saveRoomLayout(l: RoomLayout): void {
  try { localStorage.setItem(ROOM_LAYOUT_KEY, JSON.stringify(l)); } catch { /* ignore */ }
}
