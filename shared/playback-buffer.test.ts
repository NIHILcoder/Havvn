import { expect, it } from 'vitest';
import { bufferedSecondsAhead, playbackPhase, readBufferedRanges, type PlaybackSnapshot, type PlaybackSource } from './playback-buffer';

const media: PlaybackSnapshot = { attached: true, readyState: 4, paused: false, ended: false, seeking: false, waiting: false };
const source: PlaybackSource = { status: 'downloading', progress: 0.5, peers: 5, downSpeedBps: 1000 };
it('measures only the continuous range containing the playhead', () => {
  const ranges = [{ start: 0, end: 10 }, { start: 50, end: 80 }];
  expect(bufferedSecondsAhead(ranges, 5)).toBe(5);
  expect(bufferedSecondsAhead(ranges, 20)).toBe(0);
  expect(bufferedSecondsAhead(ranges, 60)).toBe(20);
  expect(bufferedSecondsAhead(ranges, 10)).toBe(0);
  expect(bufferedSecondsAhead(ranges, NaN)).toBe(0);
});
it('does not treat transient or invalid media ranges as playable data', () => {
  expect(readBufferedRanges({ length: 1, start: () => 0, end: () => { throw Error('changed'); } })).toEqual([]);
  expect(readBufferedRanges({ length: 1, start: () => 0, end: () => Infinity })).toEqual([]);
});
it('identifies waiting for peers and a paused download only when playback is blocked', () => {
  expect(playbackPhase({ ...media, waiting: true }, { ...source, peers: 0 }, false, false)).toBe('peers');
  expect(playbackPhase({ ...media, waiting: true }, { ...source, status: 'paused' }, false, false)).toBe('downloadPaused');
  expect(playbackPhase(media, { ...source, status: 'paused' }, false, false)).toBe('playing');
});
it('keeps errors and seeking distinct from generic buffering', () => {
  expect(playbackPhase({ ...media, errorCode: 3 }, source, false, true)).toBe('decodeError');
  expect(playbackPhase({ ...media, errorCode: 2 }, source, false, false)).toBe('networkError');
  expect(playbackPhase({ ...media, seeking: true, waiting: true }, source, false, false)).toBe('seeking');
  expect(playbackPhase({ ...media, waiting: true }, { ...source, status: 'error' }, false, false)).toBe('downloadError');
});
it('separates metadata, URL preparation and initial transcode buffering', () => {
  const pending = { ...media, attached: false, readyState: 0 };
  expect(playbackPhase(pending, { ...source, metadataPending: true }, true, false)).toBe('metadata');
  expect(playbackPhase(pending, source, true, false)).toBe('resolving');
  expect(playbackPhase({ ...media, readyState: 0 }, source, false, true)).toBe('preparing');
  expect(playbackPhase({ ...media, waiting: true }, source, false, true)).toBe('buffering');
  expect(playbackPhase({ ...media, waiting: true }, { ...source, metadataPending: true }, false, false)).toBe('buffering');
});
it('does not call a user pause or the end of a file a stall', () => {
  expect(playbackPhase({ ...media, paused: true }, source, false, false)).toBe('paused');
  expect(playbackPhase({ ...media, ended: true }, source, false, false)).toBe('ended');
});
