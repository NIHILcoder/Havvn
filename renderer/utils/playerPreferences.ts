import { normalizePlayerPreferences, type FileTrackChoice, type PlayerPreferences } from '../../shared/player-preferences';
export const PLAYER_PREFS_KEY = 'havvn.player.preferences.v1';
const CHOICES_KEY = 'havvn.player.trackChoices.v1';
export function loadPlayerPreferences(): PlayerPreferences {
  try { return normalizePlayerPreferences(JSON.parse(localStorage.getItem(PLAYER_PREFS_KEY) || 'null')); }
  catch { return normalizePlayerPreferences(null); }
}
export function savePlayerPreferences(prefs: PlayerPreferences): void {
  try { localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify(normalizePlayerPreferences(prefs))); } catch { /* optional storage */ }
}
function choices(): Record<string, FileTrackChoice> {
  try {
    const raw = JSON.parse(localStorage.getItem(CHOICES_KEY) || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, FileTrackChoice] => {
      const p = entry[1] as FileTrackChoice;
      return !!p && Number.isFinite(p.at) && (p.audio === undefined || typeof p.audio === 'string') && (p.subtitle === undefined || typeof p.subtitle === 'string');
    }));
  } catch { return {}; }
}
export function loadFileTrackChoice(key: string): FileTrackChoice | undefined { return choices()[key]; }
export function saveFileTrackChoice(key: string, value: Pick<FileTrackChoice, 'audio'> | Pick<FileTrackChoice, 'subtitle'>): void {
  try {
    const map = choices(); map[key] = { ...map[key], ...value, at: Date.now() };
    const sorted = Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, 200);
    localStorage.setItem(CHOICES_KEY, JSON.stringify(Object.fromEntries(sorted)));
  } catch { /* optional storage */ }
}
export function clearFileTrackChoice(key: string): void {
  try { const map = choices(); delete map[key]; localStorage.setItem(CHOICES_KEY, JSON.stringify(map)); } catch { /* optional storage */ }
}
