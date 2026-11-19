import { describe, expect, it } from 'vitest';
import { DEFAULT_SCREEN_SHARE, SCREEN_SHARE_PRESETS, matchingScreenSharePreset, effectiveScreenBitrate, screenCaptureVideo, validateScreenShareSettings } from './screen-share';

describe('screen share settings', () => {
  it('keeps every preset valid, recognizes manual changes and honors the room limit', () => {
    for (const key of Object.keys(SCREEN_SHARE_PRESETS) as Array<keyof typeof SCREEN_SHARE_PRESETS>) {
      const settings = SCREEN_SHARE_PRESETS[key];
      expect(validateScreenShareSettings(settings)).toEqual(settings);
      expect(matchingScreenSharePreset(settings)).toBe(key);
      expect(effectiveScreenBitrate(settings, 500)).toBe(500);
      expect(Object.keys(settings).sort()).toEqual(['bitrateKbps', 'fps', 'height']);
    }
    expect(matchingScreenSharePreset({ height: 1440, fps: 30, bitrateKbps: 9000 })).toBe('manual');
  });
  it('keeps legacy callers working and uses bounded defaults', () => {
    expect(validateScreenShareSettings()).toEqual(DEFAULT_SCREEN_SHARE);
    expect(validateScreenShareSettings({ fps: 60 })).toEqual({ ...DEFAULT_SCREEN_SHARE, fps: 60 });
  });

  it.each([null, [], '1080p', { height: 100_000 }, { fps: 120 }, { fps: '60' },
    { bitrateKbps: -1 }, { bitrateKbps: 249 }, { bitrateKbps: 20_001 },
    { bitrateKbps: NaN }, { bitrateKbps: Infinity }, { bitrateKbps: 1000.5 }])('rejects invalid IPC options %j', value => {
    expect(() => validateScreenShareSettings(value)).toThrow('Invalid screen share settings');
  });

  it('applies the selected capture resolution and frame rate without minimum constraints', () => {
    const settings = validateScreenShareSettings({ height: 1440, fps: 60, bitrateKbps: 8000 });
    expect(screenCaptureVideo('window:12:0', settings)).toEqual({ mandatory: {
      chromeMediaSource: 'desktop', chromeMediaSourceId: 'window:12:0',
      maxWidth: 2560, maxHeight: 1440, maxFrameRate: 60,
    } });
    expect(screenCaptureVideo('screen:0:0', { ...settings, height: 480 }).mandatory.maxWidth).toBe(854);
  });

  it('honors the room ceiling even when the requested share bitrate is higher', () => {
    expect(effectiveScreenBitrate(DEFAULT_SCREEN_SHARE, 2500)).toBe(2500);
    expect(effectiveScreenBitrate({ ...DEFAULT_SCREEN_SHARE, bitrateKbps: 8000 }, 2500)).toBe(2500);
    expect(effectiveScreenBitrate({ ...DEFAULT_SCREEN_SHARE, bitrateKbps: 1000 }, 8000)).toBe(1000);
  });
});
