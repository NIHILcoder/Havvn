/**
 * Hotkeys — single source of truth for keyboard shortcuts.
 *
 * The editor (components/HotkeySettings.tsx) and the global keydown handler in
 * App.tsx both read from here. Bindings persist in localStorage under
 * 'hotkeys'; saves dispatch a window event so App picks up edits live without
 * a restart. Keys are stored as event.code values (KeyD, Comma, …) plus the
 * modifier names Ctrl/Shift/Alt/Meta — layout-independent by design.
 */

export interface Hotkey {
  id: string;
  /** English fallback only — the editor localizes known ids via t(). */
  label: string;
  description: string;
  keys: string[];
  category: string;
}

export const HOTKEYS_STORAGE_KEY = 'hotkeys';
export const HOTKEYS_CHANGED_EVENT = 'havvn:hotkeys-changed';

/**
 * Every id here must have a real implementation in App.tsx's global keydown
 * handler — never add a binding without wiring its action.
 */
export const defaultHotkeys: Hotkey[] = [
  {
    id: 'open-downloads',
    label: 'Open Downloads',
    description: 'Switch to the downloads page',
    keys: ['Ctrl', 'KeyD'],
    category: 'Navigation',
  },
  {
    id: 'open-settings',
    label: 'Open Settings',
    description: 'Open the settings page',
    keys: ['Ctrl', 'Comma'],
    category: 'Navigation',
  },
  {
    id: 'add-torrent',
    label: 'Add Torrent',
    description: 'Open the add torrent dialog',
    keys: ['Ctrl', 'KeyO'],
    category: 'Torrents',
  },
  {
    id: 'create-torrent',
    label: 'Create Torrent',
    description: 'Navigate to torrent creation',
    keys: ['Ctrl', 'KeyN'],
    category: 'Torrents',
  },
  {
    id: 'pause-all',
    label: 'Pause All',
    description: 'Pause all active downloads',
    keys: ['Ctrl', 'Shift', 'KeyP'],
    category: 'Torrents',
  },
  {
    id: 'resume-all',
    label: 'Resume All',
    description: 'Resume all paused downloads',
    keys: ['Ctrl', 'Shift', 'KeyR'],
    category: 'Torrents',
  },
  {
    id: 'voice-mute',
    label: 'Toggle Microphone',
    description: 'Mute or unmute your mic in the active voice call',
    keys: ['Ctrl', 'Shift', 'KeyM'],
    category: 'Voice',
  },
  {
    id: 'voice-deafen',
    label: 'Toggle Deafen',
    description: 'Silence or restore all voice audio in the active call',
    keys: ['Ctrl', 'Shift', 'KeyD'],
    category: 'Voice',
  },
];

const cloneDefaults = (): Hotkey[] => defaultHotkeys.map((h) => ({ ...h, keys: [...h.keys] }));

/**
 * Load bindings from localStorage, validated against the defaults: unknown ids
 * are dropped, missing ids fall back to their default keys, malformed storage
 * is ignored entirely. Always returns the full set of known hotkeys.
 */
export function loadHotkeys(): Hotkey[] {
  try {
    const raw = localStorage.getItem(HOTKEYS_STORAGE_KEY);
    if (!raw) return cloneDefaults();
    const parsed: unknown = JSON.parse(raw);
    const overrides = new Map<string, string[]>();
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (
          entry && typeof entry === 'object' &&
          typeof (entry as { id?: unknown }).id === 'string' &&
          Array.isArray((entry as { keys?: unknown }).keys) &&
          ((entry as { keys: unknown[] }).keys).every((k) => typeof k === 'string')
        ) {
          overrides.set((entry as { id: string }).id, (entry as { keys: string[] }).keys);
        }
      }
    }
    return defaultHotkeys.map((h) => {
      const keys = overrides.get(h.id);
      return { ...h, keys: keys ? [...keys] : [...h.keys] };
    });
  } catch {
    return cloneDefaults();
  }
}

/** Persist bindings (id + keys only) and notify live listeners (App.tsx). */
export function saveHotkeys(hotkeys: Hotkey[]): void {
  try {
    localStorage.setItem(
      HOTKEYS_STORAGE_KEY,
      JSON.stringify(hotkeys.map(({ id, keys }) => ({ id, keys }))),
    );
  } catch { /* storage full/unavailable — the in-memory state still works */ }
  window.dispatchEvent(new Event(HOTKEYS_CHANGED_EVENT));
}

/** Drop all custom bindings and notify listeners. Returns fresh defaults. */
export function resetHotkeys(): Hotkey[] {
  try {
    localStorage.removeItem(HOTKEYS_STORAGE_KEY);
  } catch { /* ignore */ }
  window.dispatchEvent(new Event(HOTKEYS_CHANGED_EVENT));
  return cloneDefaults();
}

/** Subscribe to hotkey edits (fires after every save/reset). Returns unsubscribe. */
export function subscribeHotkeys(listener: () => void): () => void {
  window.addEventListener(HOTKEYS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(HOTKEYS_CHANGED_EVENT, listener);
}
