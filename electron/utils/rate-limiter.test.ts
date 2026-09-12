/**
 * Rate Limiter Tests
 * Tests for the IPC rate limiting functionality
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimiter, RATE_LIMITS } from '../utils/rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter();
  });

  afterEach(() => {
    limiter.destroy();
    vi.useRealTimers();
  });

  it('should allow calls within the limit', () => {
    const maxRequests = 5;
    const windowMs = 60000;

    for (let i = 0; i < 5; i++) {
      const result = limiter.check('test-key', maxRequests, windowMs);
      expect(result).toBe(true);
    }
  });

  it('should block calls exceeding the limit', () => {
    const maxRequests = 3;
    const windowMs = 60000;

    // Use up the limit
    for (let i = 0; i < 3; i++) {
      limiter.check('test-key', maxRequests, windowMs);
    }

    // Next call should be blocked
    const result = limiter.check('test-key', maxRequests, windowMs);
    expect(result).toBe(false);
  });

  it('should reset after time window expires', () => {
    const maxRequests = 2;
    const windowMs = 10000;

    // Use up the limit
    limiter.check('test-key', maxRequests, windowMs);
    limiter.check('test-key', maxRequests, windowMs);

    // Should be blocked
    expect(limiter.check('test-key', maxRequests, windowMs)).toBe(false);

    // Advance time past the window
    vi.advanceTimersByTime(11000);

    // Should be allowed again
    const result = limiter.check('test-key', maxRequests, windowMs);
    expect(result).toBe(true);
  });

  it('should track different keys independently', () => {
    const maxRequests = 2;
    const windowMs = 60000;

    // Use limit for key1
    limiter.check('key1', maxRequests, windowMs);
    limiter.check('key1', maxRequests, windowMs);

    // key1 should be blocked
    expect(limiter.check('key1', maxRequests, windowMs)).toBe(false);

    // key2 should still be allowed
    expect(limiter.check('key2', maxRequests, windowMs)).toBe(true);
  });

  it('checkOrThrow should throw on rate limit exceeded', () => {
    const maxRequests = 1;
    const windowMs = 60000;

    limiter.checkOrThrow('test-key', maxRequests, windowMs); // Should pass

    expect(() => {
      limiter.checkOrThrow('test-key', maxRequests, windowMs);
    }).toThrow('Rate limit exceeded');
  });

  it('should reset a specific key', () => {
    const maxRequests = 2;
    const windowMs = 60000;

    limiter.check('test-key', maxRequests, windowMs);
    limiter.check('test-key', maxRequests, windowMs);

    // Should be blocked
    expect(limiter.check('test-key', maxRequests, windowMs)).toBe(false);

    // Reset the key
    limiter.reset('test-key');

    // Should be allowed again
    expect(limiter.check('test-key', maxRequests, windowMs)).toBe(true);
  });

  it('should provide accurate status', () => {
    const maxRequests = 5;
    const windowMs = 10000;

    limiter.check('test-key', maxRequests, windowMs);
    limiter.check('test-key', maxRequests, windowMs);
    limiter.check('test-key', maxRequests, windowMs);

    const status = limiter.getStatus('test-key');
    expect(status).not.toBeNull();
    expect(status?.count).toBe(3);
    expect(status?.resetIn).toBeGreaterThan(0);
  });

  it('should clean up old entries', () => {
    const maxRequests = 5;
    const windowMs = 1000;

    limiter.check('test-key', maxRequests, windowMs);

    // Advance time past the window
    vi.advanceTimersByTime(2000);

    // Trigger cleanup
    vi.advanceTimersByTime(300000);

    const status = limiter.getStatus('test-key');
    expect(status).toBeNull(); // Should be cleaned up
  });
});

describe('Pre-configured Rate Limits', () => {
  it('should have sensible limits for expensive operations', () => {
    expect(RATE_LIMITS.CREATE_TORRENT.maxRequests).toBeLessThanOrEqual(10);
    expect(RATE_LIMITS.CREATE_TORRENT.windowMs).toBeGreaterThanOrEqual(60000);
  });

  it('should have stricter limits for search', () => {
    expect(RATE_LIMITS.SEARCH.maxRequests).toBeLessThanOrEqual(20);
    expect(RATE_LIMITS.SEARCH.windowMs).toBeGreaterThanOrEqual(60000);
  });

  it('should allow reasonable chat message rate', () => {
    expect(RATE_LIMITS.SEND_CHAT.maxRequests).toBeGreaterThanOrEqual(10);
    expect(RATE_LIMITS.SEND_CHAT.windowMs).toBeLessThanOrEqual(60000);
  });
});

describe('Fixed Window Behavior', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter();
  });

  afterEach(() => {
    limiter.destroy();
    vi.useRealTimers();
  });

  it('should implement fixed window correctly', () => {
    const maxRequests = 3;
    const windowMs = 10000;

    // t=0: Make 3 calls
    limiter.check('test-key', maxRequests, windowMs);
    limiter.check('test-key', maxRequests, windowMs);
    limiter.check('test-key', maxRequests, windowMs);

    // Should be at limit
    expect(limiter.check('test-key', maxRequests, windowMs)).toBe(false);

    // t=5000: Advance halfway through window
    vi.advanceTimersByTime(5000);

    // Still at limit (calls still within window)
    expect(limiter.check('test-key', maxRequests, windowMs)).toBe(false);

    // t=11000: Advance past first call's window
    vi.advanceTimersByTime(6000);

    // Should allow new calls as old ones expired
    expect(limiter.check('test-key', maxRequests, windowMs)).toBe(true);
  });
});
