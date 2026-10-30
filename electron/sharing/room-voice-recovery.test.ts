import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenAec } from './voice/screen-aec';
import { VoiceSession, defaultVoiceSettings } from './room-voice';
import { GuestVoice } from '../../guest/voice';
import { VOICE_CONNECT_TIMEOUT_MS, VOICE_RETRY_DELAYS_MS } from '../../shared/room-voice-recovery';

class Track {
  kind = 'audio'; enabled = true; readyState = 'live'; onended: (() => void) | null = null;
  stop = vi.fn(() => { this.readyState = 'ended'; });
  applyConstraints = vi.fn(async (_constraints: MediaTrackConstraints) => {});
  clone() { const t = new Track(); t.enabled = this.enabled; return t; }
}
class Stream {
  id = 'mic';
  constructor(public tracks = [new Track()]) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
}
class Peer {
  static all: Peer[] = [];
  connectionState = 'new'; signalingState = 'stable'; remoteDescription: unknown = null;
  localDescription = { type: 'offer', sdp: 'synthetic' };
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onnegotiationneeded: (() => Promise<void>) | null = null;
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  ontrack: ((event: { track: Track; streams: Stream[] }) => void) | null = null;
  senders: Array<{ track: Track; replaceTrack: ReturnType<typeof vi.fn>; getParameters: ReturnType<typeof vi.fn>; setParameters: ReturnType<typeof vi.fn> }> = [];
  constructor() { Peer.all.push(this); }
  addTrack(track: Track) { const s = { track, getParameters: vi.fn(() => ({ encodings: [{}] })), setParameters: vi.fn(async () => {}), replaceTrack: vi.fn(async (fresh: Track) => { s.track = fresh; }) }; this.senders.push(s); return s; }
  addTransceiver(track: Track) { return { sender: this.addTrack(track), stop: vi.fn(), receiver: { track }, direction: 'sendonly' }; }
  getTransceivers() { return []; }
  getSenders() { return this.senders; }
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async (value: unknown) => { this.remoteDescription = value; });
  addIceCandidate = vi.fn(async () => {});
  getStats = vi.fn(async () => new Map());
  restartIce = vi.fn(() => { void this.onnegotiationneeded?.(); });
  close = vi.fn(() => { this.connectionState = 'closed'; this.onconnectionstatechange?.(); });
  state(value: string) { this.connectionState = value; this.onconnectionstatechange?.(); this.oniceconnectionstatechange?.(); }
}
class Node {
  gain = { value: 1 }; fftSize = 512; frequencyBinCount = 256;
  connect() {} disconnect() {} getByteFrequencyData() {}
}
class Context {
  static fail = false;
  createMediaStreamSource() { if (Context.fail) throw new Error('no processing'); return new Node(); }
  createAnalyser() { return new Node(); } createGain() { return new Node(); }
  createMediaStreamDestination() { return { stream: new Stream() }; }
  close = vi.fn(async () => {}); resume = vi.fn(async () => {});
}
class AudioElement {
  muted = false; srcObject: unknown = null;
  play = vi.fn(async () => {});
}
let capture: ReturnType<typeof vi.fn>, events: EventTarget, devices: EventTarget;
const sessions: Array<VoiceSession | GuestVoice> = [];
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const media = (s: Stream) => s as unknown as MediaStream;
function deferred() { let resolve!: (s: MediaStream) => void; const promise = new Promise<MediaStream>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0); Peer.all = []; Context.fail = false;
  capture = vi.fn(async () => media(new Stream())); devices = new EventTarget(); events = new EventTarget();
  vi.stubGlobal('navigator', { mediaDevices: Object.assign(devices, { getUserMedia: capture }) });
  vi.stubGlobal('addEventListener', events.addEventListener.bind(events));
  vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events));
  vi.stubGlobal('MediaStream', Stream); vi.stubGlobal('AudioContext', Context);
  vi.stubGlobal('RTCPeerConnection', Peer); vi.stubGlobal('Audio', AudioElement);
});
afterEach(() => { sessions.splice(0).forEach(s => s.leave()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers(); });
function setup(kind: 'desktop' | 'guest', settings: Partial<ReturnType<typeof defaultVoiceSettings>> = {}) {
  const hooks = { selfId: 'A', iceServers: [], sendSignal: vi.fn(), announce: vi.fn(), announceShare: vi.fn(), sendLoopback: vi.fn(), onChange: vi.fn(), warn: vi.fn(), log: vi.fn() };
  const s = kind === 'desktop' ? new VoiceSession(hooks, () => Date.now(), () => ({ ...defaultVoiceSettings(), noiseSuppressionMode: 'off', ...settings })) : new GuestVoice(hooks);
  sessions.push(s);
  const participants = () => s instanceof VoiceSession ? s.getState().participants : s.participants();
  return { s, hooks, participants };
}
function exhaust(pc: Peer) {
  pc.state('failed');
  for (const delay of VOICE_RETRY_DELAYS_MS) { vi.advanceTimersByTime(delay); vi.advanceTimersByTime(VOICE_CONNECT_TIMEOUT_MS); }
}
describe.each(['desktop', 'guest'] as const)('%s voice recovery integration', kind => {
  it('restarts ICE on the same peer, preserves mute/deafen and stops at the budget', async () => {
    const { s, participants } = setup(kind); await s.join(); s.setMuted(true); s.setDeafened(true);
    s.onPeerState('B', true, false, 1); const pc = Peer.all[0]; exhaust(pc); await flush();
    expect(Peer.all).toHaveLength(1); expect(pc.close).not.toHaveBeenCalled(); expect(pc.restartIce).toHaveBeenCalledTimes(3);
    expect(pc.senders[0].track.enabled).toBe(false);
    expect(participants().find(p => p.memberId === 'B')).toMatchObject({ connection: 'failed', reconnectAttempts: 3 });
    for (let i = 0; i < 30; i++) { s.onPeerState('B', true, false, i + 2); s.onSignal('B', 'ice', {}); }
    vi.advanceTimersByTime(300_000); expect(pc.restartIce).toHaveBeenCalledTimes(3); expect(Peer.all).toHaveLength(1);
    s.reconnect(); await flush(); expect(pc.restartIce).toHaveBeenCalledTimes(4); expect(capture).toHaveBeenCalledTimes(1);
    expect(pc.senders[0].track.enabled).toBe(false);
  });
  it('allows a short disconnect, recovers a long one, and clears pending retries on leave', async () => {
    const { s, participants } = setup(kind); await s.join(); s.onPeerState('B', true, false, 1);
    const pc = Peer.all[0]; pc.state('connected'); pc.state('disconnected'); vi.advanceTimersByTime(4_000); pc.state('connected');
    expect(pc.restartIce).not.toHaveBeenCalled(); expect(participants().find(p => p.memberId === 'B')?.connection).toBe('connected');
    pc.state('disconnected'); vi.advanceTimersByTime(6_000); expect(pc.restartIce).toHaveBeenCalledTimes(1);
    const negotiation = pc.onnegotiationneeded!; s.leave(); await flush();
    pc.state('failed'); await negotiation(); vi.advanceTimersByTime(300_000);
    expect(pc.restartIce).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('times out an unanswered first handshake and removes all timers when a member leaves', async () => {
    const { s } = setup(kind); await s.join(); s.onPeerState('B', true, false, 1);
    const pc = Peer.all[0]; vi.advanceTimersByTime(21_000); expect(pc.restartIce).toHaveBeenCalledTimes(1);
    s.onMemberGone('B'); vi.advanceTimersByTime(300_000); expect(pc.restartIce).toHaveBeenCalledTimes(1);
    expect(pc.close).toHaveBeenCalledTimes(1); s.leave(); expect(vi.getTimerCount()).toBe(0);
  });
  it('recovers an existing call on a local network change without recapturing or unmuting', async () => {
    const { s } = setup(kind); s.onNetworkChanged(); expect(capture).not.toHaveBeenCalled();
    await s.join(); s.setMuted(true); s.onPeerState('B', true, false, 1); const pc = Peer.all[0]; exhaust(pc);
    s.onNetworkChanged(); for (let i = 0; i < 20; i++) s.onNetworkChanged();
    expect(pc.restartIce).toHaveBeenCalledTimes(4); expect(pc.senders[0].track.enabled).toBe(false); expect(capture).toHaveBeenCalledTimes(1);
    s.leave(); s.onNetworkChanged(); expect(capture).toHaveBeenCalledTimes(1);
  });
  it('does not answer a negotiation that completes after leave', async () => {
    const { s, hooks } = setup(kind); await s.join(); s.onPeerState('B', true, false, 1);
    const pc = Peer.all[0]; let resolve!: () => void;
    pc.setRemoteDescription.mockImplementation(() => new Promise<void>(r => { resolve = r; }));
    s.onSignal('B', 'offer', { type: 'offer', sdp: 'remote' }); s.leave(); resolve(); await flush();
    expect(hooks.sendSignal.mock.calls.filter(c => c[1] === 'answer')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts an offer while a remote answer is pending even if trickled ICE interleaves', async () => {
    const { s } = setup(kind); await s.join(); s.onPeerState('B', true, false, 1);
    const pc = Peer.all[0]; pc.signalingState = 'have-local-offer';
    let resolve!: () => void;
    pc.setRemoteDescription.mockImplementationOnce(() => new Promise<void>(r => { resolve = r; }));
    s.onSignal('B', 'answer', { type: 'answer', sdp: 'answer' });
    s.onSignal('B', 'ice', { candidate: 'candidate' }); await flush();
    s.onSignal('B', 'offer', { type: 'offer', sdp: 'next-offer' }); await flush();
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'next-offer' });
    resolve(); await flush();
  });

  it('releases media and retries after a kicked peer or room teardown', async () => {
    const { s } = setup(kind); await s.join(); s.onPeerState('B', true, false, 1);
    const pc = Peer.all[0]; pc.state('failed'); s.onPeerState('B', false, false, 2);
    vi.advanceTimersByTime(300_000); expect(pc.restartIce).not.toHaveBeenCalled(); expect(pc.close).toHaveBeenCalled();
    s.leave(); expect(vi.getTimerCount()).toBe(0);
  });
});
describe('guest microphone recovery', () => {
  it('recaptures the default mic on hotplug and gates it before replacing senders', async () => {
    const old = new Stream(), fresh = new Stream(); capture.mockResolvedValueOnce(media(old)).mockResolvedValueOnce(media(fresh));
    const { s } = setup('guest'); await s.join(); s.setDeafened(true); s.onPeerState('B', true, false, 1);
    const pc = Peer.all[0]; pc.senders[0].replaceTrack.mockImplementation(async (track: Track) => { expect(track.enabled).toBe(false); });
    for (let i = 0; i < 10; i++) devices.dispatchEvent(new Event('devicechange'));
    await vi.advanceTimersByTimeAsync(300); await flush();
    expect(capture).toHaveBeenCalledTimes(2); expect(old.tracks[0].stop).toHaveBeenCalled();
    expect(pc.senders[0].replaceTrack).toHaveBeenCalledWith(fresh.tracks[0]);
    expect(pc.close).not.toHaveBeenCalled(); s.leave(); expect(fresh.tracks[0].stop).toHaveBeenCalled();
  });
  it('shows a missing mic and recovers when an input returns', async () => {
    const old = new Stream(), fresh = new Stream(); capture.mockResolvedValueOnce(media(old)).mockRejectedValueOnce(new Error('not found')).mockResolvedValueOnce(media(fresh));
    const { s } = setup('guest'); await s.join(); old.tracks[0].readyState = 'ended'; old.tracks[0].onended!(); await flush();
    expect((s as GuestVoice).micUnavailable).toBe(true);
    devices.dispatchEvent(new Event('devicechange')); await vi.advanceTimersByTimeAsync(300); await flush();
    expect((s as GuestVoice).micUnavailable).toBe(false); expect(fresh.tracks[0].enabled).toBe(true);
  });
  it('discards a late replacement after leave/rejoin and unregisters device/network listeners', async () => {
    const old = new Stream(), pending = deferred(), late = new Stream(), current = new Stream();
    capture.mockResolvedValueOnce(media(old)).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(media(current));
    const { s } = setup('guest'); await s.join(); old.tracks[0].readyState = 'ended'; old.tracks[0].onended!();
    s.leave(); devices.dispatchEvent(new Event('devicechange')); events.dispatchEvent(new Event('online')); await flush(); expect(capture).toHaveBeenCalledTimes(2);
    await s.join(); pending.resolve(media(late)); await flush();
    expect(late.tracks[0].stop).toHaveBeenCalled(); expect(current.tracks[0].stop).not.toHaveBeenCalled();
    s.leave(); expect(vi.getTimerCount()).toBe(0);
  });
  it('coalesces a device update that arrives while recapture is in flight', async () => {
    const first = new Stream(), pending = deferred(), second = new Stream(), newest = new Stream();
    capture.mockResolvedValueOnce(media(first)).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(media(newest));
    const { s } = setup('guest'); await s.join(); first.tracks[0].readyState = 'ended'; first.tracks[0].onended!();
    devices.dispatchEvent(new Event('devicechange')); await vi.advanceTimersByTimeAsync(300);
    pending.resolve(media(second)); await flush(); await vi.advanceTimersByTimeAsync(300); await flush();
    expect(capture).toHaveBeenCalledTimes(3); expect(second.tracks[0].stop).toHaveBeenCalled();
    expect(newest.tracks[0].stop).not.toHaveBeenCalled();
  });

  it('handles a default-device update while idle without requesting permission', async () => {
    const { s } = setup('guest'); s.onDevicesChanged(); s.onNetworkChanged(); events.dispatchEvent(new Event('online'));
    devices.dispatchEvent(new Event('devicechange')); vi.advanceTimersByTime(300_000); expect(capture).not.toHaveBeenCalled();
  });
});

it('desktop retains a default-device change that occurs during a pending recapture', async () => {
  const first = new Stream(), pending = deferred(), second = new Stream(), newest = new Stream();
  capture.mockResolvedValueOnce(media(first)).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(media(newest));
  const { s } = setup('desktop'); const desktop = s as VoiceSession; await desktop.join(); await flush();
  desktop.onDevicesChanged(); await flush(); desktop.onDevicesChanged();
  pending.resolve(media(second)); await flush();
  expect(capture).toHaveBeenCalledTimes(3); expect(second.tracks[0].stop).toHaveBeenCalled();
  expect(newest.tracks[0].stop).not.toHaveBeenCalled();
});

it('desktop raw-pipeline fallback swaps only the microphone and preserves PTT/screen audio', async () => {
  Context.fail = true;
  const old = new Stream(), fresh = new Stream(); capture.mockResolvedValueOnce(media(old)).mockResolvedValueOnce(media(fresh));
  const { s } = setup('desktop'); const desktop = s as VoiceSession; await desktop.join(); desktop.setInputMode('ptt');
  desktop.onPeerState('B', true, false, 1); const pc = Peer.all[0];
  const video = new Track(); video.kind = 'video'; const systemAudio = new Track();
  vi.spyOn(ScreenAec, 'create').mockResolvedValue({ outputTrack: systemAudio, close: vi.fn(), setReference: vi.fn(), removeReference: vi.fn() } as unknown as ScreenAec);
  desktop.startShare(media(new Stream([video, systemAudio])));
  await flush(); const systemSender = pc.senders.find(sender => sender.track === systemAudio);
  desktop.onDevicesChanged(); await flush();
  expect(pc.senders[0].replaceTrack).toHaveBeenCalledWith(fresh.tracks[0]); expect(fresh.tracks[0].enabled).toBe(false);
  expect(systemSender?.replaceTrack).not.toHaveBeenCalled();
  desktop.leave();
});

it('applies screen bitrate to current and mid-share peers without recapturing media', async () => {
  const { s } = setup('desktop'); const desktop = s as VoiceSession;
  desktop.setScreenBitrate(1000); await desktop.join(); desktop.onPeerState('B', true, false, 1);
  const video = new Track(); video.kind = 'video'; desktop.startShare(media(new Stream([video]))); await flush();
  const first = Peer.all[0].senders.find(sender => sender.track.kind === 'video')!;
  expect(first.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 1000000, maxFramerate: 30 }] }));
  desktop.setScreenBitrate(1750); await flush();
  expect(first.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 1750000, maxFramerate: 30 }] }));
  desktop.onPeerState('C', true, false, 2); await flush();
  const next = Peer.all[1].senders.find(sender => sender.track.kind === 'video')!;
  expect(next.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 1750000, maxFramerate: 30 }] }));
  expect(capture).toHaveBeenCalledTimes(1);
  expect(() => desktop.setScreenBitrate(NaN)).toThrow('Invalid');
  expect(() => desktop.setScreenBitrate(249)).toThrow('Invalid');
});

