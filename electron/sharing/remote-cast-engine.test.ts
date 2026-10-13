/* eslint-disable @typescript-eslint/no-explicit-any -- Run the real preload with process/peer doubles. */
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./remote-cast-engine.ts', import.meta.url), 'utf8');
const preload = source.slice(source.indexOf('// H.264 main'), source.indexOf("ipcRenderer.on('rcast-cmd'"));
const js = ts.transpileModule(preload + '\n({ startSession, stopSession, attachViewer, sessions });', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

class FakeProcess extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { pause: vi.fn(), resume: vi.fn() });
  stderr = new EventEmitter();
  kill = vi.fn();
}
class FakePeer extends EventEmitter {
  connected = true;
  destroyed = false;
  send = vi.fn();
  _channel = Object.assign(new EventTarget(), { bufferedAmount: 0, bufferedAmountLowThreshold: 0 });
  destroy = vi.fn(() => { this.destroyed = true; this.emit('close'); });
}
function fixture() {
  const procs: FakeProcess[] = [], trackers: any[] = [];
  let failTracker = false;
  const spawn = vi.fn(() => { const proc = new FakeProcess(); procs.push(proc); return proc; });
  const context = {
    crypto, Buffer, spawn, setTimeout, clearTimeout, log: vi.fn(),
    nativeWrtc: {}, STUN_SERVERS: [], RENDEZVOUS_TRACKERS: ['wss://fake'],
    TrackerClient: class extends EventEmitter {
      stop = vi.fn(); destroy = vi.fn();
      constructor() { super(); trackers.push(this); }
      start() { if (failTracker) throw new Error('tracker unavailable'); }
    },
  };
  const engine: any = vm.runInNewContext(js, context);
  const start = () => {
    engine.startSession({ id: 'session', contentPath: 'movie.mkv', ffmpeg: 'ffmpeg', useTurn: false });
    return engine.sessions.get('session');
  };
  const session = start();
  const connect = (peer = new FakePeer()) => { engine.attachViewer(session, peer); return peer; };
  return { ...engine, session, procs, trackers, spawn, connect, start, failTracker: () => { failTracker = true; } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('remote-cast encoder lifecycle', () => {
  it('kills a paused encoder on viewer disconnect and clears channel listeners', () => {
    const f = fixture(), peer = f.connect(), proc = f.procs[0];
    const removeLow = vi.spyOn(peer._channel, 'removeEventListener');
    peer._channel.bufferedAmount = 9 * 1024 * 1024;
    proc.stdout.emit('data', Buffer.alloc(32 * 1024));
    expect(proc.stdout.pause).toHaveBeenCalledOnce();
    peer.emit('close'); peer.emit('close');
    expect(proc.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(proc.stdout.listenerCount('data')).toBe(0);
    expect(removeLow).toHaveBeenCalledWith('bufferedamountlow', expect.any(Function));
    peer._channel.dispatchEvent(new Event('bufferedamountlow'));
    expect(proc.stdout.resume).not.toHaveBeenCalled();
    expect(f.session.procs.has(proc)).toBe(true); // tracked until OS confirms exit
    proc.emit('close');
    expect(f.session.procs.size).toBe(0); expect(f.session.stops.size).toBe(0);
    expect(peer.send.mock.calls.some(([value]) => typeof value === 'string' && JSON.parse(value).t === 'end')).toBe(false);
  });

  it('preserves framing, backpressure and natural completion', () => {
    const f = fixture(), peer = f.connect(), proc = f.procs[0];
    expect(JSON.parse(peer.send.mock.calls[0][0] as string).t).toBe('init');
    peer._channel.bufferedAmount = 9 * 1024 * 1024;
    const addLow = vi.spyOn(peer._channel, 'addEventListener');
    proc.stdout.emit('data', Buffer.alloc(16 * 1024 + 7));
    proc.stdout.emit('data', Buffer.alloc(1));
    expect(peer.send.mock.calls.slice(1).map(([buf]) => (buf as Buffer).length)).toEqual([16 * 1024, 7, 1]);
    expect(addLow).toHaveBeenCalledOnce();
    peer._channel.bufferedAmount = 0;
    peer._channel.dispatchEvent(new Event('bufferedamountlow'));
    expect(proc.stdout.resume).toHaveBeenCalledOnce();
    proc.emit('close');
    expect(JSON.parse(peer.send.mock.calls.at(-1)![0] as string).t).toBe('end');
    expect(proc.kill).not.toHaveBeenCalled(); expect(f.session.procs.size).toBe(0);
    peer.emit('close'); expect(f.session.stops.size).toBe(0);
  });

  it('stops on peer errors, including before connect', () => {
    const f = fixture(), peer = f.connect(), proc = f.procs[0];
    peer.emit('error', new Error('channel closed'));
    expect(proc.kill).toHaveBeenCalledOnce();
    const waiting = new FakePeer(); waiting.connected = false;
    f.connect(waiting); waiting.emit('error', new Error('negotiation failed'));
    waiting.emit('connect');
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it.each(['init', 'data'])('kills the encoder when sending %s fails', phase => {
    const f = fixture(), peer = new FakePeer();
    if (phase === 'init') peer.send.mockImplementationOnce(() => { throw new Error('send failed'); });
    f.connect(peer);
    if (phase === 'data') {
      peer.send.mockImplementationOnce(() => { throw new Error('send failed'); });
      f.procs[0].stdout.emit('data', Buffer.alloc(1024));
    }
    expect(f.procs[0].kill).toHaveBeenCalledOnce();
    expect(f.procs[0].stdout.listenerCount('data')).toBe(0);
  });

  it('clears fallback resume timers and pending connects when a session stops', () => {
    const f = fixture(), peer = f.connect(), proc = f.procs[0];
    const waiting = new FakePeer(); waiting.connected = false; f.connect(waiting);
    peer._channel.bufferedAmount = 9 * 1024 * 1024;
    vi.spyOn(peer._channel, 'addEventListener').mockImplementation(() => { throw new Error('channel unavailable'); });
    proc.stdout.emit('data', Buffer.alloc(1));
    expect(vi.getTimerCount()).toBe(1);
    f.stopSession('session'); f.stopSession('session');
    expect(vi.getTimerCount()).toBe(0);
    expect(proc.kill).toHaveBeenCalledOnce();
    expect(peer.destroy).toHaveBeenCalledOnce(); expect(waiting.destroy).toHaveBeenCalledOnce();
    waiting.emit('connect'); vi.runAllTimers();
    expect(f.spawn).toHaveBeenCalledOnce(); expect(proc.stdout.resume).not.toHaveBeenCalled();
    const late = new FakePeer(); f.trackers[0].emit('peer', late);
    expect(late.destroy).toHaveBeenCalledOnce(); expect(f.spawn).toHaveBeenCalledOnce();
  });

  it('stops only the encoder owned by the departing viewer', () => {
    const f = fixture(), first = f.connect(), second = f.connect();
    first.emit('close');
    expect(f.procs[0].kill).toHaveBeenCalledOnce(); expect(f.procs[1].kill).not.toHaveBeenCalled();
    f.procs[1].stdout.emit('data', Buffer.alloc(1));
    expect(second.send).toHaveBeenCalledTimes(2);
    f.stopSession('session'); expect(f.procs[1].kill).toHaveBeenCalledOnce();
  });

  it('cleans up failed FFmpeg and tracker starts', () => {
    const f = fixture(); f.connect();
    f.procs[0].emit('error', new Error('ENOENT')); f.procs[0].emit('close');
    expect(f.procs[0].kill).toHaveBeenCalledOnce(); expect(f.session.procs.size).toBe(0);
    f.stopSession('session'); f.failTracker();
    expect(() => f.start()).toThrow('tracker unavailable');
    expect(f.sessions.size).toBe(0); expect(f.trackers[1].destroy).toHaveBeenCalledOnce();
  });
});