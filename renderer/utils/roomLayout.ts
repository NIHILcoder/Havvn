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
    railW: clamp(p.railW, RAIL_MIN, RAIL_MAX, 240),
    chatW: clamp(p.chatW, CHAT_MIN, CHAT_MAX, 340),
  };
}

export function saveRoomLayout(l: RoomLayout): void {
  try { localStorage.setItem(ROOM_LAYOUT_KEY, JSON.stringify(l)); } catch { /* ignore */ }
}