it('applies a 60 FPS selection to existing, reconnecting and mid-share peers within the room bitrate cap', async () => {
  const { s } = setup('desktop'), desktop = s as VoiceSession;
  await desktop.join(); desktop.onPeerState('B', true, false, 1);
  const track = new Track(); track.kind = 'video';
  desktop.startShare(media(new Stream([track])), { height: 1440, fps: 60, bitrateKbps: 8000 }); await flush();
  const first = Peer.all[0].senders.find(sender => sender.track.kind === 'video')!;
  expect(first.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 2500000, maxFramerate: 60 }] }));
  desktop.setScreenBitrate(12000); Peer.all[0].state('connected'); await flush();
  expect(first.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 8000000, maxFramerate: 60 }] }));
  desktop.onPeerState('C', true, false, 2); await flush();
  const next = Peer.all[1].senders.find(sender => sender.track.kind === 'video')!;
  expect(next.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 8000000, maxFramerate: 60 }] }));
  desktop.setScreenBitrate(1000); await flush();
  expect(next.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 1000000, maxFramerate: 60 }] }));
  expect(capture).toHaveBeenCalledTimes(1);
});

it('lets a viewer forward 60 FPS instead of imposing the former 15 FPS cap', async () => {
  const { s } = setup('desktop'), desktop = s as VoiceSession;
  await desktop.join(); const track = new Track(); track.kind = 'video';
  desktop.startShare(media(new Stream([track])), { height: 1080, fps: 60, bitrateKbps: 0 });
  desktop.watchStart('A'); await flush();
  expect(Peer.all[0].senders[0].setParameters).toHaveBeenCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 10000000, maxFramerate: 60 }] }));
});

