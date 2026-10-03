import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession, defaultVoiceSettings, type VoiceAdapter } from './room-voice';
import { GuestVoice, type VoiceHooks } from '../../guest/voice';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class Track {
  kind = 'audio'; enabled = true; readyState = 'live'; onended: (() => void) | null = null;
  stop = vi.fn(() => { this.readyState = 'ended'; });
  clone() { const track = new Track(); track.enabled = this.enabled; return track; }
}
class Stream {
  constructor(public tracks = [new Track()]) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}
class Node {
  connect = vi.fn(); disconnect = vi.fn(); gain = { value: 1 };
  fftSize = 512; frequencyBinCount = 256; getByteFrequencyData = vi.fn();
}
let addModule: ReturnType<typeof vi.fn>;
class Context {
  static all: Context[] = [];
  output = new Stream(); source = new Node();
  audioWorklet = { addModule: (...args: unknown[]) => addModule(...args) };
  constructor() { Context.all.push(this); }
  createMediaStreamSource = vi.fn(() => this.source);
  createGain() { return new Node(); }
  createMediaStreamDestination() { return { stream: this.output }; }
  createAnalyser() { return new Node(); }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
}
class Worklet extends Node {
  static all: Worklet[] = [];
  port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
  constructor(public context: Context) { super(); Worklet.all.push(this); }
}
class Peer {
  static all: Peer[] = [];
  ontrack?: (event: { track: Track; streams: Stream[] }) => void;
  addTrack = vi.fn(); close = vi.fn();
  constructor() { Peer.all.push(this); }
}
class AudioElement {
  static all: AudioElement[] = [];
  muted = false; autoplay = false; srcObject: unknown = null;
  constructor() { AudioElement.all.push(this); }
  play = vi.fn(async () => {});
}

let capture: ReturnType<typeof vi.fn>;
const sessions: Array<{ leave(): void }> = [];
const media = (s: Stream) => s as unknown as MediaStream;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function hooks(): VoiceAdapter & VoiceHooks {
  return { selfId: 'A', iceServers: [], announce: vi.fn(), announceShare: vi.fn(),
    sendSignal: vi.fn(), sendLoopback: vi.fn(), onChange: vi.fn(), warn: vi.fn(), log: vi.fn() };
}

beforeEach(() => {
  vi.useFakeTimers();
  Context.all = []; Peer.all = []; Worklet.all = []; AudioElement.all = [];
  capture = vi.fn(); addModule = vi.fn(async () => {});
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: capture } });
  vi.stubGlobal('MediaStream', Stream); vi.stubGlobal('AudioContext', Context);
  vi.stubGlobal('AudioWorkletNode', Worklet); vi.stubGlobal('RTCPeerConnection', Peer);
  vi.stubGlobal('Audio', AudioElement);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  sessions.splice(0).forEach((s) => s.leave());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe.each(['desktop', 'guest'] as const)('%s microphone lifecycle', (kind) => {
  function setup() {
    const adapter = hooks();
    const session = kind === 'desktop'
      ? new VoiceSession(adapter, () => Date.now(), () => ({ ...defaultVoiceSettings(), noiseSuppressionMode: 'off' }))
      : new GuestVoice(adapter);
    sessions.push(session);
    const active = () => session instanceof VoiceSession ? session.isActive() : session.inVoice;
    return { adapter, session, active };
  }

  it('keeps at most eight media peers, preserves chosen links, and releases a slot when presence changes', async () => {
    const { session } = setup(), stream = new Stream(); capture.mockResolvedValue(media(stream));
    for (let i = 11; i >= 0; i--) session.onPeerState('B' + String(i).padStart(2, '0'), true, false, 1);
    await session.join();
    const peers: Map<string, unknown> = (session as unknown as { peers: Map<string, unknown> }).peers;
    expect(peers.size).toBe(8); expect([...peers.keys()].sort()).toEqual(Array.from({ length: 8 }, (_, i) => 'B0' + i));
    const kept = peers.get('B01'); session.onPeerState('B01', true, true, 2);
    expect(peers.get('B01')).toBe(kept);
    session.onMemberGone('B00'); expect(peers.size).toBe(8); expect(peers.has('B08')).toBe(true);
    session.onPeerState('B00', true, false, 1); expect(peers.has('B00')).toBe(false);
  });

  it('releases a microphone granted after leaving without announcing a join', async () => {
    const pending = deferred<MediaStream>(), stream = new Stream();
    capture.mockReturnValue(pending.promise);
    const { session, active, adapter } = setup();
    const join = session.join(); session.leave(); pending.resolve(media(stream)); await join;
    expect(active()).toBe(false);
    expect(stream.tracks[0].stop).toHaveBeenCalled();
    expect(adapter.announce).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a new join after cancellation without attaching the old capture', async () => {
    const pending = deferred<MediaStream>(), old = new Stream(), current = new Stream();
    capture.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(media(current));
    const { session, active, adapter } = setup();
    const oldJoin = session.join(); session.leave(); await session.join();
    pending.resolve(media(old)); await oldJoin;
    expect(active()).toBe(true);
    expect(old.tracks[0].stop).toHaveBeenCalled();
    expect(current.tracks[0].stop).not.toHaveBeenCalled();
    expect(adapter.announce).toHaveBeenCalledTimes(1);
    session.leave(); expect(current.tracks[0].stop).toHaveBeenCalled();
  });

  it('captures only once for simultaneous joins', async () => {
    const pending = deferred<MediaStream>(); capture.mockReturnValue(pending.promise);
    const { session, adapter } = setup();
    const first = session.join(), second = session.join();
    expect(capture).toHaveBeenCalledTimes(1);
    pending.resolve(media(new Stream())); await Promise.all([first, second]);
    expect(adapter.announce).toHaveBeenCalledTimes(1);
  });

  it('preserves mute across rejoin before adding any outgoing tracks', async () => {
    capture.mockImplementation(async () => media(new Stream()));
    const { session } = setup();
    await session.join(); session.setMuted(true); session.leave();
    session.onPeerState('B', true, false, 1); await session.join();
    expect(Peer.all.at(-1)!.addTrack.mock.calls[0][0].enabled).toBe(false);
    session.setMuted(false);
    expect(Peer.all.at(-1)!.addTrack.mock.calls[0][0].enabled).toBe(true);
  });

  it('can retry after a permission denial', async () => {
    capture.mockRejectedValueOnce(new Error('permission denied')).mockResolvedValueOnce(media(new Stream()));
    const { session, active } = setup();
    await expect(session.join()).rejects.toThrow('permission denied');
    await session.join(); expect(active()).toBe(true);
  });
});

