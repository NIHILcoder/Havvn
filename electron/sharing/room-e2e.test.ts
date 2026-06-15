import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { encryptFile, decryptFile, generateRoomSecret } from './room-e2e';

let dir: string;
const plain = () => path.join(dir, 'movie.bin');
const cipher = () => path.join(dir, 'movie.enc');
const out = () => path.join(dir, 'movie.out');

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-test-'));
  // ~3 MB + odd tail so it spans many cipher blocks and a partial one.
  fs.writeFileSync(plain(), crypto.randomBytes(3 * 1024 * 1024 + 777));
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('room-e2e', () => {
  it('generates a 32-byte (256-bit) hex secret', () => {
    expect(Buffer.from(generateRoomSecret(), 'hex')).toHaveLength(32);
  });

  it('round-trips a file unchanged with a 28-byte overhead (iv+tag)', async () => {
    const secret = generateRoomSecret();
    await encryptFile(plain(), cipher(), secret);
    await decryptFile(cipher(), out(), secret);
    expect(fs.readFileSync(out()).equals(fs.readFileSync(plain()))).toBe(true);
    expect(fs.statSync(cipher()).size - fs.statSync(plain()).size).toBe(28);
  });

  it('rejects a tampered ciphertext (GCM auth tag)', async () => {
    const secret = generateRoomSecret();
    await encryptFile(plain(), cipher(), secret);
    const buf = fs.readFileSync(cipher()); buf[100] ^= 0xff; fs.writeFileSync(cipher(), buf);
    await expect(decryptFile(cipher(), out(), secret)).rejects.toThrow();
  });

  it('rejects the wrong key', async () => {
    const secret = generateRoomSecret();
    await encryptFile(plain(), cipher(), secret);
    await expect(decryptFile(cipher(), out(), generateRoomSecret())).rejects.toThrow();
  });
});
