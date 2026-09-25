export interface MediaTrack {
  label: string; lang?: string; title?: string; codec?: string; channels?: string;
  source?: 'embedded' | 'external'; associated?: boolean; isDefault?: boolean;
}
export interface AudioTrack extends MediaTrack { index: number }
export interface SubtitleTrack extends MediaTrack { key: string; source: 'embedded' | 'external' }
export interface PlayerPreferences {
  audioLanguage: string; subtitleLanguage: string; subtitleMode: 'off' | 'auto' | 'on';
  subtitleSize: number; subtitleColor: string; subtitleBackground: 'dark' | 'none'; subtitleDelay: number;
}
export interface FileTrackChoice { audio?: string; subtitle?: string; at: number }
const aliases: Record<string, string> = { rus: 'ru', eng: 'en', ukr: 'uk', bel: 'be', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh',
  fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', pol: 'pl', tur: 'tr', ara: 'ar', hin: 'hi' };
export function trackLanguage(value: unknown): string {
  if (typeof value !== 'string') return '';
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  if (['und', 'unknown', 'mul', 'zxx'].includes(primary)) return '';
  return aliases[primary] || (/^[a-z]{2,3}$/.test(primary) ? primary : '');
}
function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
export function normalizePlayerPreferences(raw: unknown): PlayerPreferences {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<PlayerPreferences>;
  return { audioLanguage: trackLanguage(p.audioLanguage), subtitleLanguage: trackLanguage(p.subtitleLanguage),
    subtitleMode: p.subtitleMode === 'auto' || p.subtitleMode === 'on' ? p.subtitleMode : 'off',
    subtitleSize: bounded(p.subtitleSize, 100, 60, 200),
    subtitleColor: typeof p.subtitleColor === 'string' && /^#[a-f0-9]{6}$/i.test(p.subtitleColor) ? p.subtitleColor : '#ffffff',
    subtitleBackground: p.subtitleBackground === 'none' ? 'none' : 'dark', subtitleDelay: bounded(p.subtitleDelay, 0, -60, 60) };
}
/** An ordinal is not an identity: reordered streams must still match by content metadata. */
export function trackIdentity(track: MediaTrack): string {
  const clean = (v?: string) => (v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return JSON.stringify([trackLanguage(track.lang), clean(track.title || track.label), clean(track.codec), clean(track.channels), track.source || 'audio']);
}
export function matchTrack<T extends MediaTrack>(tracks: T[], identity: string): T | null {
  const matches = tracks.filter(track => trackIdentity(track) === identity);
  return matches.length === 1 ? matches[0] : null;
}
function byLanguage<T extends MediaTrack>(tracks: T[], lang: string): T | null {
  if (!lang) return null;
  const matches = tracks.filter(track => trackLanguage(track.lang) === lang && track.associated !== false);
  const defaults = matches.filter(track => track.isDefault);
  const candidates = defaults.length === 1 ? defaults : matches;
  if (candidates.length === 1) return candidates[0];
  // Two equally described streams need a manual choice; never guess by index.
  const sorted = candidates.slice().sort((a, b) => trackIdentity(a).localeCompare(trackIdentity(b)));
  return sorted.length > 1 && trackIdentity(sorted[0]) !== trackIdentity(sorted[1]) ? sorted[0] : null;
}
export function preferredAudio(tracks: AudioTrack[], prefs: PlayerPreferences, saved?: FileTrackChoice): AudioTrack | null {
  if (saved?.audio === 'default') return null;
  if (saved?.audio) return matchTrack(tracks, saved.audio);
  return byLanguage(tracks, prefs.audioLanguage);
}
export function effectiveAudioLanguage(tracks: AudioTrack[], selected: number | null): string {
  if (selected !== null) return trackLanguage(tracks.find(track => track.index === selected)?.lang);
  const defaults = tracks.filter(track => track.isDefault);
  if (defaults.length === 1) return trackLanguage(defaults[0].lang);
  const languages = tracks.map(track => trackLanguage(track.lang));
  return languages.length && languages[0] && languages.every(lang => lang === languages[0]) ? languages[0] : '';
}
export function preferredSubtitle(tracks: SubtitleTrack[], prefs: PlayerPreferences, audioLanguage: string, saved?: FileTrackChoice): SubtitleTrack | null {
  if (saved?.subtitle === 'off') return null;
  if (saved?.subtitle) return matchTrack(tracks, saved.subtitle);
  if (prefs.subtitleMode === 'off') return null;
  if (prefs.subtitleMode === 'auto' && (!audioLanguage || !prefs.subtitleLanguage || trackLanguage(audioLanguage) === prefs.subtitleLanguage)) return null;
  if (prefs.subtitleLanguage) return byLanguage(tracks, prefs.subtitleLanguage);
  if (prefs.subtitleMode !== 'on') return null;
  const known = tracks.filter(track => trackLanguage(track.lang) && track.associated !== false);
  return known.length === 1 ? known[0] : null;
}
export function playerFileKey(base: string, path: string): string { return JSON.stringify([base, path.replace(/\\/g, '/')]); }

/** Recompute from the original cue times, including when a transcode starts partway through a file. */
export function shiftSubtitleCues(cues: ArrayLike<{ startTime: number; endTime: number }>, shift: number,
  originals: WeakMap<object, { start: number; end: number }>): void {
  if (!Number.isFinite(shift)) return;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (!originals.has(cue)) originals.set(cue, { start: cue.startTime, end: cue.endTime });
    const original = originals.get(cue)!;
    cue.startTime = Math.max(0, original.start + shift);
    cue.endTime = Math.max(0, original.end + shift);
  }
}
interface TimedCue { startTime: number; endTime: number }
interface TimedTrack { cues: ArrayLike<TimedCue> | null; addCue(cue: TimedCue): void; removeCue(cue: TimedCue): void }
export function retimeSubtitleTrack(track: TimedTrack, shift: number, originals: WeakMap<object, { start: number; end: number }>,
  suppressed: WeakMap<object, Set<TimedCue>>): void {
  if (!Number.isFinite(shift) || !track.cues) return;
  let hidden = suppressed.get(track);
  if (!hidden) { hidden = new Set(); suppressed.set(track, hidden); }
  const present = new Set(Array.from(track.cues));
  const all = new Set([...present, ...hidden]);
  for (const cue of all) {
    shiftSubtitleCues([cue], shift, originals);
    if (originals.get(cue)!.end + shift <= 0) {
      if (present.has(cue)) track.removeCue(cue);
      hidden.add(cue);
    } else if (hidden.delete(cue)) track.addCue(cue);
  }
}
