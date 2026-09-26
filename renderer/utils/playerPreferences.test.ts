import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizePlayerPreferences } from '../../shared/player-preferences';
import { loadPlayerPreferences, savePlayerPreferences, loadFileTrackChoice, saveFileTrackChoice, clearFileTrackChoice, PLAYER_PREFS_KEY } from './playerPreferences';
let map: Map<string, string>;
beforeEach(() => {
  map = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => map.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());
it('recovers from corrupt storage and persists settings independently of file choices', () => {
  map.set(PLAYER_PREFS_KEY, '{broken');
  expect(loadPlayerPreferences()).toEqual(normalizePlayerPreferences(null));
  savePlayerPreferences(normalizePlayerPreferences({ audioLanguage: 'ru', subtitleDelay: 0.5 }));
  saveFileTrackChoice('hash:path', { audio: 'choice' });
  saveFileTrackChoice('hash:path', { subtitle: 'off' });
  expect(loadPlayerPreferences().audioLanguage).toBe('ru');
  expect(loadFileTrackChoice('hash:path')).toMatchObject({ audio: 'choice', subtitle: 'off' });
  clearFileTrackChoice('hash:path');
  expect(loadFileTrackChoice('hash:path')).toBeUndefined();
  expect(loadPlayerPreferences().audioLanguage).toBe('ru');
});
it('bounds the file store and tolerates unavailable storage', () => {
  for (let i = 0; i < 220; i++) { vi.spyOn(Date, 'now').mockReturnValue(i); saveFileTrackChoice('file:' + i, { subtitle: 'off' }); }
  vi.restoreAllMocks();
  expect(loadFileTrackChoice('file:0')).toBeUndefined();
  expect(loadFileTrackChoice('file:219')?.subtitle).toBe('off');
  vi.stubGlobal('localStorage', { getItem: () => { throw Error('disabled'); }, setItem: () => { throw Error('quota'); } });
  expect(() => savePlayerPreferences(normalizePlayerPreferences(null))).not.toThrow();
  expect(loadFileTrackChoice('file:219')).toBeUndefined();
});
