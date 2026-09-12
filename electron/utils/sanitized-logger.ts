/**
 * Enhanced logger with sensitive data sanitization
 * Automatically removes IP addresses, tokens, keys, and other sensitive data from logs
 */

import { logger as baseLogger } from './logger';

interface SanitizeOptions {
  enabled: boolean;
  patterns: RegExp[];
  sensitiveKeys: string[];
}

const defaultOptions: SanitizeOptions = {
  enabled: true,
  patterns: [
    // IP addresses (IPv4)
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    // IPv6 addresses
    /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
    // Magnet links
    /magnet:\?[^\s]+/g,
    // Long hex strings (hashes, keys, tokens)
    /\b[A-Fa-f0-9]{32,}\b/g,
    // Base64 tokens (likely sensitive)
    /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
    // Room codes (adj-adj-adj-noun-noun-NNNNN format)
    /\b[a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{5}(?:-e2e)?\b/g,
    // Email addresses
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    // Passwords/tokens/secrets in key-value pairs
    /(password|token|secret|key|apikey|api_key|auth|authorization)[:=]\s*["']?[^"'\s]+/gi,
  ],
  sensitiveKeys: [
    'password',
    'token',
    'secret',
    'key',
    'privateKey',
    'priv',
    'code',
    'invite',
    'apiKey',
    'api_key',
    'auth',
    'authorization',
    'sessionId',
    'memberId',
    'peerId',
    'magnetUri',
    'infoHash',
  ],
};

let sanitizeOptions = { ...defaultOptions };

/**
 * Configure sanitization options
 */
export function configureSanitization(options: Partial<SanitizeOptions>): void {
  sanitizeOptions = {
    ...sanitizeOptions,
    ...options,
    patterns: options.patterns || sanitizeOptions.patterns,
    sensitiveKeys: options.sensitiveKeys || sanitizeOptions.sensitiveKeys,
  };
}

/**
 * Enable or disable log sanitization
 */
export function setSanitizationEnabled(enabled: boolean): void {
  sanitizeOptions.enabled = enabled;
}

/**
 * Sanitize a string by replacing sensitive patterns
 */
function sanitizeString(str: string): string {
  if (!sanitizeOptions.enabled) return str;

  let sanitized = str;

  // Apply all regex patterns
  for (const pattern of sanitizeOptions.patterns) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }

  return sanitized;
}

/**
 * Recursively sanitize an object by removing/masking sensitive keys
 */
function sanitizeObject(obj: any, depth = 0): any {
  if (!sanitizeOptions.enabled) return obj;
  if (depth > 10) return '[MAX_DEPTH]'; // Prevent infinite recursion
  if (obj === null || obj === undefined) return obj;

  // Handle primitives
  if (typeof obj !== 'object') {
    return typeof obj === 'string' ? sanitizeString(obj) : obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, depth + 1));
  }

  // Handle objects
  const sanitized: any = {};

  for (const [key, value] of Object.entries(obj)) {
    const keyLower = key.toLowerCase();

    // Check if this is a sensitive key
    const isSensitive = sanitizeOptions.sensitiveKeys.some(
      sensitiveKey => keyLower.includes(sensitiveKey.toLowerCase())
    );

    if (isSensitive) {
      // Mask the value but keep the key
      if (typeof value === 'string' && value.length > 0) {
        // Show first and last 2 chars for debugging, mask the rest
        const len = value.length;
        if (len <= 4) {
          sanitized[key] = '[REDACTED]';
        } else {
          const first = value.substring(0, 2);
          const last = value.substring(len - 2);
          const masked = '*'.repeat(Math.min(len - 4, 20));
          sanitized[key] = `${first}${masked}${last}`;
        }
      } else {
        sanitized[key] = '[REDACTED]';
      }
    } else if (typeof value === 'object') {
      // Recursively sanitize nested objects
      sanitized[key] = sanitizeObject(value, depth + 1);
    } else if (typeof value === 'string') {
      // Sanitize string values even if key is not sensitive
      sanitized[key] = sanitizeString(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Enhanced logger with automatic sanitization
 */
interface SanitizedLogger {
  debug(component: string, message: string, meta?: Record<string, unknown>): void;
  info(component: string, message: string, meta?: Record<string, unknown>): void;
  warn(component: string, message: string, meta?: Record<string, unknown>): void;
  error(component: string, message: string, meta?: Record<string, unknown>): void;
  unsanitized: typeof baseLogger;
  configure: typeof configureSanitization;
  setEnabled: typeof setSanitizationEnabled;
}
export const sanitizedLogger: SanitizedLogger = {
  debug: (component: string, message: string, meta?: Record<string, any>) => {
    const sanitizedMessage = sanitizeString(message);
    const sanitizedMeta = meta ? sanitizeObject(meta) : undefined;
    baseLogger.debug(component, sanitizedMessage, sanitizedMeta);
  },

  info: (component: string, message: string, meta?: Record<string, any>) => {
    const sanitizedMessage = sanitizeString(message);
    const sanitizedMeta = meta ? sanitizeObject(meta) : undefined;
    baseLogger.info(component, sanitizedMessage, sanitizedMeta);
  },

  warn: (component: string, message: string, meta?: Record<string, any>) => {
    const sanitizedMessage = sanitizeString(message);
    const sanitizedMeta = meta ? sanitizeObject(meta) : undefined;
    baseLogger.warn(component, sanitizedMessage, sanitizedMeta);
  },

  error: (component: string, message: string, meta?: Record<string, any>) => {
    const sanitizedMessage = sanitizeString(message);
    const sanitizedMeta = meta ? sanitizeObject(meta) : undefined;
    baseLogger.error(component, sanitizedMessage, sanitizedMeta);
  },

  // For cases where you explicitly need unsanitized logging (use with caution)
  unsanitized: baseLogger,

  // Configuration
  configure: configureSanitization,
  setEnabled: setSanitizationEnabled,
};

// Export as default logger
export default sanitizedLogger;

/**
 * Helper to sanitize error objects
 */
export function sanitizeError(error: Error): {
  name: string;
  message: string;
  stack?: string;
} {
  return {
    name: error.name,
    message: sanitizeString(error.message),
    stack: error.stack ? sanitizeString(error.stack) : undefined,
  };
}

/**
 * Helper to create a safe log context object
 */
export function createSafeContext(context: Record<string, any>): Record<string, any> {
  return sanitizeObject(context);
}
