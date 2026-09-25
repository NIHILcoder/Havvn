import { expect, it } from 'vitest';
import { streamStartSeconds, parseStreamStart, streamStartParam, transcodeInputArgs } from './stream-position';
it('round-trips fractional timestamps while rejecting invalid and unbounded input', () => {
  expect(streamStartSeconds(55.123456)).toBe(55.123);
  expect(streamStartParam(55.123456)).toBe('&s=55.123');
  expect(parseStreamStart('55.123')).toBe(55.123);
  expect(parseStreamStart(null)).toBe(0);
  for (const value of [-1, NaN, Infinity, 604801, '2']) expect(() => streamStartSeconds(value)).toThrow();
  for (const value of ['-1', '1e3', 'NaN', '1&x=y', '2.123456']) expect(() => parseStreamStart(value)).toThrow();
});
it('seeks completed disk input quickly and discards frames for non-seekable pipe input', () => {
  expect(transcodeInputArgs('C:/a file.mp4', 15, true)).toEqual(['-ss', '15', '-i', 'C:/a file.mp4']);
  expect(transcodeInputArgs('C:/a file.mkv', 15, false)).toEqual(['-i', 'pipe:0', '-ss', '15']);
  expect(transcodeInputArgs('ignored', 0, false)).toEqual(['-i', 'pipe:0']);
});
