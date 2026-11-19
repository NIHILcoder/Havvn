export const SCREEN_SHARE_HEIGHTS = [480, 720, 1080, 1440, 2160] as const;
export const SCREEN_SHARE_FPS = [15, 30, 60] as const;

export interface ScreenShareSettings {
  height: typeof SCREEN_SHARE_HEIGHTS[number];
  fps: typeof SCREEN_SHARE_FPS[number];
  /** Per-viewer ceiling in decimal kbit/s; 0 follows the room resource limit. */
  bitrateKbps: number;
}

export const DEFAULT_SCREEN_SHARE: Readonly<ScreenShareSettings> = Object.freeze({
  height: 1080, fps: 30, bitrateKbps: 0,
});
export const SCREEN_SHARE_PRESETS = {
  text: { height: 1080, fps: 15, bitrateKbps: 4000 },
  video: { height: 720, fps: 60, bitrateKbps: 5000 },
  economy: { height: 480, fps: 15, bitrateKbps: 750 },
} as const satisfies Record<string, ScreenShareSettings>;
export type ScreenSharePreset = keyof typeof SCREEN_SHARE_PRESETS;
export function matchingScreenSharePreset(settings: ScreenShareSettings): ScreenSharePreset | 'manual' {
  return (Object.keys(SCREEN_SHARE_PRESETS) as ScreenSharePreset[]).find(id => {
    const p = SCREEN_SHARE_PRESETS[id]; return p.height === settings.height && p.fps === settings.fps && p.bitrateKbps === settings.bitrateKbps;
  }) ?? 'manual';
}

/** Validate renderer/IPC input without coercing strings, nulls or unbounded rates. */
export function validateScreenShareSettings(value?: unknown): ScreenShareSettings {
  if (value === undefined) return { ...DEFAULT_SCREEN_SHARE };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid screen share settings');
  const p = { ...DEFAULT_SCREEN_SHARE, ...value } as ScreenShareSettings;
  if (!SCREEN_SHARE_HEIGHTS.includes(p.height) || !SCREEN_SHARE_FPS.includes(p.fps)
      || !Number.isInteger(p.bitrateKbps) || (p.bitrateKbps !== 0 && (p.bitrateKbps < 250 || p.bitrateKbps > 20_000))) {
    throw new Error('Invalid screen share settings');
  }
  return { height: p.height, fps: p.fps, bitrateKbps: p.bitrateKbps };
}

export function effectiveScreenBitrate(settings: ScreenShareSettings, roomLimitKbps: number): number {
  return settings.bitrateKbps ? Math.min(settings.bitrateKbps, roomLimitKbps) : roomLimitKbps;
}

/** Capture ceilings preserve the source aspect ratio and do not require upscaling. */
export function screenCaptureVideo(sourceId: string, settings: ScreenShareSettings) {
  return { mandatory: {
    chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId,
    maxWidth: Math.round(settings.height * 16 / 18) * 2,
    maxHeight: settings.height, maxFrameRate: settings.fps,
  } };
}
