/**
 * Voice preferences — per-install (localStorage), shared by the voice panel and
 * the voice settings modal. The renderer is the source of truth; the hardware/
 * processing subset (VoiceSettings) is pushed to the engine window on every
 * change, and the manager re-asserts it after an engine respawn.
 */
import type { VoiceInputMode, VoiceSettings } from '../../shared/types';

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
  noiseSuppression: boolean;
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
    noiseSuppression: p.noiseSuppression !== false,
    autoGainControl: p.autoGainControl !== false,
  };
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
    noiseSuppression: p.noiseSuppression,
    autoGainControl: p.autoGainControl,
  };
}

export const KEY_LABELS: Record<string, string> = {
  Backquote: '`', Space: 'Space', Enter: 'Enter', Tab: 'Tab', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift',
  ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', AltRight: 'R-Alt', CapsLock: 'Caps',
};
export const keyLabel = (code: string): string => KEY_LABELS[code] || code.replace(/^Key|^Digit/, '');
