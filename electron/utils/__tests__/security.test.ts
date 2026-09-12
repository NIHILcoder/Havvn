import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateTorrentId,
  validateDownloadId,
  validateRoomId,
  validateChatMessage,
  validateTrackerUrl,
  validateDownloadPath,
  safeCompare,
  generateSecureToken,
  validateMagnetUri,
  validatePort,
  validateFileName,
} from '../security';

describe('Security Validators', () => {
  describe('validateTorrentId', () => {
    it('should accept valid 40-char hex string', () => {
      const valid = 'a'.repeat(40);
      expect(() => validateTorrentId(valid)).not.toThrow();
    });

    it('should accept uppercase hex', () => {
      const valid = 'A'.repeat(40);
      expect(() => validateTorrentId(valid)).not.toThrow();
    });

    it('should reject invalid length', () => {
      expect(() => validateTorrentId('abc123')).toThrow('Invalid torrent ID format');
    });

    it('should reject non-hex characters', () => {
      const invalid = 'z' + 'a'.repeat(39);
      expect(() => validateTorrentId(invalid)).toThrow('Invalid torrent ID format');
    });

    it('should reject non-string', () => {
      expect(() => validateTorrentId(12345)).toThrow('Invalid torrent ID format');
    });

    it('should reject null', () => {
      expect(() => validateTorrentId(null)).toThrow('Invalid torrent ID format');
    });
  });

  describe('validateRoomId', () => {
    it('should accept valid alphanumeric id', () => {
      expect(() => validateRoomId('room_123-abc')).not.toThrow();
    });

    it('should reject empty string', () => {
      expect(() => validateRoomId('')).toThrow('Invalid room ID');
    });

    it('should reject too long id', () => {
      const long = 'a'.repeat(101);
      expect(() => validateRoomId(long)).toThrow('Invalid room ID');
    });

    it('should reject invalid characters', () => {
      expect(() => validateRoomId('room@123')).toThrow('Room ID contains invalid characters');
    });

    it('should reject non-string', () => {
      expect(() => validateRoomId(123)).toThrow('Invalid room ID');
    });
  });

  describe('validateChatMessage', () => {
    it('should accept valid message', () => {
      expect(() => validateChatMessage('Hello world!')).not.toThrow();
    });

    it('should reject empty message', () => {
      expect(() => validateChatMessage('')).toThrow('Message cannot be empty');
    });

    it('should reject whitespace-only message', () => {
      expect(() => validateChatMessage('   ')).toThrow('Message cannot be empty');
    });

    it('should reject message longer than 10000 chars', () => {
      const long = 'a'.repeat(10001);
      expect(() => validateChatMessage(long)).toThrow('Message too long');
    });

    it('should accept message with exactly 10000 chars', () => {
      const exact = 'a'.repeat(10000);
      expect(() => validateChatMessage(exact)).not.toThrow();
    });

    it('should reject non-string', () => {
      expect(() => validateChatMessage(123)).toThrow('Message must be a string');
    });
  });

  describe('validateTrackerUrl', () => {
    it('should accept valid HTTP tracker', () => {
      expect(() => validateTrackerUrl('http://tracker.example.com:8080/announce')).not.toThrow();
    });

    it('should accept valid HTTPS tracker', () => {
      expect(() => validateTrackerUrl('https://tracker.example.com/announce')).not.toThrow();
    });

    it('should accept valid UDP tracker', () => {
      expect(() => validateTrackerUrl('udp://tracker.example.com:6969')).not.toThrow();
    });

    it('should accept valid WebSocket tracker', () => {
      expect(() => validateTrackerUrl('wss://tracker.example.com:8080')).not.toThrow();
    });

    it('should reject localhost', () => {
      expect(() => validateTrackerUrl('http://localhost:8080/announce')).toThrow('Local tracker URLs are not allowed');
    });

    it('should reject 127.0.0.1', () => {
      expect(() => validateTrackerUrl('http://127.0.0.1:8080/announce')).toThrow('Local tracker URLs are not allowed');
    });

    it('should reject 192.168.x.x', () => {
      expect(() => validateTrackerUrl('http://192.168.1.1/announce')).toThrow('Local tracker URLs are not allowed');
    });

    it('should reject 10.x.x.x', () => {
      expect(() => validateTrackerUrl('http://10.0.0.1/announce')).toThrow('Local tracker URLs are not allowed');
    });

    it('should reject invalid protocol', () => {
      expect(() => validateTrackerUrl('ftp://tracker.example.com')).toThrow('Protocol ftp: not allowed');
    });

    it('should reject non-string', () => {
      expect(() => validateTrackerUrl(123)).toThrow('Tracker URL must be a string');
    });

    it('should reject malformed URL', () => {
      expect(() => validateTrackerUrl('not a url')).toThrow('Invalid tracker URL');
    });
  });

  describe('validateDownloadPath', () => {
    it('should accept valid path', () => {
      expect(() => validateDownloadPath('C:\\Users\\User\\Downloads')).not.toThrow();
    });

    it('should normalize path', () => {
      const result = validateDownloadPath('C:\\Users\\User\\Downloads\\.');
      expect(result).not.toContain('\\.');
    });

    it('should reject path traversal with ..', () => {
      expect(() => validateDownloadPath('C:\\Users\\..\\..\\Windows')).toThrow('Path traversal detected');
    });

    it('should reject Windows system directory', () => {
      expect(() => validateDownloadPath('C:\\Windows\\System32')).toThrow('Access to system directory denied');
    });

    it('should reject Program Files', () => {
      expect(() => validateDownloadPath('C:\\Program Files\\Something')).toThrow('Access to system directory denied');
    });

    it('should reject empty path', () => {
      expect(() => validateDownloadPath('')).toThrow('Path cannot be empty');
    });

    it('should reject non-string', () => {
      expect(() => validateDownloadPath(123)).toThrow('Path must be a string');
    });
  });

  describe('safeCompare', () => {
    it('should return true for equal strings', () => {
      expect(safeCompare('abc123', 'abc123')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(safeCompare('abc123', 'abc124')).toBe(false);
    });

    it('should return false for different lengths', () => {
      expect(safeCompare('abc', 'abcd')).toBe(false);
    });

    it('should be case-sensitive', () => {
      expect(safeCompare('abc', 'ABC')).toBe(false);
    });

    it('should handle unicode strings', () => {
      expect(safeCompare('привет', 'привет')).toBe(true);
      expect(safeCompare('привет', 'приветик')).toBe(false);
    });
  });

  describe('generateSecureToken', () => {
    it('should generate token of correct length', () => {
      const token = generateSecureToken(32);
      expect(token).toHaveLength(64); // 32 байта = 64 hex символа
    });

    it('should generate unique tokens', () => {
      const token1 = generateSecureToken(32);
      const token2 = generateSecureToken(32);
      expect(token1).not.toBe(token2);
    });

    it('should generate only hex characters', () => {
      const token = generateSecureToken(32);
      expect(token).toMatch(/^[0-9a-f]+$/);
    });

    it('should handle different lengths', () => {
      const token16 = generateSecureToken(16);
      const token64 = generateSecureToken(64);
      expect(token16).toHaveLength(32);
      expect(token64).toHaveLength(128);
    });

    it('should use default length', () => {
      const token = generateSecureToken();
      expect(token).toHaveLength(64); // default 32 bytes
    });
  });

  describe('validateMagnetUri', () => {
    it('should accept valid magnet URI', () => {
      const valid = 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=test';
      expect(() => validateMagnetUri(valid)).not.toThrow();
    });

    it('should reject non-magnet URI', () => {
      expect(() => validateMagnetUri('http://example.com')).toThrow('Invalid magnet URI format');
    });

    it('should reject magnet without info hash', () => {
      expect(() => validateMagnetUri('magnet:?dn=test')).toThrow('Magnet URI must contain info hash');
    });

    it('should reject non-string', () => {
      expect(() => validateMagnetUri(123)).toThrow('Magnet URI must be a string');
    });
  });

  describe('validatePort', () => {
    it('should accept valid port', () => {
      expect(() => validatePort(8080)).not.toThrow();
    });

    it('should accept port 1024', () => {
      expect(() => validatePort(1024)).not.toThrow();
    });

    it('should accept port 65535', () => {
      expect(() => validatePort(65535)).not.toThrow();
    });

    it('should reject port below 1024', () => {
      expect(() => validatePort(80)).toThrow('Port must be between 1024 and 65535');
    });

    it('should reject port above 65535', () => {
      expect(() => validatePort(65536)).toThrow('Port must be between 1024 and 65535');
    });

    it('should reject non-integer', () => {
      expect(() => validatePort(8080.5)).toThrow('Port must be an integer');
    });

    it('should reject non-number', () => {
      expect(() => validatePort('8080')).toThrow('Port must be an integer');
    });
  });

  describe('validateFileName', () => {
    it('should accept valid file name', () => {
      expect(() => validateFileName('document.pdf')).not.toThrow();
    });

    it('should reject empty name', () => {
      expect(() => validateFileName('')).toThrow('File name cannot be empty');
    });

    it('should reject name longer than 255 chars', () => {
      const long = 'a'.repeat(256);
      expect(() => validateFileName(long)).toThrow('File name too long');
    });

    it('should reject invalid characters', () => {
      expect(() => validateFileName('file<>.txt')).toThrow('File name contains invalid characters');
      expect(() => validateFileName('file|name.txt')).toThrow('File name contains invalid characters');
      expect(() => validateFileName('file?.txt')).toThrow('File name contains invalid characters');
    });

    it('should reject reserved names', () => {
      expect(() => validateFileName('CON')).toThrow('File name is reserved by system');
      expect(() => validateFileName('PRN.txt')).toThrow('File name is reserved by system');
      expect(() => validateFileName('AUX')).toThrow('File name is reserved by system');
      expect(() => validateFileName('COM1')).toThrow('File name is reserved by system');
    });

    it('should reject non-string', () => {
      expect(() => validateFileName(123)).toThrow('File name must be a string');
    });
  });
});

 describe('Download IDs', () => {
  it('accepts persisted UUIDs and rejects info hashes and paths', () => {
    expect(() => validateDownloadId('12345678-1234-4123-8123-123456789abc')).not.toThrow();
    expect(() => validateDownloadId('a'.repeat(40))).toThrow();
    expect(() => validateDownloadId('../downloads')).toThrow();
  });
});
