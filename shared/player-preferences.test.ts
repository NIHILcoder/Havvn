import { expect, it } from 'vitest';
import { normalizePlayerPreferences, preferredAudio, preferredSubtitle, effectiveAudioLanguage, trackIdentity, matchTrack, trackLanguage, playerFileKey, shiftSubtitleCues, retimeSubtitleTrack } from './player-preferences';

it('normalizes ISO aliases and guards corrupt preferences', () => {
  expect(['rus', 'eng', 'pt-BR', 'und', 'zxx'].map(trackLanguage)).toEqual(['ru', 'en', 'pt', '', '']);
  expect(normalizePlayerPreferences({ audioLanguage: 'RUS', subtitleDelay: Infinity, subtitleSize: 1000, subtitleColor: 'red;display:none', subtitleMode: 'bad' })).toMatchObject({ audioLanguage: 'ru', subtitleDelay: 0, subtitleSize: 200, subtitleColor: '#ffffff', subtitleMode: 'off' });
  expect(normalizePlayerPreferences(null).subtitleMode).toBe('off');
});
it('matches by description after indices reorder without carrying a number to another file', () => {
  const first = { index: 1, label: 'Dub', lang: 'rus', codec: 'aac', channels: 'stereo' };
  const reordered = { ...first, index: 0 };
  const english = { index: 1, label: 'Original', lang: 'eng' };
  const prefs = normalizePlayerPreferences({ audioLanguage: 'ru' });
  expect(preferredAudio([english, reordered], prefs)?.index).toBe(0);
  expect(preferredAudio([english, reordered], prefs, { audio: trackIdentity(first), at: 1 })?.index).toBe(0);
  expect(preferredAudio([english], prefs, { audio: trackIdentity(first), at: 1 })).toBeNull();
  expect(preferredAudio([reordered], prefs, { audio: 'default', at: 1 })).toBeNull();
});
it('leaves unknown and ambiguous languages manual and honors container defaults', () => {
  const unknown = { index: 0, label: 'Track', lang: 'und' };
  const ru = { index: 1, label: 'Russian', lang: 'rus' };
  const prefs = normalizePlayerPreferences({ audioLanguage: 'ru' });
  expect(preferredAudio([unknown], prefs)).toBeNull();
  expect(preferredAudio([ru, { ...ru, index: 2 }], prefs)).toBeNull();
  expect(matchTrack([ru, { ...ru, index: 2 }], trackIdentity(ru))).toBeNull();
  expect(preferredAudio([ru, { ...ru, index: 2, isDefault: true }], prefs)?.index).toBe(2);
});
it('applies off/auto/on modes and gives a file-specific manual choice precedence', () => {
  const ru = { key: 'embedded:0', label: 'Russian', lang: 'rus', source: 'embedded' as const };
  const unknown = { key: 'embedded:1', label: 'Unknown', source: 'embedded' as const };
  const prefs = normalizePlayerPreferences({ subtitleLanguage: 'ru', subtitleMode: 'auto' });
  expect(preferredSubtitle([ru], prefs, 'en')).toEqual(ru);
  expect(preferredSubtitle([ru], prefs, 'rus')).toBeNull();
  expect(preferredSubtitle([ru], prefs, '')).toBeNull();
  expect(preferredSubtitle([unknown], { ...prefs, subtitleMode: 'on' }, 'en')).toBeNull();
  expect(preferredSubtitle([ru], prefs, 'en', { subtitle: 'off', at: 1 })).toBeNull();
  expect(preferredSubtitle([ru], { ...prefs, subtitleMode: 'off' }, 'ru', { subtitle: trackIdentity(ru), at: 1 })).toEqual(ru);
  expect(preferredSubtitle([{ ...ru, source: 'external', associated: false }], prefs, 'en')).toBeNull();
});
it('keys a file by torrent identity and relative path, including repeated season basenames', () => {
  expect(playerFileKey('hash', 'Season1\\E01.mkv')).toBe(playerFileKey('hash', 'Season1/E01.mkv'));
  expect(playerFileKey('hash', 'Season1/E01.mkv')).not.toBe(playerFileKey('hash', 'Season2/E01.mkv'));
});
it('does not infer the default audio language from an arbitrary first stream', () => {
  const tracks = [{ index: 0, label: 'Dub', lang: 'rus' }, { index: 1, label: 'Original', lang: 'eng' }];
  expect(effectiveAudioLanguage(tracks, null)).toBe('');
  expect(effectiveAudioLanguage(tracks, 0)).toBe('ru');
  expect(effectiveAudioLanguage([{ ...tracks[0], isDefault: true }, { ...tracks[1], isDefault: true }], null)).toBe('');
  expect(effectiveAudioLanguage([tracks[0], { ...tracks[1], isDefault: true }], null)).toBe('en');
});
it('recalculates delay from original cues without accumulating edits and accounts for a stream offset', () => {
  const cues = [{ startTime: 10, endTime: 12 }, { startTime: 30, endTime: 35 }];
  const originals = new WeakMap<object, { start: number; end: number }>();
  shiftSubtitleCues(cues, 2, originals);
  shiftSubtitleCues(cues, -1, originals);
  expect(cues[0]).toEqual({ startTime: 9, endTime: 11 });
  shiftSubtitleCues(cues, 2 - 20, originals);
  expect(cues).toEqual([{ startTime: 0, endTime: 0 }, { startTime: 12, endTime: 17 }]);
  shiftSubtitleCues(cues, 0, originals);
  expect(cues[0]).toEqual({ startTime: 10, endTime: 12 });
});
it('removes expired cues rather than showing a zero-time caption and restores them when delay changes', () => {
  const early = { startTime: 1, endTime: 2 }, later = { startTime: 4, endTime: 6 };
  const track = { cues: [early, later], addCue: (cue: typeof early) => track.cues.push(cue), removeCue: (cue: typeof early) => track.cues.splice(track.cues.indexOf(cue), 1) };
  const originals = new WeakMap<object, { start: number; end: number }>();
  const suppressed = new WeakMap<object, Set<typeof early>>();
  retimeSubtitleTrack(track, -2.5, originals, suppressed);
  expect(track.cues).toEqual([{ startTime: 1.5, endTime: 3.5 }]);
  retimeSubtitleTrack(track, 1 - 2.5, originals, suppressed);
  expect(track.cues).toContain(early);
  expect(early).toEqual({ startTime: 0, endTime: 0.5 });
  retimeSubtitleTrack(track, 0, originals, suppressed);
  expect(early).toEqual({ startTime: 1, endTime: 2 });
  expect(track.cues).toHaveLength(2);
});
