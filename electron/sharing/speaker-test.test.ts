import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeakerTester } from './speaker-test';
const env = { sinks: [] as string[], audio: [] as TestAudio[], contexts: [] as TestContext[], sinkError: false, holdSink: null as null | (() => Promise<void>), mic: vi.fn(), tracks: vi.fn() };
class TestAudio {
  volume = 1; srcObject: unknown = null; pause = vi.fn(); play = vi.fn(async () => {});
  constructor() { env.audio.push(this); }
  async setSinkId(id: string) { env.sinks.push(id); if (env.holdSink) await env.holdSink(); if (env.sinkError) throw Error('device removed'); }
}
class TestContext {
  currentTime = 0; resume = vi.fn(async () => {}); close = vi.fn(async () => {});
  constructor() { env.contexts.push(this); }
  createMediaStreamDestination() { return { stream: { getTracks: () => [{ stop: env.tracks }] } }; }
  createOscillator() { return { frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }; }
  createGain() { return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn() }; }
}
beforeEach(() => {
  vi.useFakeTimers(); env.sinks = []; env.audio = []; env.contexts = []; env.sinkError = false; env.holdSink = null; env.mic.mockClear(); env.tracks.mockClear();
  vi.stubGlobal('Audio', TestAudio); vi.stubGlobal('AudioContext', TestContext); vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: env.mic } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('speaker output isolation', () => {
  it('uses the engine output and volume, ends and cleans up without microphone capture', async () => {
    const test = new SpeakerTester(), pending = test.play('headphones', 0.35);
    await vi.advanceTimersByTimeAsync(1200);
    expect(await pending).toEqual({ ok: true }); expect(env.sinks).toEqual(['headphones']); expect(env.audio[0].volume).toBe(0.35);
    expect(env.mic).not.toHaveBeenCalled(); expect(env.contexts[0].close).toHaveBeenCalledOnce(); expect(env.tracks).toHaveBeenCalledOnce(); expect(env.audio[0].srcObject).toBeNull();
  });
  it('does not silently fall back when the selected device fails', async () => {
    env.sinkError = true; await expect(new SpeakerTester().play('gone', 1)).rejects.toThrow('device removed');
    expect(env.audio[0].play).not.toHaveBeenCalled(); expect(env.contexts[0].close).toHaveBeenCalledOnce();
  });
  it('cannot start late after stopping while device selection is pending', async () => {
    let release!: () => void; env.holdSink = () => new Promise<void>(resolve => { release = resolve; });
    const test = new SpeakerTester(), pending = test.play('headphones', 0.5); test.stop(); release();
    expect(await pending).toEqual({ ok: false }); expect(env.audio[0].play).not.toHaveBeenCalled(); expect(env.mic).not.toHaveBeenCalled();
  });
  it('stops a running tone and supersedes an older test', async () => {
    const test = new SpeakerTester(), old = test.play(null, 0.5); await vi.advanceTimersByTimeAsync(10);
    const next = test.play('speakers', 1); await vi.advanceTimersByTimeAsync(1200);
    expect(await old).toEqual({ ok: false }); expect(await next).toEqual({ ok: true }); expect(env.contexts.every(ctx => ctx.close.mock.calls.length === 1)).toBe(true);
  });
});