it('changes live capture quality without restarting voice, sharing or the viewer', async () => {
  const { s, hooks } = setup('desktop'), desktop = s as VoiceSession;
  await desktop.join(); desktop.onPeerState('B', true, false, 1);
  const track = new Track(); track.kind = 'video';
  desktop.startShare(media(new Stream([track]))); desktop.watchStart('A'); await flush();
  const originalPeers = [...Peer.all], announcements = hooks.announceShare.mock.calls.length;
  desktop.setMuted(true);
  await desktop.configureShare({ height: 720, fps: 60, bitrateKbps: 1000 }); await flush();
  expect(track.applyConstraints).toHaveBeenCalledWith({ width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 60 } });
  expect(desktop.getState()).toMatchObject({ inVoice: true, muted: true, sharing: true, shareSettings: { height: 720, fps: 60, bitrateKbps: 1000 } });
  expect(Peer.all).toEqual(originalPeers);
  for (const peer of Peer.all) expect(peer.close).not.toHaveBeenCalled();
  expect(track.stop).not.toHaveBeenCalled(); expect(capture).toHaveBeenCalledTimes(1);
  expect(hooks.announceShare).toHaveBeenCalledTimes(announcements);
  expect(Peer.all[0].senders.find(sender => sender.track.kind === 'video')!.setParameters)
    .toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ maxBitrate: 1000000, maxFramerate: 60 }] }));
});

