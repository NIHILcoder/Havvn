import { DEFAULT_APPEARANCE, validateAppearance, type Appearance, type AcrylicStatus, type ThemeGlass } from '../../shared/appearance';
const KEY = 'havvn.appearance.v1';
const IMAGE_KEY = 'havvn.appearance.wallpaper.v1';
let wallpaperCache: string | undefined;
export const APPEARANCE_EVENT = 'havvn:appearance';
let status: AcrylicStatus = { enabled: false, active: false, reason: 'off' };
let revision = 0;
let themeGlass: ThemeGlass | undefined;
/** A transient theme layer: previewing never writes window preferences. */
export function applyThemeGlass(glass?: ThemeGlass): void {
  themeGlass = glass ? structuredClone(glass) : undefined;
  paintAppearance(readAppearance()); notify();
}
export function readEffectiveAppearance(): Appearance {
  return { ...readAppearance(), ...structuredClone(themeGlass || {}) };
}
export function readAppearance(): Appearance {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const prefs = raw as Appearance;
      if (prefs.wallpaper === '') {
        wallpaperCache ??= localStorage.getItem(IMAGE_KEY) || '';
        return validateAppearance({ ...prefs, wallpaper: wallpaperCache }) || structuredClone(DEFAULT_APPEARANCE);
      }
    }
    return validateAppearance(raw) || structuredClone(DEFAULT_APPEARANCE);
  }
  catch { return structuredClone(DEFAULT_APPEARANCE); }
}
/** Keep the potentially large image separate: moving a slider writes only small settings. */
function persistAppearance(p: Appearance): void {
  const previousImage = wallpaperCache ?? localStorage.getItem(IMAGE_KEY) ?? '';
  const changedImage = previousImage !== p.wallpaper;
  if (changedImage) {
    if (p.wallpaper) localStorage.setItem(IMAGE_KEY, p.wallpaper); else localStorage.removeItem(IMAGE_KEY);
  }
  try { localStorage.setItem(KEY, JSON.stringify({ ...p, wallpaper: '' })); }
  catch (error) {
    if (changedImage) {
      if (previousImage) localStorage.setItem(IMAGE_KEY, previousImage); else localStorage.removeItem(IMAGE_KEY);
    }
    throw error;
  }
  wallpaperCache = p.wallpaper;
}
export function acrylicStatus(): AcrylicStatus { return status; }
export function paintAppearance(p: Appearance): void {
  p = { ...p, ...themeGlass };
  const root = document.documentElement;
  root.dataset.material = p.intensity === 0 ? 'solid' : p.material;
  root.dataset.acrylic = status.active ? 'active' : 'off';
  root.dataset.glassScopes = p.scopes.join(' ');
  root.dataset.glassQuality = p.quality;
  root.dataset.glassMotion = p.motion ? 'on' : 'off';
  root.dataset.appBackground = p.background;
  root.dataset.radiusOverrides = Object.entries(p.radii).filter(([, radius]) => radius !== null).map(([area]) => area).join(' ');
  const strength = p.intensity / 100;
  const values = {
    '--ap-opacity': `${100 - (100 - p.opacity) * strength}%`,
    '--ap-blur': `${p.quality === 'light' ? Math.min(8, p.blur) : p.blur}px`,
    '--ap-tint': `${p.tint * strength}%`,
    '--ap-highlight': `${p.highlight * strength * (p.material === 'liquid' ? 1 : .3)}%`,
    '--ap-depth': `${p.depth * strength / 250}`,
    '--ap-dim': `${p.backgroundDim}%`,
    '--ap-wallpaper': p.background === 'image' ? `url("${p.wallpaper}")` : 'none',
  };
  for (const [key, value] of Object.entries(values)) root.style.setProperty(key, value);
  for (const [area, radius] of Object.entries(p.radii)) {
    if (radius === null) root.style.removeProperty(`--ap-radius-${area}`);
    else root.style.setProperty(`--ap-radius-${area}`, `${radius}px`);
  }
}
function notify(): void { window.dispatchEvent(new Event(APPEARANCE_EVENT)); }
/** A quota failure must not pretend a wallpaper/profile has been saved. */
export async function saveAppearance(p: Appearance): Promise<void> {
  const valid = validateAppearance(p);
  if (!valid) throw new Error('Invalid appearance');
  const previous = readAppearance();
  persistAppearance(valid);
  paintAppearance(valid);
  notify();
  if (previous.acrylic !== valid.acrylic || status.enabled !== valid.acrylic) {
    const currentRevision = ++revision;
    try {
      const next = await window.api.appearance.setAcrylic(valid.acrylic);
      if (currentRevision !== revision) return;
      status = next;
      paintAppearance(readAppearance()); notify();
    } catch (error) {
      if (currentRevision === revision) {
        const restored = { ...readAppearance(), acrylic: previous.acrylic };
        persistAppearance(restored); paintAppearance(restored); notify();
      }
      throw error;
    }
  }
}
export function bootAppearance(): () => void {
  let alive = true;
  paintAppearance(readAppearance());
  const initialRevision = revision;
  const acceptStatus = (next: AcrylicStatus) => {
    if (!alive) return;
    status = next;
    paintAppearance(readAppearance());
    notify();
  };
  const off = window.api.appearance?.onAcrylicChanged(acceptStatus);
  void window.api.appearance?.getAcrylic().then(next => {
    if (!alive || initialRevision !== revision) return;
    const prefs = { ...readAppearance(), acrylic: next.enabled };
    try { persistAppearance(prefs); } catch { /* display still works */ }
    acceptStatus(next);
  }).catch(() => { /* opaque window without the bridge */ });
  const stopMotion = installAppearanceMotion(document);
  const onStorage = (event: StorageEvent) => {
    if (event.key === IMAGE_KEY || event.key === KEY || event.key === null) {
      wallpaperCache = undefined; paintAppearance(readAppearance()); notify();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => { alive = false; off?.(); stopMotion(); window.removeEventListener('storage', onStorage); };
}
/** Shared with same-origin UI popouts; events and frame clocks belong to that document. */
export function installAppearanceMotion(doc: Document): () => void {
  const host = doc.defaultView;
  if (!host) return () => {};
  // No perpetual animation loop; at most one update per pointer frame.
  let frame = 0;
  let target: HTMLElement | null = null;
  let x = 50, y = 0;
  const media = host.matchMedia('(prefers-reduced-motion: reduce)');
  const clear = () => {
    if (frame) host.cancelAnimationFrame(frame);
    frame = 0;
    target?.style.removeProperty('--ap-x'); target?.style.removeProperty('--ap-y'); target = null;
  };
  const move = (event: PointerEvent) => {
    const root = doc.documentElement;
    if (root.dataset.material !== 'liquid' || root.dataset.glassMotion !== 'on' ||
        root.dataset.glassQuality === 'light' || root.hasAttribute('data-reduce-motion') || media.matches) { clear(); return; }
    const element = event.target as Element | null;
    const next = element?.nodeType === 1 && typeof element.closest === 'function' ? element.closest<HTMLElement>(
      '.sidebar,.titlebar,.page-header,.um-card,.stg-card,.custom-select-dropdown,.dropdown-menu,.query-history-menu,.context-menu,.pc-menu,.pc,.ted,.ap-preview-surface') : null;
    if (target !== next) { clear(); target = next; }
    if (!target) return;
    const bounds = target.getBoundingClientRect();
    x = Math.max(0, Math.min(100, (event.clientX - bounds.left) / Math.max(1, bounds.width) * 100));
    y = Math.max(0, Math.min(100, (event.clientY - bounds.top) / Math.max(1, bounds.height) * 100));
    if (!frame) frame = host.requestAnimationFrame(() => {
      frame = 0; target?.style.setProperty('--ap-x', `${x}%`); target?.style.setProperty('--ap-y', `${y}%`);
    });
  };
  doc.addEventListener('pointermove', move, { passive: true });
  doc.addEventListener('pointerleave', clear);
  host.addEventListener(APPEARANCE_EVENT, clear);
  media.addEventListener('change', clear);
  const observer = new MutationObserver(clear);
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-reduce-motion', 'data-material', 'data-glass-motion', 'data-glass-quality'] });
  return () => {
    clear(); observer.disconnect();
    doc.removeEventListener('pointermove', move); doc.removeEventListener('pointerleave', clear);
    host.removeEventListener(APPEARANCE_EVENT, clear); media.removeEventListener('change', clear);
  };
}
