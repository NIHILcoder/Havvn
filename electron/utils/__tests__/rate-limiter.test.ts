import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RateLimiter, RATE_LIMITS, createWebContentsKey } from '../rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  afterEach(() => {
    limiter.destroy();
  });

  describe('check', () => {
    it('should allow requests within limit', () => {
      for (let i = 0; i < 10; i++) {
        expect(limiter.check('test:key', 10, 60000)).toBe(true);
      }
    });

    it('should block requests exceeding limit', () => {
      // Использовать 10 запросов
      for (let i = 0; i < 10; i++) {
        limiter.check('test:key', 10, 60000);
      }

      // 11-й должен быть заблокирован
      expect(limiter.check('test:key', 10, 60000)).toBe(false);
    });

    it('should reset after window expires', async () => {
      // Использовать лимит
      for (let i = 0; i < 10; i++) {
        limiter.check('test:key', 10, 100);
      }

      expect(limiter.check('test:key', 10, 100)).toBe(false);

      // Подождать истечения окна
      await new Promise(resolve => setTimeout(resolve, 150));

      // Должно снова разрешить
      expect(limiter.check('test:key', 10, 100)).toBe(true);
    });

    it('should track different keys independently', () => {
      limiter.check('key1', 5, 60000);
      limiter.check('key1', 5, 60000);
      limiter.check('key2', 5, 60000);

      expect(limiter.check('key1', 5, 60000)).toBe(true);
      expect(limiter.check('key2', 5, 60000)).toBe(true);
    });
  });

  describe('checkOrThrow', () => {
    it('should not throw when within limit', () => {
      expect(() => {
        limiter.checkOrThrow('test:key', 10, 60000);
      }).not.toThrow();
    });

    it('should throw when limit exceeded', () => {
      for (let i = 0; i < 10; i++) {
        limiter.checkOrThrow('test:key', 10, 60000);
      }

      expect(() => {
        limiter.checkOrThrow('test:key', 10, 60000);
      }).toThrow('Rate limit exceeded');
    });
  });

  describe('reset', () => {
    it('should reset counter for key', () => {
      for (let i = 0; i < 10; i++) {
        limiter.check('test:key', 10, 60000);
      }

      expect(limiter.check('test:key', 10, 60000)).toBe(false);

      limiter.reset('test:key');

      expect(limiter.check('test:key', 10, 60000)).toBe(true);
    });
  });

  describe('getStatus', () => {
    it('should return null for unknown key', () => {
      expect(limiter.getStatus('unknown:key')).toBeNull();
    });

    it('should return status for tracked key', () => {
      limiter.check('test:key', 10, 60000);
      limiter.check('test:key', 10, 60000);

      const status = limiter.getStatus('test:key');

      expect(status).not.toBeNull();
      expect(status?.count).toBe(2);
      expect(status?.resetIn).toBeGreaterThan(0);
      expect(status?.resetIn).toBeLessThanOrEqual(60000);
    });
  });
});

describe('createWebContentsKey', () => {
  it('should create unique key from action and id', () => {
    const key = createWebContentsKey('downloads:add', 123);
    expect(key).toBe('downloads:add:123');
  });

  it('should create different keys for different ids', () => {
    const key1 = createWebContentsKey('downloads:add', 123);
    const key2 = createWebContentsKey('downloads:add', 456);
    expect(key1).not.toBe(key2);
  });

  it('should create different keys for different actions', () => {
    const key1 = createWebContentsKey('downloads:add', 123);
    const key2 = createWebContentsKey('downloads:remove', 123);
    expect(key1).not.toBe(key2);
  });
});

describe('RATE_LIMITS', () => {
  it('should have defined limits for common operations', () => {
    expect(RATE_LIMITS.ADD_DOWNLOAD).toBeDefined();
    expect(RATE_LIMITS.REMOVE_DOWNLOAD).toBeDefined();
    expect(RATE_LIMITS.CREATE_ROOM).toBeDefined();
    expect(RATE_LIMITS.JOIN_ROOM).toBeDefined();
    expect(RATE_LIMITS.SEND_CHAT).toBeDefined();
    expect(RATE_LIMITS.SEARCH).toBeDefined();
    expect(RATE_LIMITS.CREATE_TORRENT).toBeDefined();
  });

  it('should have reasonable limits', () => {
    // Загрузки должны быть ограничены разумно
    expect(RATE_LIMITS.ADD_DOWNLOAD.maxRequests).toBeGreaterThan(0);
    expect(RATE_LIMITS.ADD_DOWNLOAD.maxRequests).toBeLessThan(100);

    // Чат должен позволять нормальное общение
    expect(RATE_LIMITS.SEND_CHAT.maxRequests).toBeGreaterThan(10);

    // Создание комнат должно быть строго ограничено
    expect(RATE_LIMITS.CREATE_ROOM.maxRequests).toBeLessThan(10);
  });
});