it('keeps the previous share and quality when constraints fail, and accepts a retry', async () => {
  const { s } = setup('desktop'), desktop = s as VoiceSession;
  await desktop.join(); const track = new Track(); track.kind = 'video';
  desktop.startShare(media(new Stream([track])));
  track.applyConstraints.mockRejectedValueOnce(new Error('unsupported capture constraints'));
  await expect(desktop.configureShare({ height: 2160, fps: 60, bitrateKbps: 0 })).rejects.toThrow('unsupported');
  expect(desktop.getState()).toMatchObject({ sharing: true, shareSettings: { height: 1080, fps: 30 } });
  expect(track.stop).not.toHaveBeenCalled();
  await desktop.configureShare({ height: 480, fps: 15, bitrateKbps: 0 });
  expect(desktop.getState().shareSettings?.height).toBe(480);
});

it('does not apply a late quality result to a stopped or replacement share', async () => {
  const { s } = setup('desktop'), desktop = s as VoiceSession;
  await desktop.join(); const previous = new Track(); previous.kind = 'video';
  desktop.startShare(media(new Stream([previous])));
  let finish!: () => void;
  previous.applyConstraints.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const changing = desktop.configureShare({ height: 480, fps: 15, bitrateKbps: 500 });
  await expect(desktop.configureShare({ height: 720, fps: 30, bitrateKbps: 0 })).rejects.toThrow('already');
  desktop.stopShare(); const next = new Track(); next.kind = 'video';
  desktop.startShare(media(new Stream([next])), { height: 1440, fps: 60, bitrateKbps: 2500 });
  finish(); await expect(changing).rejects.toThrow('not active');
  expect(desktop.getState()).toMatchObject({ sharing: true, shareSettings: { height: 1440, fps: 60 } });
  expect(next.stop).not.toHaveBeenCalled();
});

