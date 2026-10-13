import { DEFAULT_ROOM_LAYOUT, RAIL_MIN, RAIL_MAX, CHAT_MIN, CHAT_MAX, type RoomLayout } from '../../utils/roomLayout';
import { defaultDockLayout, parseDockLayout, type DockLayout, type DockPanelId } from './dock/dockModel';

export const WORKSPACE_KEY = 'roomWorkspaces.v1';
export const SERVER_VIEW_EVENT = 'room-server-view';
const SERVER_VIEW_KEY = 'roomServerViews.v1';
export const SERVER_TABS = ['overview', 'console', 'content', 'schedule', 'access', 'backup', 'players', 'settings'] as const;
export type ServerViewTab = typeof SERVER_TABS[number];
export interface ServerView { instanceId: string | null; tab: ServerViewTab }
export interface RoomWorkspace {
  id: string;
  name: string;
  dock: DockLayout;
  widths: RoomLayout;
  server?: ServerView;
}
export const BUILTIN_WORKSPACES = ['social', 'cinema', 'game', 'admin'] as const;
export type BuiltinWorkspace = typeof BUILTIN_WORKSPACES[number];
export const MAX_WORKSPACES = 12;

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const width = (v: unknown, min: number, max: number, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fallback;
export function workspaceWidths(raw: unknown): RoomLayout {
  const p = obj(raw) ? raw : {};
  return { railW: width(p.railW, RAIL_MIN, RAIL_MAX, DEFAULT_ROOM_LAYOUT.railW), chatW: width(p.chatW, CHAT_MIN, CHAT_MAX, DEFAULT_ROOM_LAYOUT.chatW) };
}
export function parseServerView(raw: unknown): ServerView {
  const p = obj(raw) ? raw : {};
  return { instanceId: typeof p.instanceId === 'string' && p.instanceId.length <= 256 ? p.instanceId : null,
    tab: SERVER_TABS.includes(p.tab as ServerViewTab) ? p.tab as ServerViewTab : 'overview' };
}
export function loadServerView(roomId: string): ServerView {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SERVER_VIEW_KEY) || '{}');
    return parseServerView(obj(raw) ? raw[roomId] : null);
  } catch { return parseServerView(null); }
}
export function saveServerView(roomId: string, view: ServerView): void {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SERVER_VIEW_KEY) || '{}');
    const entries = obj(raw) ? Object.entries(raw).slice(-63) : [];
    localStorage.setItem(SERVER_VIEW_KEY, JSON.stringify(Object.fromEntries([...entries.filter(([id]) => id !== roomId), [roomId, parseServerView(view)]])));
  } catch { /* A blocked store does not prevent changing the view. */ }
}
export function applyServerView(roomId: string, view: ServerView): void {
  saveServerView(roomId, view);
  window.dispatchEvent(new CustomEvent(SERVER_VIEW_EVENT, { detail: { roomId, view } }));
}
export function builtinWorkspace(id: BuiltinWorkspace): RoomWorkspace {
  const dock = defaultDockLayout();
  const positions: Record<BuiltinWorkspace, [DockPanelId[], DockPanelId[], DockPanelId[]]> = {
    social: [['voice', 'people'], ['chat'], ['files']],
    cinema: [['voice', 'people'], ['files'], ['chat']],
    game: [['voice', 'chat'], ['server'], ['lan', 'people']],
    admin: [['people', 'lan', 'voice'], ['server'], ['chat']],
  };
  const [left, centre, right] = positions[id];
  const visible = new Set([...left, ...centre, ...right]);
  const hidden = Object.values(dock.zones).flatMap(z => z.panels).filter(p => !visible.has(p));
  dock.zones.left = { panels: left, active: left[0] };
  dock.zones.centre = { panels: centre, active: centre[0] };
  dock.zones.right = { panels: right, active: right[0] };
  dock.hidden = hidden.map(p => ({ id: p }));
  return { id, name: id, dock, widths: { ...DEFAULT_ROOM_LAYOUT },
    ...(['game', 'admin'].includes(id) ? { server: { instanceId: null, tab: id === 'admin' ? 'console' as const : 'overview' as const } } : {}) };
}
export function captureWorkspace(id: string, name: string, dock: DockLayout, widths: RoomLayout, server: ServerView): RoomWorkspace {
  // Use the dock's existing storage boundary: detached groups fold home and all
  // panels remain represented exactly once, including hidden ones.
  return { id, name: name.trim().slice(0, 80), dock: parseDockLayout(JSON.stringify(dock)), widths: workspaceWidths(widths), server: parseServerView(server) };
}
export function parseWorkspaces(text: string | null): RoomWorkspace[] {
  try {
    const raw: unknown = JSON.parse(text || 'null');
    if (!obj(raw) || raw.v !== 1 || !Array.isArray(raw.items)) return [];
    const seen = new Set<string>();
    return raw.items.slice(0, MAX_WORKSPACES).flatMap(p => {
      if (!obj(p) || typeof p.id !== 'string' || !/^custom-[\w-]{1,80}$/.test(p.id) || seen.has(p.id)
        || typeof p.name !== 'string' || !p.name.trim() || !obj(p.dock)) return [];
      seen.add(p.id);
      return [captureWorkspace(p.id, p.name, p.dock as unknown as DockLayout, workspaceWidths(p.widths), parseServerView(p.server))];
    });
  } catch { return []; }
}
export function loadWorkspaces(): RoomWorkspace[] {
  try { return parseWorkspaces(localStorage.getItem(WORKSPACE_KEY)); } catch { return []; }
}
export function saveWorkspaces(items: RoomWorkspace[]): boolean {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ v: 1, items: items.slice(0, MAX_WORKSPACES) }));
    return true;
  } catch { return false; }
}
