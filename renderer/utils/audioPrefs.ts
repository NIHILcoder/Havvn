/**
 * Audio preferences for the room's music player — equaliser, loudness, queue
 * behaviour, output device, and whether a track opens in its own window.
 *
 * Persisted in localStorage as ONE object under a single key: these are settings a
 * listener tunes once and expects to find again, on the next track and the next
 * session, and they are worthless individually.
 *
 * Everything here is pure and DOM-free (the store access is wrapped and falls back
 * to defaults), so the clamping rules can be tested without a browser. The WebAudio
 * graph that consumes them lives in RoomPlayer; this module never touches it.
 */

export type RepeatMode = 'off' | 'one' | 'all';

export interface AudioPrefs {
  /** Equaliser master switch. Off leaves the bands untouched, not reset. */
  eqOn: boolean;
  /** Pre-gain in dB, applied before the bands. */
  preamp: number;
  /** Per-band gain in dB, one per EQ_FREQS entry. */
  bands: number[];
  /** Even out quiet and loud passages (a compressor, not a limiter). */
  normalize: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  /** Open audio and video in their own window instead of on the room's stage. */
  detachOnOpen: boolean;
  /** Output device id for setSinkId; '' means the system default. */
  sinkId: string;
}

/** Band centres. Five is the most a 300px popover can show honestly. */
export const EQ_FREQS: readonly number[] = [60, 230, 910, 3600, 14000];

/** The range a listener can move a band, in dB, in either direction. */
export const EQ_LIMIT = 12;

/** Named curves. `flat` is the identity and is what "off" looks like. */
export const EQ_PRESETS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  flat: Object.freeze([0, 0, 0, 0, 0]),
  bass: Object.freeze([7, 4, 0, -1, -1]),
  vocal: Object.freeze([-3, -1, 3, 4, 1]),
  rock: Object.freeze([4, 2, -2, 3, 4]),
  electronic: Object.freeze([6, 2, -2, 2, 5]),
});

export const DEFAULT_AUDIO_PREFS: Readonly<AudioPrefs> = Object.freeze({
  eqOn: false,
  preamp: 0,
  bands: Object.freeze([0, 0, 0, 0, 0]) as unknown as number[],
  normalize: false,
  repeat: 'off' as RepeatMode,
  shuffle: false,
  detachOnOpen: true,
  sinkId: '',
});

const STORE_KEY = 'havvn.audioPrefs';

const clampDb = (v: unknown): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.max(-EQ_LIMIT, Math.min(EQ_LIMIT, Math.round(n * 10) / 10));
};

/**
 * Coerce anything (old shapes, hand-edited storage, a truncated write) into a
 * usable set. Never throws and never returns a partial object: a missing field is
 * the default, an out-of-range one is clamped, and a bands array of the wrong
 * length is padded or trimmed to match EQ_FREQS.
 */
export function normalizeAudioPrefs(raw: unknown): AudioPrefs {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<AudioPrefs>;
  const bandsIn = Array.isArray(p.bands) ? p.bands : [];
  const bands = EQ_FREQS.map((_, i) => clampDb(bandsIn[i]));
  const repeat: RepeatMode = p.repeat === 'one' || p.repeat === 'all' ? p.repeat : 'off';
  return {
    eqOn: p.eqOn === true,
    preamp: clampDb(p.preamp),
    bands,
    normalize: p.normalize === true,
    repeat,
    shuffle: p.shuffle === true,
    // The one default that is ON: a player in its own window is the point of the
    // feature, and the toggle is right there for anyone who wants it inline.
    detachOnOpen: p.detachOnOpen !== false,
    sinkId: typeof p.sinkId === 'string' ? p.sinkId : '',
  };
}

export function loadAudioPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return normalizeAudioPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeAudioPrefs(null);
  }
}

export function saveAudioPrefs(prefs: AudioPrefs): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(normalizeAudioPrefs(prefs)));
  } catch { /* a full or disabled store must never break playback */ }
}

/** The preset these bands match exactly, or null for a hand-tuned curve. */
export function presetFor(bands: readonly number[]): string | null {
  for (const [name, curve] of Object.entries(EQ_PRESETS)) {
    if (curve.length === bands.length && curve.every((v, i) => v === bands[i])) return name;
  }
  return null;
}

/** dB → linear gain, for a GainNode. */
export function gainFromDb(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * The next track for a queue, honouring repeat and shuffle. Returns the index to
 * play, or null when playback should stop.
 *
 * `repeat: 'one'` is deliberately NOT handled here — it never changes track, so the
 * caller seeks to zero instead of re-selecting, which keeps the sync broadcast (a
 * 'track' message) out of a loop that is not a track change.
 */
export function nextIndex(
  current: number,
  count: number,
  prefs: Pick<AudioPrefs, 'repeat' | 'shuffle'>,
  rand: () => number = Math.random,
): number | null {
  if (count <= 0) return null;
  if (count === 1) return prefs.repeat === 'all' ? 0 : null;
  if (prefs.shuffle) {
    // Never pick the track that is already playing: "shuffle" that repeats a song
    // back to back reads as a bug, however fair the coin was.
    const pick = Math.floor(rand() * (count - 1));
    return pick >= current ? pick + 1 : pick;
  }
  const next = current + 1;
  if (next < count) return next;
  return prefs.repeat === 'all' ? 0 : null;
}
