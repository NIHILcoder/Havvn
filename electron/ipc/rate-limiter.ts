/**
 * IPC Rate Limiter
 * Prevents DoS attacks by limiting the number of IPC calls per time window
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { logger } from '../utils/logger';

const log = logger.child('IPC-RateLimit');

interface RateLimitEntry {
  count: number;
  resetAt: number;
  blockedUntil: number;
}

const rateLimits = new Map<string, RateLimitEntry>();

// Cleanup old entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [channel, entry] of rateLimits.entries()) {
    if (now > entry.resetAt + 60000) { // 1 minute after reset
      rateLimits.delete(channel);
    }
  }
}, 60000);

export interface RateLimitConfig {
  maxCalls: number;
  windowMs: number;
  blockDurationMs?: number; // How long to block after exceeding limit
}

/**
 * Wrap an IPC handler with rate limiting
 */
export function rateLimited<T extends (...args: any[]) => Promise<any>>(
  channel: string,
  config: RateLimitConfig,
  handler: (event: IpcMainInvokeEvent, ...args: Parameters<T>) => ReturnType<T>
): (event: IpcMainInvokeEvent, ...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
  return async (event: IpcMainInvokeEvent, ...args: Parameters<T>): Promise<any> => {
    const now = Date.now();
    const key = channel; // Could add webContents.id for per-window limiting

    let entry = rateLimits.get(key);

    // Check if blocked
    if (entry && entry.blockedUntil > now) {
      const remainingMs = entry.blockedUntil - now;
      log.warn('Rate limit exceeded - blocked', {
        channel,
        remainingMs,
        resetAt: new Date(entry.resetAt).toISOString(),
      });
      throw new Error(
        `Rate limit exceeded for ${channel}. Please try again in ${Math.ceil(remainingMs / 1000)} seconds.`
      );
    }

    // Initialize or reset entry
    if (!entry || now > entry.resetAt) {
      entry = {
        count: 0,
        resetAt: now + config.windowMs,
        blockedUntil: 0,
      };
      rateLimits.set(key, entry);
    }

    // Check rate limit
    if (entry.count >= config.maxCalls) {
      const blockDuration = config.blockDurationMs || config.windowMs;
      entry.blockedUntil = now + blockDuration;

      log.warn('Rate limit exceeded', {
        channel,
        count: entry.count,
        maxCalls: config.maxCalls,
        windowMs: config.windowMs,
        blockedFor: blockDuration,
      });

      throw new Error(
        `Rate limit exceeded for ${channel}. Maximum ${config.maxCalls} calls per ${config.windowMs}ms. ` +
        `Blocked for ${Math.ceil(blockDuration / 1000)} seconds.`
      );
    }

    // Increment counter
    entry.count++;

    // Call handler
    try {
      return await handler(event, ...args);
    } catch (error) {
      // Don't count failed calls against the limit (optional - could be changed)
      entry.count--;
      throw error;
    }
  };
}

/**
 * Pre-configured rate limits for common use cases
 */
export const RateLimitPresets = {
  // Very strict - for sensitive operations
  STRICT: { maxCalls: 5, windowMs: 60000, blockDurationMs: 300000 }, // 5/min, block 5min

  // Standard - for most operations
  STANDARD: { maxCalls: 30, windowMs: 60000, blockDurationMs: 60000 }, // 30/min, block 1min

  // Relaxed - for frequent operations
  RELAXED: { maxCalls: 100, windowMs: 60000, blockDurationMs: 30000 }, // 100/min, block 30s

  // Chat messages - moderate limit
  CHAT: { maxCalls: 10, windowMs: 1000, blockDurationMs: 5000 }, // 10/sec, block 5s

  // File operations - prevent spam
  FILES: { maxCalls: 20, windowMs: 10000, blockDurationMs: 30000 }, // 20/10s, block 30s

  // Settings updates - very limited
  SETTINGS: { maxCalls: 10, windowMs: 60000, blockDurationMs: 120000 }, // 10/min, block 2min

  // Search/query - moderate
  QUERY: { maxCalls: 50, windowMs: 60000, blockDurationMs: 60000 }, // 50/min, block 1min
};

/**
 * Simplified wrapper that uses preset configurations
 */
export function withRateLimit<T extends (...args: any[]) => Promise<any>>(
  channel: string,
  preset: keyof typeof RateLimitPresets,
  handler: (event: IpcMainInvokeEvent, ...args: Parameters<T>) => ReturnType<T>
): (event: IpcMainInvokeEvent, ...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
  return rateLimited(channel, RateLimitPresets[preset], handler);
}

/**
 * Get current rate limit stats (for debugging/monitoring)
 */
export function getRateLimitStats(): Array<{
  channel: string;
  count: number;
  maxCalls: number;
  resetAt: string;
  isBlocked: boolean;
}> {
  const now = Date.now();
  const stats: Array<{
    channel: string;
    count: number;
    maxCalls: number;
    resetAt: string;
    isBlocked: boolean;
  }> = [];

  for (const [channel, entry] of rateLimits.entries()) {
    stats.push({
      channel,
      count: entry.count,
      maxCalls: 0, // Would need to store config to show this
      resetAt: new Date(entry.resetAt).toISOString(),
      isBlocked: entry.blockedUntil > now,
    });
  }

  return stats;
}

/**
 * Clear all rate limit entries (for testing or emergency reset)
 */
export function clearRateLimits(): void {
  rateLimits.clear();
  log.info('All rate limits cleared');
}
