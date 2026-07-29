import { describe, it, expect } from 'vitest';
import { parseTrackers, hasOnlyInvalidTrackers, MAX_CUSTOM_TRACKERS } from './trackers';

describe('parseTrackers', () => {
  it('accepts ws:// and wss:// entries', () => {
    expect(parseTrackers('wss://tracker.example.com')).toEqual(['wss://tracker.example.com']);
    expect(parseTrackers('ws://127.0.0.1:8009')).toEqual(['ws://127.0.0.1:8009']);
    expect(parseTrackers('WSS://Tracker.Example.com')).toEqual(['WSS://Tracker.Example.com']);
  });

  it('splits on commas, newlines and spaces alike', () => {
    const want = ['wss://a.example', 'wss://b.example', 'wss://c.example'];
    expect(parseTrackers('wss://a.example,wss://b.example,wss://c.example')).toEqual(want);
    expect(parseTrackers('wss://a.example\nwss://b.example\nwss://c.example')).toEqual(want);
    expect(parseTrackers('wss://a.example wss://b.example  wss://c.example')).toEqual(want);
    expect(parseTrackers(' wss://a.example , \n wss://b.example ,wss://c.example\n')).toEqual(want);
  });

  it('keeps announce paths and ports intact', () => {
    expect(parseTrackers('wss://tracker.files.fm:7073/announce'))
      .toEqual(['wss://tracker.files.fm:7073/announce']);
  });

  it('drops anything the WebRTC tracker client cannot speak', () => {
    // http/https announce URLs are valid BitTorrent but never carry a WebRTC
    // handshake, so keeping them would present as a broken room, not a bad setting.
    expect(parseTrackers('http://tracker.example.com')).toEqual([]);
    expect(parseTrackers('https://tracker.example.com')).toEqual([]);
    expect(parseTrackers('udp://tracker.example.com:6969')).toEqual([]);
    expect(parseTrackers('turn:relay.example.com:3478')).toEqual([]);
    expect(parseTrackers('tracker.example.com')).toEqual([]);
    expect(parseTrackers('wss://')).toEqual([]);
    expect(parseTrackers('nonsense')).toEqual([]);
  });

  it('keeps the valid entries when mixed with invalid ones', () => {
    expect(parseTrackers('http://bad.example, wss://good.example, nonsense'))
      .toEqual(['wss://good.example']);
  });

  it('drops duplicates, preserving first-seen order', () => {
    expect(parseTrackers('wss://b.example, wss://a.example, wss://b.example'))
      .toEqual(['wss://b.example', 'wss://a.example']);
  });

  it('caps the list at MAX_CUSTOM_TRACKERS', () => {
    const many = Array.from({ length: MAX_CUSTOM_TRACKERS + 5 }, (_, i) => `wss://t${i}.example`);
    const got = parseTrackers(many.join(','));
    expect(got).toHaveLength(MAX_CUSTOM_TRACKERS);
    expect(got).toEqual(many.slice(0, MAX_CUSTOM_TRACKERS));
  });

  it('treats empty, whitespace and missing input as "no list"', () => {
    expect(parseTrackers('')).toEqual([]);
    expect(parseTrackers('   \n  ')).toEqual([]);
    expect(parseTrackers(undefined)).toEqual([]);
  });
});

describe('hasOnlyInvalidTrackers', () => {
  it('flags input the user clearly meant as trackers but that yields nothing', () => {
    expect(hasOnlyInvalidTrackers('tracker.example.com')).toBe(true);
    expect(hasOnlyInvalidTrackers('http://tracker.example.com')).toBe(true);
  });

  it('stays quiet for blank input — that is the documented "use defaults" case', () => {
    expect(hasOnlyInvalidTrackers('')).toBe(false);
    expect(hasOnlyInvalidTrackers('   ')).toBe(false);
    expect(hasOnlyInvalidTrackers(undefined)).toBe(false);
  });

  it('stays quiet when at least one entry survives', () => {
    expect(hasOnlyInvalidTrackers('http://bad.example, wss://good.example')).toBe(false);
  });
});
