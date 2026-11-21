import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mock.spawn }));
import { probeAudioStreams } from './audio-probe';

let process: EventEmitter & { stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers();
  process = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn() });
  mock.spawn.mockReturnValue(process);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('distinguishes a missing probe from a valid empty catalog', async () => {
  await expect(probeAudioStreams(null, 'private path', true)).rejects.toThrow(/unavailable/);
  const valid = probeAudioStreams('ffmpeg', 'video.mp4', true);
  process.stderr.emit('data', Buffer.from("Input #0, mov,mp4, from 'video.mp4':\n  Stream #0:0: Video: h264\n"));
  process.emit('close', 1);
  await expect(valid).resolves.toEqual([]);
});
it('accepts the deliberate exit code 1 when ffmpeg prints a valid stream table', async () => {
  const valid = probeAudioStreams('ffmpeg', 'video.mp4', true);
  process.stderr.emit('data', Buffer.from("Input #0, matroska, from 'video.mp4':\n  Stream #0:1(rus): Audio: aac, 48000 Hz, stereo\n"));
  process.emit('close', 1);
  await expect(valid).resolves.toMatchObject([{ lang: 'rus', aIndex: 0, codec: 'aac' }]);
  expect(vi.getTimerCount()).toBe(0);
});
it('rejects a failed spawn without converting it into an empty list', async () => {
  const failed = probeAudioStreams('ffmpeg', 'private path', true);
  const checked = expect(failed).rejects.toThrow('Could not inspect audio tracks');
  process.emit('error', Error('ENOENT private path')); process.emit('close', -1); await checked;
  expect(vi.getTimerCount()).toBe(0);
});
it('rejects an unreadable input without a stream table', async () => {
  const failed = probeAudioStreams('ffmpeg', 'missing.mp4', true);
  const checked = expect(failed).rejects.toThrow(/inspect/);
  process.stderr.emit('data', Buffer.from('No such file or directory')); process.emit('close', 1); await checked;
});
it('bounds a hung probe and terminates its process', async () => {
  const checked = expect(probeAudioStreams('ffmpeg', 'video.mp4', true)).rejects.toThrow(/inspect/);
  await vi.advanceTimersByTimeAsync(12000); await checked; expect(process.kill).toHaveBeenCalledTimes(1);
  process.emit('close', 1);
});
it('bounds stderr and retains legacy optional-probe behavior', async () => {
  const checked = expect(probeAudioStreams('ffmpeg', 'video.mp4', true)).rejects.toThrow(/inspect/);
  process.stderr.emit('data', Buffer.alloc(1024 * 1024 + 1)); await checked;
  expect(process.kill).toHaveBeenCalledTimes(1);
  await expect(probeAudioStreams(null, 'video.mp4')).resolves.toEqual([]);
});
