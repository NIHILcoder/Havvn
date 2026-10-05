import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { DEFAULT_APPEARANCE } from '../../shared/appearance';

const prefs = vi.hoisted(() => ({ glass: false, intensity: 55, dialogs: true }));
vi.mock('./theme-library', () => ({ getActiveTheme: () => ({ name: '<Biosphere>' }) }));
vi.mock('./appearance', () => ({ readEffectiveAppearance: () => ({
  ...DEFAULT_APPEARANCE, material: prefs.glass ? 'liquid' : 'solid', intensity: prefs.intensity,
  scopes: prefs.dialogs ? ['dialogs'] : [], background: 'image',
}) }));

function element() {
  return { dataset: {} as Record<string, string>, textContent: '', hidden: true, disabled: false,
    childElementCount: 0, classList: { add: vi.fn() }, remove: vi.fn(), onclick: undefined as (() => void) | undefined };
}
let elements: Map<string, ReturnType<typeof element>>;
let openLogs: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(10000);
  prefs.glass = false; prefs.intensity = 55; prefs.dialogs = true;
  elements = new Map(['th-splash', 'th-splash-status', 'th-splash-tagline', 'th-splash-theme-name',
    'th-splash-slow', 'th-splash-slow-text', 'th-splash-logs', 'th-splash-reload', 'root'].map(id => [id, element()]));
  openLogs = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('document', { documentElement: { lang: 'ru' }, getElementById: (id: string) => elements.get(id) });
  vi.stubGlobal('window', { setTimeout, clearTimeout, location: { reload: vi.fn() }, api: { openLogsFolder: openLogs } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('startup recovery and dismissal', () => {
  it('localizes real milestones and inserts a saved theme name as text', async () => {
    const splash = await import('./splash'); splash.initializeSplash(); splash.setSplashStage('downloads');
    expect(elements.get('th-splash-status')?.textContent).toBe('Подготовка загрузок');
    expect(elements.get('th-splash-theme-name')?.textContent).toBe('<Biosphere>');
  });
  it('uses the wallpaper only when dialog glass is enabled and nonzero', async () => {
    const splash = await import('./splash'); splash.initializeSplash();
    expect(elements.get('th-splash')?.dataset.backdrop).toBe('none');
    prefs.glass = true; splash.initializeSplash();
    expect(elements.get('th-splash')?.dataset.backdrop).toBe('image');
    prefs.intensity = 0; splash.initializeSplash();
    expect(elements.get('th-splash')?.dataset.glass).toBe('false');
    prefs.intensity = 55; prefs.dialogs = false; splash.initializeSplash();
    expect(elements.get('th-splash')?.dataset.glass).toBe('false');
  });
  it('honors the minimum duration and dismisses only once across repeated replies', async () => {
    const splash = await import('./splash'); splash.armSplashFailsafe(); splash.dismissSplash(); splash.dismissSplash();
    splash.setSplashStage('downloads');
    expect(elements.get('th-splash-status')?.textContent).toBe('Готово');
    vi.advanceTimersByTime(449); expect(elements.get('th-splash')?.classList.add).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(elements.get('th-splash')?.classList.add).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(6000); expect(elements.get('th-splash')?.remove).toHaveBeenCalledOnce();
    expect(elements.get('th-splash-slow')?.hidden).toBe(true);
  });
  it('unblocks a mounted interface when the engine never replies', async () => {
    elements.get('root')!.childElementCount = 1;
    const splash = await import('./splash'); splash.armSplashFailsafe(); splash.armSplashFailsafe();
    vi.advanceTimersByTime(4000); expect(elements.get('th-splash-slow')?.hidden).toBe(false);
    vi.advanceTimersByTime(2000); expect(elements.get('th-splash')?.classList.add).toHaveBeenCalledOnce();
  });
  it('retains recovery controls when React or a language chunk fails to mount', async () => {
    const splash = await import('./splash'); splash.initializeSplash(); splash.armSplashFailsafe();
    vi.advanceTimersByTime(6500);
    expect(elements.get('th-splash')?.remove).not.toHaveBeenCalled();
    expect(elements.get('th-splash-slow')?.hidden).toBe(false);
    elements.get('th-splash-logs')?.onclick?.(); await vi.runAllTimersAsync();
    expect(openLogs).toHaveBeenCalledOnce();
    elements.get('th-splash-reload')?.onclick?.(); expect(window.location.reload).toHaveBeenCalledOnce();
  });
  it('handles a failed logs bridge without an unhandled rejection', async () => {
    openLogs.mockRejectedValue(new Error('unavailable'));
    const splash = await import('./splash'); splash.initializeSplash();
    elements.get('th-splash-logs')?.onclick?.(); await vi.runAllTimersAsync();
    expect(elements.get('th-splash-slow-text')?.textContent).toContain('Не удалось');
    expect(elements.get('th-splash-logs')?.disabled).toBe(false);
  });
});
