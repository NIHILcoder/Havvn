import { describe, expect, it } from 'vitest';
import path from 'path';
import { validateFilePath, validatePort, validateRoomCode, validateInfoHash, validateUrl } from './validation';
import { validateChatMessage, validateTrackerUrl, validateFileName } from './security';

// Exercise exported production validators rather than the removed validation API.
describe('file path boundaries', () => {
  it.each(['../secret', 'downloads/../secret', 'downloads\\..\\secret', 'file\0.txt'])('rejects unsafe input %j', value => {
    expect(() => validateFilePath(value)).toThrow();
  });
  it('enforces roots without accepting a sibling prefix', () => {
    const root = path.resolve('downloads');
    expect(validateFilePath(path.join(root, 'file'), [root])).toBe(path.join(root, 'file'));
    expect(() => validateFilePath(path.resolve('downloads-other/file'), [root])).toThrow();
    expect(() => validateFilePath(path.resolve('secret'), [root])).toThrow();
  });
  it('accepts filename dots and normalizes current-directory segments', () => {
    expect(validateFilePath('file..txt')).toBe('file..txt');
    expect(validateFilePath('downloads/./file')).toBe(path.normalize('downloads/file'));
  });
});
describe('numeric and protocol validation', () => {
  it.each(['80junk', '1.5', '', ' ', NaN, Infinity, 0, 65536])('rejects invalid port %j', value => {
    expect(() => validatePort(value)).toThrow();
  });
  it.each([1, 65535, '8080'])('accepts complete port %j', value => expect(validatePort(value)).toBe(Number(value)));
  it.each(['swift-amber-otter-comet-4821', 'swift-amber-calm-otter-comet-48219-e2e'])(
    'accepts supported invite %s', code => expect(validateRoomCode(code)).toBe(code));
  it('validates hashes and URL schemes', () => {
    expect(validateInfoHash('A'.repeat(40))).toBe('a'.repeat(40));
    expect(() => validateInfoHash('xyz')).toThrow();
    expect(() => validateUrl('file:///secret')).toThrow();
    expect(() => validateUrl('not a url')).toThrow();
  });
});
describe('IPC security contracts', () => {
  it.each(['http://169.254.169.254', 'http://[fc00::1]', 'http://[fe80::1]', 'http://[::ffff:127.0.0.1]', 'http://localhost', 'http://127.1', 'http://10.0.0.1', 'http://172.31.1.1', 'http://192.168.1.1', 'http://[::1]', 'file:///secret'])(
    'rejects unsafe tracker %s', url => expect(() => validateTrackerUrl(url)).toThrow());
  it.each(['https://tracker.example.com/announce', 'udp://tracker.example.com:6969', 'wss://tracker.example.com'])(
    'accepts public tracker syntax %s', url => expect(() => validateTrackerUrl(url)).not.toThrow());
  it('rejects empty and oversized messages', () => {
    expect(() => validateChatMessage(' ')).toThrow();
    expect(() => validateChatMessage('x'.repeat(10001))).toThrow();
    expect(() => validateChatMessage('Привет 🌍')).not.toThrow();
  });
  it.each(['../file', 'dir/file', '..', 'CON.txt', 'file\0.txt', 'a'.repeat(256)])('rejects unsafe filename %j', name => {
    expect(() => validateFileName(name)).toThrow();
  });
});
