import { describe, expect, it } from 'vitest';
import { roomTransferView } from './room-transfer';
import type { RoomTransfer } from './types';

const transfer = (patch: Partial<RoomTransfer> = {}): RoomTransfer => ({
  fileId: 'file', progress: 1, status: 'downloading', downSpeed: 0, peers: 1, haveLocally: false, ...patch,
});
describe('room file action availability', () => {
  it.each(['ciphertext-ready', 'waiting-key', 'decrypting', 'verifying', 'error'] as const)('keeps completed ciphertext unavailable during %s', phase => {
    const view = roomTransferView({ enc: true }, transfer({ phase, cipherReady: true }), false);
    expect(view.ready).toBe(false);
    expect(view.fetch).toBe(false);
    expect(view.retryDecrypt).toBe(!['decrypting', 'verifying'].includes(phase));
  });
  it('offers a download after ciphertext was rejected, even in auto mode', () => {
    expect(roomTransferView({ enc: true }, transfer({ phase: 'error', cipherReady: false }), true)).toMatchObject({ fetch: true, retryDecrypt: false, ready: false });
  });
  it('does not let a stale have flag enable opening during decryption', () => {
    expect(roomTransferView({ enc: true }, transfer({ phase: 'decrypting', haveLocally: true }), false).ready).toBe(false);
  });
  it('enables local actions only after successful plaintext publication, including released files', () => {
    expect(roomTransferView({ enc: true }, transfer({ phase: 'ready', haveLocally: true, released: true }), false)).toMatchObject({ ready: true, retryDecrypt: false, fetch: false });
  });
  it('retains compatibility with ordinary transfers and manual fetch', () => {
    expect(roomTransferView({}, undefined, false).fetch).toBe(true);
    expect(roomTransferView({}, transfer({ status: 'seeding', haveLocally: true }), true).ready).toBe(true);
    expect(roomTransferView({}, transfer({ progress: 0.5 }), true).downloading).toBe(true);
  });
  it('offers resume in auto mode and distinguishes queued work from manual files', () => {
    expect(roomTransferView({}, transfer({ phase: 'paused', receivePaused: true }), true).fetch).toBe(true);
    expect(roomTransferView({}, transfer({ phase: 'queued', queuePosition: 2 }), false).fetch).toBe(false);
  });
});
