import { describe, expect, it } from 'vitest';
import type { RoomFile, RoomTransfer } from '../../../shared/types';
import { roomFileReceiveActions, selectRoomFiles } from './roomFileSelection';

const order = ['a', 'b', 'c', 'd', 'e'];
describe('room file selection', () => {
  it('toggles a file without mutating other selections or the input set', () => {
    const selected = new Set(['a', 'c']);
    expect([...selectRoomFiles(selected, order, 'a', 'b')]).toEqual(['a', 'c', 'b']);
    expect([...selectRoomFiles(selected, order, 'a', 'c')]).toEqual(['a']);
    expect([...selected]).toEqual(['a', 'c']);
  });
  it('replaces the selection on an ordinary row click, preserving Shift ranges', () => {
    const selected = new Set(['a', 'e']);
    expect([...selectRoomFiles(selected, order, 'a', 'c', { replace: true })]).toEqual(['c']);
    expect([...selectRoomFiles(selected, order, 'a', 'c', { replace: true, range: true })]).toEqual(['a', 'b', 'c']);
    expect([...selected]).toEqual(['a', 'e']);
  });
  it('selects a range in both directions, replacing the previous range', () => {
    const selected = new Set(['e']);
    expect([...selectRoomFiles(selected, order, 'b', 'd', { range: true })]).toEqual(['b', 'c', 'd']);
    expect([...selectRoomFiles(selected, order, 'd', 'b', { range: true })]).toEqual(['b', 'c', 'd']);
  });
  it('adds a Ctrl+Shift range to an existing selection', () => {
    expect([...selectRoomFiles(new Set(['e']), order, 'a', 'c', { range: true, additive: true })]).toEqual(['e', 'a', 'b', 'c']);
  });
  it('uses current displayed order and excludes filtered/collapsed files', () => {
    expect([...selectRoomFiles(new Set(), ['e', 'c', 'a'], 'e', 'a', { range: true })]).toEqual(['e', 'c', 'a']);
    expect([...selectRoomFiles(new Set(['e']), ['a', 'b'], 'e', 'b', { range: true })]).toEqual(['b']);
    expect([...selectRoomFiles(new Set(['a']), ['a'], 'a', 'removed')]).toEqual(['a']);
  });
  it('keeps an already selected target selected when Shift has no valid anchor', () => {
    expect([...selectRoomFiles(new Set(['b']), order, null, 'b', { range: true })]).toEqual(['b']);
  });
});

describe('bulk receive eligibility', () => {
  const file = (fileId: string, enc = false) => ({ fileId, enc: enc ? {} : undefined }) as RoomFile;
  const transfer = (patch: Partial<RoomTransfer>) => patch as RoomTransfer;
  it('downloads only missing/paused files and pauses only downloads or queued work', () => {
    const files = ['local', 'missing', 'paused', 'active', 'queued', 'verifying', 'decrypting', 'failed'].map(id => file(id));
    const transfers = {
      local: transfer({ haveLocally: true, phase: 'ready' }), paused: transfer({ phase: 'paused' }),
      active: transfer({ phase: 'downloading' }), queued: transfer({ phase: 'queued', queuePosition: 2 }),
      verifying: transfer({ phase: 'verifying' }), decrypting: transfer({ phase: 'decrypting' }), failed: transfer({ phase: 'error' }),
    };
    expect(roomFileReceiveActions(files, transfers, false, new Set(files.map(f => f.fileId))))
      .toEqual({ fetch: ['missing', 'paused', 'failed'], pause: ['active', 'queued'] });
  });
  it('honors selection, removed ids and automatic reception', () => {
    const files = [file('a'), file('b')];
    expect(roomFileReceiveActions(files, {}, false, new Set(['b', 'deleted']))).toEqual({ fetch: ['b'], pause: [] });
    expect(roomFileReceiveActions(files, {}, true, new Set(['a', 'b']))).toEqual({ fetch: [], pause: [] });
  });
  it('does not start another fetch for ciphertext awaiting decryption', () => {
    expect(roomFileReceiveActions([file('cipher', true)], { cipher: transfer({ phase: 'error', cipherReady: true }) }, false, new Set(['cipher'])))
      .toEqual({ fetch: [], pause: [] });
  });
});
