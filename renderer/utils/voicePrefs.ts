/**
 * Voice preferences — per-install (localStorage), shared by the voice panel and
 * the voice settings modal. The renderer is the source of truth; the hardware/
 * processing subset (VoiceSettings) is pushed to the engine window on every
 * change, and the manager re-asserts it after an engine respawn.
 */
import type { VoiceInputMode, VoiceSettings, NoiseSuppressionMode } from '../../shared/types';

export type VoicePrefs = {
  inputMode: VoiceInputMode;
  pttKey: string;            // KeyboardEvent.code of the push-to-talk key
  globalPtt: boolean;        // OS-level PTT hook (works while the app is unfocused)
  chimes: boolean;           // play join/leave chimes
  inputDeviceId: string | null;   // engine-window deviceId (null = system default)
  outputDeviceId: string | null;
  inputGain: number;         // 0..2 (1 = unity)
  masterVolume: number;      // 0..1
  vadThreshold: number;      // 1..128 (0-255 avg magnitude scale)
  echoCancellation: boolean;
  noiseSuppressionMode: NoiseSuppressionMode; // off / standard (browser) / enhanced (RNNoise)
  autoGainControl: boolean;
};

export const VOICE_PREFS_KEY = 'voicePrefs';
export const VOICE_PREFS_EVENT = 'havvn:voice-prefs-changed';

const clamp = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};

export function loadVoicePrefs(): VoicePrefs {
  let p: Record<string, unknown> = {};
  try { p = JSON.parse(localStorage.getItem(VOICE_PREFS_KEY) || '{}'); } catch { /* defaults below */ }
  const inputMode: VoiceInputMode = p.inputMode === 'vad' || p.inputMode === 'ptt' ? p.inputMode : 'always';
  return {
    inputMode,
    pttKey: typeof p.pttKey === 'string' && p.pttKey ? p.pttKey : 'Backquote',
    globalPtt: p.globalPtt === true,
    chimes: p.chimes !== false,
    inputDeviceId: typeof p.inputDeviceId === 'string' && p.inputDeviceId ? p.inputDeviceId : null,
    outputDeviceId: typeof p.outputDeviceId === 'string' && p.outputDeviceId ? p.outputDeviceId : null,
    inputGain: clamp(p.inputGain, 0, 2, 1),
    masterVolume: clamp(p.masterVolume, 0, 1, 1),
    vadThreshold: clamp(p.vadThreshold, 1, 128, 14),
    echoCancellation: p.echoCancellation !== false,
    noiseSuppressionMode: loadNsMode(p),
    autoGainControl: p.autoGainControl !== false,
  };
}

/** Read the NS mode, migrating the pre-2.20 boolean `noiseSuppression`: true → the new
 *  default 'enhanced' (an upgrade to RNNoise), false → 'off'. Absent → 'enhanced'. */
function loadNsMode(p: Record<string, unknown>): NoiseSuppressionMode {
  const m = p.noiseSuppressionMode;
  if (m === 'off' || m === 'standard' || m === 'enhanced') return m;
  if (typeof p.noiseSuppression === 'boolean') return p.noiseSuppression ? 'enhanced' : 'off';
  return 'enhanced';
}

export function saveVoicePrefs(p: VoicePrefs): void {
  try { localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
  window.dispatchEvent(new Event(VOICE_PREFS_EVENT));
}

/** The engine-side subset of the prefs (what the capture/playback pipeline needs). */
export function toVoiceSettings(p: VoicePrefs): VoiceSettings {
  return {
    inputDeviceId: p.inputDeviceId,
    outputDeviceId: p.outputDeviceId,
    inputGain: p.inputGain,
    masterVolume: p.masterVolume,
    vadThreshold: p.vadThreshold,
    echoCancellation: p.echoCancellation,
    noiseSuppressionMode: p.noiseSuppressionMode,
    autoGainControl: p.autoGainControl,
  };
}

// ── Per-peer voice adjustments ────────────────────────────────────────────
// Volume (0..100) and a local voice-mute per member, keyed by memberId.
// Deliberately OUTSIDE VoicePrefs: that object is pushed to the engine on every
// change (debounced), and per-peer tweaks must not re-trigger the capture
// pipeline. Applied by the voice panel via voice.volume() when a participant
// appears. Capped so a long life of rooms can't grow the map unboundedly.
export type PeerVoicePref = { volume: number; muted: boolean };

const PEER_PREFS_KEY = 'voicePeerPrefs';
const PEER_PREFS_MAX = 200;

export function loadPeerVoicePrefs(): Record<string, PeerVoicePref> {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(PEER_PREFS_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
  } catch { /* empty */ }
  const out: Record<string, PeerVoicePref> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    out[id] = { volume: clamp(o.volume, 0, 100, 100), muted: o.muted === true };
  }
  return out;
}

export function savePeerVoicePref(memberId: string, pref: PeerVoicePref): void {
  const all = loadPeerVoicePrefs();
  // A default entry (full volume, unmuted) carries no information — drop it.
  if (pref.volume === 100 && !pref.muted) delete all[memberId];
  else all[memberId] = { volume: clamp(pref.volume, 0, 100, 100), muted: pref.muted };
  const ids = Object.keys(all);
  if (ids.length > PEER_PREFS_MAX) for (const id of ids.slice(0, ids.length - PEER_PREFS_MAX)) delete all[id];
  try { localStorage.setItem(PEER_PREFS_KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

/** The gain the engine should apply for a peer (0..1), mute folded in. */
export function effectivePeerGain(pref: PeerVoicePref | undefined): number {
  if (!pref) return 1;
  return pref.muted ? 0 : pref.volume / 100;
}

export const KEY_LABELS: Record<string, string> = {
  Backquote: '`', Space: 'Space', Enter: 'Enter', Tab: 'Tab', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift',
  ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', AltRight: 'R-Alt', CapsLock: 'Caps',
};
export const keyLabel = (code: string): string => KEY_LABELS[code] || code.replace(/^Key|^Digit/, '');
