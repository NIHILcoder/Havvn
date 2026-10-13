import { describe, expect, it, afterEach, vi } from 'vitest';
import { BUILTIN_WORKSPACES, builtinWorkspace, captureWorkspace, parseWorkspaces, loadWorkspaces, loadServerView, saveServerView, workspaceWidths } from './roomWorkspace';
import { DOCK_PANEL_IDS, detachPanel, hidePanel, openWindowZones, zoneOfPanel } from './dock/dockModel';

afterEach(() => vi.unstubAllGlobals());
describe('room workspaces', () => {
  it('keeps every panel exactly once, with a usable centre in every built-in view', () => {
    for (const id of BUILTIN_WORKSPACES) {
      const { dock } = builtinWorkspace(id);
      const panels = [...Object.values(dock.zones).flatMap(z => z.panels), ...dock.hidden.map(p => p.id)];
      expect(panels.sort()).toEqual([...DOCK_PANEL_IDS].sort());
      expect(dock.zones.centre.panels).not.toHaveLength(0);
      expect(openWindowZones(dock)).toEqual([]);
    }
    expect(builtinWorkspace('admin').server?.tab).toBe('console');
  });
  it('captures a detached group safely and preserves hidden panels', () => {
    let dock = builtinWorkspace('game').dock;
    dock = hidePanel(dock, 'people').layout;
    dock = detachPanel(dock, 'chat').layout;
    expect(openWindowZones(dock)).not.toHaveLength(0);
    const saved = captureWorkspace('custom-test', ' My layout ', dock, { railW: 1, chatW: 99999 }, { instanceId: 'server-a', tab: 'console' });
    expect(openWindowZones(saved.dock)).toEqual([]);
    expect(zoneOfPanel(saved.dock, 'chat')).toBe('left');
    expect(saved.dock.hidden.map(p => p.id)).toContain('people');
    expect(saved.name).toBe('My layout');
    expect(saved.server).toEqual({ instanceId: 'server-a', tab: 'console' });
    expect(saved.widths).toEqual({ railW: 180, chatW: 460 });
  });
  it('rejects corrupted storage and duplicate IDs while repairing a broken dock', () => {
    expect(parseWorkspaces('null')).toEqual([]);
    expect(parseWorkspaces('{bad')).toEqual([]);
    const p = { id: 'custom-x', name: 'x', dock: { v: 2, zones: {} }, widths: {} };
    const saved = parseWorkspaces(JSON.stringify({ v: 1, items: [p, p, { ...p, id: '__proto__' }] }));
    expect(saved).toHaveLength(1);
    expect(Object.values(saved[0].dock.zones).flatMap(z => z.panels).sort()).toEqual([...DOCK_PANEL_IDS].sort());
    expect(workspaceWidths({ railW: null, chatW: Infinity })).toEqual({ railW: 240, chatW: 340 });
  });
  it('isolates server selection per room and survives blocked storage', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) });
    saveServerView('a', { instanceId: 'one', tab: 'console' });
    saveServerView('b', { instanceId: 'two', tab: 'backup' });
    expect(loadServerView('a')).toEqual({ instanceId: 'one', tab: 'console' });
    expect(loadServerView('b')).toEqual({ instanceId: 'two', tab: 'backup' });
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked'); } });
    expect(loadWorkspaces()).toEqual([]);
    expect(loadServerView('a')).toEqual({ instanceId: null, tab: 'overview' });
  });
});
