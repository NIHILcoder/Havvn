/**
 * Privacy-Aware Logger Utility
 *
 * Sanitizes sensitive data before logging to prevent privacy leaks
 */

import { createHash } from 'crypto';

export class PrivacyLogger {
  private originalLogger: any;
  private sensitiveFields = [
    'userId', 'peerId', 'ip', 'ipAddress', 'hostname',
    'email', 'username', 'password', 'token', 'apiKey',
    'infoHash', 'magnetUri', 'torrentPath'
  ];

  constructor(logger: any) {
    this.originalLogger = logger;
  }

  /**
   * Sanitize sensitive data recursively
   */
  private sanitize(data: any): any {
    if (data === null || data === undefined) {
      return data;
    }

    // Handle primitives
    if (typeof data !== 'object') {
      return data;
    }

    // Handle arrays
    if (Array.isArray(data)) {
      return data.map(item => this.sanitize(item));
    }

    // Handle objects
    const sanitized: any = {};
    for (const [key, value] of Object.entries(data)) {
      // Check if field is sensitive
      if (this.isSensitiveField(key)) {
        sanitized[key] = this.anonymize(key, value as string);
      } else if (typeof value === 'object') {
        sanitized[key] = this.sanitize(value);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Check if field name indicates sensitive data
   */
  private isSensitiveField(fieldName: string): boolean {
    const lowerField = fieldName.toLowerCase();
    return this.sensitiveFields.some(sensitive =>
      lowerField.includes(sensitive.toLowerCase())
    );
  }

  /**
   * Anonymize sensitive value
   */
  private anonymize(fieldName: string, value: string): string {
    if (!value) return '[empty]';

    const lowerField = fieldName.toLowerCase();

    // IP addresses: show only first 2 octets
    if (lowerField.includes('ip')) {
      return this.anonymizeIP(value);
    }

    // User IDs / Peer IDs: show only hash prefix
    if (lowerField.includes('id')) {
      return this.hashValue(value, 8);
    }

    // InfoHash: show only first 8 chars
    if (lowerField.includes('hash')) {
      return value.substring(0, 8) + '...';
    }

    // Paths: show only filename
    if (lowerField.includes('path')) {
      const parts = value.split(/[\\/]/);
      return `.../${parts[parts.length - 1]}`;
    }

    // Default: hash
    return this.hashValue(value, 8);
  }

  /**
   * Anonymize IP address (192.168.1.100 -> 192.168.x.x)
   */
  private anonymizeIP(ip: string): string {
    if (!ip) return '[no-ip]';

    const parts = ip.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.x.x`;
    }

    // IPv6: show only first 2 groups
    const ipv6Parts = ip.split(':');
    if (ipv6Parts.length > 2) {
      return `${ipv6Parts[0]}:${ipv6Parts[1]}::x`;
    }

    return '[invalid-ip]';
  }

  /**
   * Hash value and return prefix
   */
  private hashValue(value: string, length: number = 8): string {
    const hash = createHash('sha256').update(value).digest('hex');
    return `${hash.substring(0, length)}...`;
  }

  /**
   * Log methods with sanitization
   */
  debug(message: string, data?: any): void {
    this.originalLogger.debug(message, data ? this.sanitize(data) : undefined);
  }

  info(message: string, data?: any): void {
    this.originalLogger.info(message, data ? this.sanitize(data) : undefined);
  }

  warn(message: string, data?: any): void {
    this.originalLogger.warn(message, data ? this.sanitize(data) : undefined);
  }

  error(message: string, data?: any): void {
    this.originalLogger.error(message, data ? this.sanitize(data) : undefined);
  }

  /**
   * Create child logger
   */
  child(name: string): PrivacyLogger {
    return new PrivacyLogger(this.originalLogger.child(name));
  }
}

/**
 * Wrap existing logger with privacy protection
 */
export function createPrivacyLogger(logger: any): PrivacyLogger {
  return new PrivacyLogger(logger);
}
