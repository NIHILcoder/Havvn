import { describe, it, expect } from 'vitest';
import { composeUploadLimits, UploadLimitInput } from './upload-limits';

const noCap = -1; // the AdaptiveThrottle UNLIMITED sentinel
const kb = (n: number) => n * 1024;

const input = (p: Partial<UploadLimitInput> = {}): UploadLimitInput => ({
  maxUpKbps: 0,
  altUpKbps: 0,
  adaptiveUpBytes: noCap,
  ...p,
});

describe('composeUploadLimits', () => {
  it('leaves the limiter off and writes no ceiling when nothing caps upload', () => {
    const args = composeUploadLimits(input());
    expect(args['speed-limit-up-enabled']).toBe(false);
    // Omitted, NOT zeroed — 0 kB/s means "stop" to transmission.
    expect(args).not.toHaveProperty('speed-limit-up');
    expect(args).not.toHaveProperty('alt-speed-up');
  });

  it('passes a manual normal-mode cap straight through', () => {
    const args = composeUploadLimits(input({ maxUpKbps: 500 }));
    expect(args).toMatchObject({ 'speed-limit-up-enabled': true, 'speed-limit-up': 500 });
  });

  it('enables the limiter for an adaptive cap even with NO manual limit', () => {
    // The regression this whole module exists for: the old code derived
    // speed-limit-up-enabled from maxUpKbps > 0, so a user who never set a
    // manual cap had the adaptive ceiling written into a disabled limiter.
    const args = composeUploadLimits(input({ adaptiveUpBytes: kb(300) }));
    expect(args).toMatchObject({ 'speed-limit-up-enabled': true, 'speed-limit-up': 300 });
  });

  it('keeps the manual cap when it is tighter than the adaptive one', () => {
    const args = composeUploadLimits(input({ maxUpKbps: 100, adaptiveUpBytes: kb(400) }));
    expect(args['speed-limit-up']).toBe(100);
  });

  it('keeps the adaptive cap when it is tighter than the manual one', () => {
    const args = composeUploadLimits(input({ maxUpKbps: 900, adaptiveUpBytes: kb(120) }));
    expect(args['speed-limit-up']).toBe(120);
  });

  // ── the zero trap ─────────────────────────────────────────────────────────
  it('never rounds a sub-kB adaptive cap down to 0 (which would mean STOP)', () => {
    const args = composeUploadLimits(input({ adaptiveUpBytes: 100 }));
    expect(args['speed-limit-up']).toBe(1);
    expect(args['speed-limit-up-enabled']).toBe(true);
  });

  it('treats the -1 sentinel as no cap rather than as a ceiling', () => {
    const args = composeUploadLimits(input({ maxUpKbps: 250, adaptiveUpBytes: noCap }));
    expect(args['speed-limit-up']).toBe(250);
  });

  it('treats a 0 adaptive value as "throttle off", never as "stop uploading"', () => {
    const args = composeUploadLimits(input({ adaptiveUpBytes: 0 }));
    expect(args['speed-limit-up-enabled']).toBe(false);
    expect(args).not.toHaveProperty('speed-limit-up');
  });

  // ── the alt knob ──────────────────────────────────────────────────────────
  it('composes the alt ceiling from the alt manual cap, not the normal one', () => {
    const args = composeUploadLimits(input({ maxUpKbps: 900, altUpKbps: 50 }));
    expect(args['speed-limit-up']).toBe(900);
    expect(args['alt-speed-up']).toBe(50);
  });

  it('applies the adaptive cap to the alt knob too', () => {
    // Without this, hitting turbo silently discards bufferbloat protection:
    // alt-speed-up OVERRIDES speed-limit-up inside the daemon.
    const args = composeUploadLimits(input({ altUpKbps: 800, adaptiveUpBytes: kb(90) }));
    expect(args['alt-speed-up']).toBe(90);
  });

  it('lets a tighter manual alt cap win over the adaptive one', () => {
    const args = composeUploadLimits(input({ altUpKbps: 40, adaptiveUpBytes: kb(90) }));
    expect(args['alt-speed-up']).toBe(40);
  });

  it('drives an adaptive cap into BOTH knobs so flipping alt mode has no stale window', () => {
    const args = composeUploadLimits(input({ adaptiveUpBytes: kb(64) }));
    expect(args['speed-limit-up']).toBe(64);
    expect(args['alt-speed-up']).toBe(64);
  });

  it('does not write an alt ceiling when alt is unlimited and nothing adaptive caps it', () => {
    const args = composeUploadLimits(input({ maxUpKbps: 300 }));
    expect(args).not.toHaveProperty('alt-speed-up');
  });
});