describe('desktop async processing and recapture', () => {
  it('cancels pipeline initialization and does not modify the replacement context', async () => {
    const pending = deferred<void>(); addModule.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined);
    const old = new Stream(), current = new Stream();
    capture.mockResolvedValueOnce(media(old)).mockResolvedValueOnce(media(current));
    const adapter = hooks(), session = new VoiceSession(adapter);
    sessions.push(session);
    const oldJoin = session.join(); await flush();
    const oldContext = Context.all[0];
    await session.join(); expect(capture).toHaveBeenCalledTimes(1); // guarded during worklet await too
    session.leave(); await session.join();
    const currentContext = Worklet.all[0].context;
    pending.resolve(); await oldJoin;
    expect(session.isActive()).toBe(true);
    expect(old.tracks[0].stop).toHaveBeenCalled();
    expect(oldContext.close).toHaveBeenCalled();
    expect(oldContext.output.tracks[0].stop).toHaveBeenCalled();
    expect(currentContext.close).not.toHaveBeenCalled();
    expect(currentContext.output.tracks[0].stop).not.toHaveBeenCalled();
    expect(Worklet.all).toHaveLength(1);
    expect(adapter.announce).toHaveBeenCalledTimes(1);
  });

  it('discards a device-change capture that resolves after leave and rejoin', async () => {
    const initial = new Stream(), late = new Stream(), current = new Stream(), pending = deferred<MediaStream>();
    capture.mockResolvedValueOnce(media(initial)).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(media(current));
    let settings = { ...defaultVoiceSettings(), noiseSuppressionMode: 'off' as const };
    const session = new VoiceSession(hooks(), () => Date.now(), () => settings); sessions.push(session);
    await session.join();
    settings = { ...settings, inputDeviceId: 'new-device' }; session.applySettings(); await flush();
    expect(capture).toHaveBeenCalledTimes(2);
    session.leave(); await session.join(); pending.resolve(media(late)); await flush();
    expect(late.tracks[0].stop).toHaveBeenCalled();
    expect(current.tracks[0].stop).not.toHaveBeenCalled();
    expect(session.isActive()).toBe(true);
  });

  it('does not fall back to another device after cancellation of a failed preferred capture', async () => {
    const pending = deferred<MediaStream>(); capture.mockReturnValue(pending.promise);
    const session = new VoiceSession(hooks(), () => Date.now(), () => ({ ...defaultVoiceSettings(), inputDeviceId: 'missing' })); sessions.push(session);
    const join = session.join(); session.leave(); pending.reject(new Error('not found')); await join;
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

it('guest deafen disables transmission and also mutes peers added afterwards', async () => {
  const local = new Stream(); capture.mockResolvedValue(media(local));
  const session = new GuestVoice(hooks()); sessions.push(session);
  session.setDeafened(true); await session.join(); session.onPeerState('B', true, false, 1);
  Peer.all[0].ontrack!({ track: new Track(), streams: [new Stream()] });
  expect(local.tracks[0].enabled).toBe(false);
  expect(AudioElement.all[0].muted).toBe(true);
  session.setDeafened(false);
  expect(local.tracks[0].enabled).toBe(true);
  expect(AudioElement.all[0].muted).toBe(false);
});
