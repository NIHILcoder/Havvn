/**
 * Security Tests
 * Tests for common vulnerabilities and attack vectors
 */

import { describe, it, expect } from 'vitest';
import {
  validatePath,
  validateDownloadPath,
  validateTrackerUrl,
  validateMagnetUri,
  validateRoomId,
  validateMemberId,
  validateChatMessage,
  sanitizeFilename,
  validatePort,
} from '../utils/validation';

describe('Security: Path Traversal', () => {
  it('should reject paths with ..', () => {
    expect(() => validatePath('../../etc/passwd')).toThrow('suspicious patterns');
    expect(() => validatePath('../config')).toThrow('suspicious patterns');
    expect(() => validatePath('data/../../../etc/passwd')).toThrow('suspicious patterns');
  });

  it('should reject paths with null bytes', () => {
    expect(() => validatePath('/path/to/file\0.txt')).toThrow('suspicious patterns');
  });

  it('should normalize paths correctly', () => {
    const normalized = validatePath('/some/path/./to/file.txt');
    expect(normalized).not.toContain('./');
  });

  it('should enforce allowed directories', () => {
    const allowedDirs = ['/home/user/downloads'];

    expect(() => validatePath('/etc/passwd', allowedDirs)).toThrow('not allowed');
    expect(() => validatePath('/tmp/file', allowedDirs)).toThrow('not allowed');

    // Should work for paths within allowed dirs
    const validPath = validatePath('/home/user/downloads/file.txt', allowedDirs);
    expect(validPath).toContain('downloads');
  });
});

describe('Security: SSRF Prevention', () => {
  it('should block localhost URLs', () => {
    expect(() => validateTrackerUrl('http://localhost:8080')).toThrow('localhost not allowed');
    expect(() => validateTrackerUrl('http://127.0.0.1:8080')).toThrow('localhost not allowed');
    expect(() => validateTrackerUrl('http://[::1]:8080')).toThrow('localhost not allowed');
  });

  it('should block private IP ranges (RFC 1918)', () => {
    expect(() => validateTrackerUrl('http://10.0.0.1')).toThrow('private IP');
    expect(() => validateTrackerUrl('http://172.16.0.1')).toThrow('private IP');
    expect(() => validateTrackerUrl('http://192.168.1.1')).toThrow('private IP');
    expect(() => validateTrackerUrl('http://169.254.1.1')).toThrow('private IP');
  });

  it('should block link-local addresses', () => {
    expect(() => validateTrackerUrl('http://169.254.169.254')).toThrow('private IP');
  });

  it('should allow valid public tracker URLs', () => {
    expect(validateTrackerUrl('http://tracker.example.com:6969/announce')).toBe('http://tracker.example.com:6969/announce');
    expect(validateTrackerUrl('https://tracker.example.com/announce')).toBe('https://tracker.example.com/announce');
    expect(validateTrackerUrl('udp://tracker.example.com:6969')).toBe('udp://tracker.example.com:6969');
    expect(validateTrackerUrl('wss://tracker.example.com')).toBe('wss://tracker.example.com');
  });

  it('should reject unsafe protocols', () => {
    expect(() => validateTrackerUrl('file:///etc/passwd')).toThrow('Invalid tracker protocol');
    expect(() => validateTrackerUrl('ftp://tracker.example.com')).toThrow('Invalid tracker protocol');
    expect(() => validateTrackerUrl('javascript:alert(1)')).toThrow('Invalid tracker protocol');
  });

  it('should reject malformed URLs', () => {
    expect(() => validateTrackerUrl('not a url')).toThrow('malformed URL');
    expect(() => validateTrackerUrl('http://')).toThrow('malformed URL');
  });

  it('should reject overly long URLs', () => {
    const longUrl = 'http://example.com/' + 'a'.repeat(3000);
    expect(() => validateTrackerUrl(longUrl)).toThrow('exceeds maximum length');
  });
});