it('changes screen audio separately from the microphone and honours deafen', async () => {
  const { s } = setup('desktop'), desktop = s as VoiceSession;
  await desktop.join(); desktop.onPeerState('B', true, false, 1);
  const peer = (desktop as any).peers.get('B');
  const mic = new AudioElement(), screen = new AudioElement();
  (mic as any).volume = .8; (screen as any).volume = 1;
  peer.audioEl = mic; peer.shareAudioEl = screen;
  desktop.setScreenPlayback('B', .25, true);
  expect(screen).toMatchObject({ volume: .25, muted: true });
  expect(mic).toMatchObject({ volume: .8, muted: false });
  desktop.setDeafened(true); desktop.setScreenPlayback('B', .5, false);
  expect(screen.muted).toBe(true);
  desktop.setDeafened(false);
  expect(screen).toMatchObject({ volume: .5, muted: false });
  expect(() => desktop.setScreenPlayback('B', NaN, false)).toThrow('Invalid');
  expect(capture).toHaveBeenCalledTimes(1);
});

it('applies the global volume and output device to current screen audio while keeping its own level', async () => {
  const settings = { masterVolume: .5, outputDeviceId: 'first' };
  const { s } = setup('desktop', settings), desktop = s as VoiceSession;
  await desktop.join(); desktop.onPeerState('B', true, false, 1);
  const peer = (desktop as any).peers.get('B');
  const screen = Object.assign(new AudioElement(), { volume: 1, setSinkId: vi.fn(async (_id: string) => {}) });
  peer.shareAudioEl = screen;
  desktop.setScreenPlayback('B', .4, false); desktop.applySettings();
  expect(screen.volume).toBeCloseTo(.2);
  settings.masterVolume = 0; settings.outputDeviceId = 'headphones'; desktop.applySettings();
  expect(screen.volume).toBe(0);
  expect(screen.setSinkId).toHaveBeenLastCalledWith('headphones');
  settings.masterVolume = .75; desktop.applySettings();
  expect(screen.volume).toBeCloseTo(.3);
});

