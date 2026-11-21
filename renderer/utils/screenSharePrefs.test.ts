import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SCREEN_SHARE } from '../../shared/screen-share';
import { loadManualScreenSharePrefs, loadScreenSharePrefs, saveScreenSharePrefs } from './screenSharePrefs';

afterEach(() => vi.unstubAllGlobals());

it('retains manual quality separately from a preset and validates old or corrupt manual values', () => {
  let saved = '';
  vi.stubGlobal('localStorage', { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } });
  const preset = { height: 720, fps: 60, bitrateKbps: 5000 } as const;
  const manual = { height: 1440, fps: 30, bitrateKbps: 9000 } as const;
  saveScreenSharePrefs(preset, manual);
  expect(loadScreenSharePrefs()).toEqual(preset);
  expect(loadManualScreenSharePrefs(preset)).toEqual(manual);
  saved = JSON.stringify({ ...preset, manual: { fps: 10000 } });
  expect(loadManualScreenSharePrefs(manual)).toEqual(manual);
  saved = JSON.stringify(preset);
  expect(loadManualScreenSharePrefs(manual)).toEqual(manual);
});

it('loads safe defaults when saved data is corrupt or storage is unavailable', () => {
  for (const raw of ['{', 'null', '{"fps":300}']) {
    vi.stubGlobal('localStorage', { getItem: () => raw });
    expect(loadScreenSharePrefs()).toEqual(DEFAULT_SCREEN_SHARE);
  }
  vi.stubGlobal('localStorage', { getItem: () => { throw Error('unavailable'); } });
  expect(loadScreenSharePrefs()).toEqual(DEFAULT_SCREEN_SHARE);
});

it('remembers quality without persisting a system audio grant', () => {
  let saved = '';
  vi.stubGlobal('localStorage', { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } });
  saveScreenSharePrefs({ height: 720, fps: 60, bitrateKbps: 5000 });
  expect(loadScreenSharePrefs()).toEqual({ height: 720, fps: 60, bitrateKbps: 5000 });
  expect(Object.keys(JSON.parse(saved))).toEqual(['height', 'fps', 'bitrateKbps']);
});