describe('Security: Input Validation', () => {
  it('should validate magnet URIs correctly', () => {
    const validMagnet = 'magnet:?xt=urn:btih:abc123';
    expect(validateMagnetUri(validMagnet)).toBe(validMagnet);
  });

  it('should reject invalid magnet URIs', () => {
    expect(() => validateMagnetUri('not a magnet')).toThrow('must start with');
    expect(() => validateMagnetUri('magnet:?')).toThrow('missing info hash');
    expect(() => validateMagnetUri('magnet:?dn=test')).toThrow('missing info hash');
  });

  it('should validate room IDs correctly', () => {
    const validUuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(validateRoomId(validUuid)).toBe(validUuid);
  });

  it('should reject invalid room IDs', () => {
    expect(() => validateRoomId('not-a-uuid')).toThrow('incorrect format');
    expect(() => validateRoomId('550e8400-e29b-31d4-a716-446655440000')).toThrow('incorrect format'); // Not v4
    expect(() => validateRoomId('')).toThrow('must be a non-empty string');
  });

  it('should validate member IDs correctly', () => {
    const validMemberId = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';
    expect(validateMemberId(validMemberId)).toBe(validMemberId);
  });

  it('should reject invalid member IDs', () => {
    expect(() => validateMemberId('short')).toThrow('incorrect length');
    expect(() => validateMemberId('z'.repeat(32))).toThrow('must be 32 hex characters');
  });

  it('should sanitize chat messages', () => {
    const msg = validateChatMessage('Hello\0World');
    expect(msg).not.toContain('\0');
    expect(msg).toBe('HelloWorld');
  });

  it('should reject oversized chat messages', () => {
    const longMsg = 'a'.repeat(10001);
    expect(() => validateChatMessage(longMsg)).toThrow('exceeds maximum length');
  });

  it('should reject empty chat messages', () => {
    expect(() => validateChatMessage('')).toThrow('cannot be empty');
  });
});

describe('Security: Filename Sanitization', () => {
  it('should remove path separators', () => {
    expect(sanitizeFilename('../../etc/passwd')).not.toContain('/');
    expect(sanitizeFilename('..\\..\\windows\\system32')).not.toContain('\\');
  });

  it('should remove null bytes', () => {
    expect(sanitizeFilename('file\0.txt')).not.toContain('\0');
  });

  it('should handle dots correctly', () => {
    expect(sanitizeFilename('...file')).not.toMatch(/^\./);
    expect(sanitizeFilename('file...')).not.toMatch(/\.$/);
    expect(sanitizeFilename('file...name')).toBe('file.name');
  });

  it('should limit filename length', () => {
    const longName = 'a'.repeat(300);
    const sanitized = sanitizeFilename(longName);
    expect(sanitized.length).toBeLessThanOrEqual(255);
  });

  it('should reject filenames that become empty', () => {
    expect(() => sanitizeFilename('...')).toThrow('empty string');
    expect(() => sanitizeFilename('///')).toThrow('empty string');
  });
});

describe('Security: Port Validation', () => {
  it('should accept valid ports', () => {
    expect(validatePort(8080)).toBe(8080);
    expect(validatePort(3000)).toBe(3000);
    expect(validatePort(65535)).toBe(65535);
  });

  it('should reject invalid ports', () => {
    expect(() => validatePort(0)).toThrow();
    expect(() => validatePort(-1)).toThrow();
    expect(() => validatePort(65536)).toThrow();
    expect(() => validatePort(99999)).toThrow();
  });

  it('should handle non-numeric input', () => {
    expect(() => validatePort('8080')).toThrow('must be a finite number');
    expect(() => validatePort(NaN)).toThrow('must be a finite number');
    expect(() => validatePort(Infinity)).toThrow('must be a finite number');
  });
});

describe('Security: XSS Prevention', () => {
  it('should handle special characters in chat messages', () => {
    const xssAttempt = '<script>alert("XSS")</script>';
    const sanitized = validateChatMessage(xssAttempt);
    // Should pass through - renderer is responsible for escaping
    expect(sanitized).toBe(xssAttempt);
  });

  it('should handle unicode and emojis', () => {
    const msg = validateChatMessage('Hello 👋 世界 🌍');
    expect(msg).toContain('👋');
    expect(msg).toContain('世界');
  });
});

describe('Security: Type Safety', () => {
  it('should reject wrong types for paths', () => {
    expect(() => validatePath(null as any)).toThrow('must be a non-empty string');
    expect(() => validatePath(undefined as any)).toThrow('must be a non-empty string');
    expect(() => validatePath(123 as any)).toThrow('must be a non-empty string');
    expect(() => validatePath({} as any)).toThrow('must be a non-empty string');
  });

  it('should reject wrong types for URLs', () => {
    expect(() => validateTrackerUrl(null as any)).toThrow('must be a non-empty string');
    expect(() => validateTrackerUrl([] as any)).toThrow('must be a non-empty string');
  });

  it('should reject wrong types for numbers', () => {
    expect(() => validatePort('not a number' as any)).toThrow('must be a finite number');
    expect(() => validatePort({} as any)).toThrow('must be a finite number');
  });
});