async function selfScreen() {
  const { s, hooks } = setup('desktop'), desktop = s as VoiceSession;
  await desktop.join();
  const track = new Track(); track.kind = 'video';
  desktop.startShare(media(new Stream([track]))); desktop.watchStart('A');
  return { desktop, hooks, pc: Peer.all[0] };
}

it('retains loopback ICE until a renderer answer has finished applying', async () => {
  const { desktop, pc } = await selfScreen();
  let complete!: () => void;
  pc.setRemoteDescription.mockImplementationOnce(value => new Promise<void>(resolve => {
    complete = () => { pc.remoteDescription = value; resolve(); };
  }));
  pc.addIceCandidate.mockImplementation(async () => { if (!pc.remoteDescription) throw Error('No remote description'); });
  desktop.onLoopbackSignal('A', 'ice', { candidate: 'early' });
  desktop.onLoopbackSignal('A', 'answer', { type: 'answer', sdp: 'renderer' });
  await flush(); expect(pc.addIceCandidate).not.toHaveBeenCalled();
  complete(); await flush();
  expect(pc.addIceCandidate).toHaveBeenCalledExactlyOnceWith({ candidate: 'early' });
});

it('does not offer or signal an error after a loopback is closed mid-negotiation', async () => {
  const { desktop, pc, hooks } = await selfScreen();
  let complete!: () => void;
  pc.setLocalDescription.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  const negotiation = pc.onnegotiationneeded!(); desktop.watchStop('A'); complete(); await negotiation;
  expect(hooks.sendLoopback).not.toHaveBeenCalled(); expect(hooks.log).not.toHaveBeenCalled();
});

it('a late closed event from a replaced loopback cannot remove the new watch', async () => {
  const { desktop, pc: previous } = await selfScreen();
  desktop.watchStart('A'); const current = Peer.all[1];
  previous.state('closed');
  desktop.onLoopbackSignal('A', 'answer', { type: 'answer', sdp: 'current' }); await flush();
  expect(current.setRemoteDescription).toHaveBeenCalledExactlyOnceWith({ type: 'answer', sdp: 'current' });
  expect(current.close).not.toHaveBeenCalled();
});
