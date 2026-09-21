/**
 * Input Validation and Sanitization Utilities
 * Centralized validation to prevent injection attacks and invalid data
 */

import path from 'path';
import { ValidationError } from './error-handler';

/**
 * Validate and sanitize file paths
 */
export function validateFilePath(filePath: string, allowedRoots?: string[]): string {
  if (typeof filePath !== 'string' || !filePath) {
    throw new ValidationError('File path must be a non-empty string');
  }

  // Normalize path to prevent directory traversal
  const normalized = path.normalize(filePath);

  // Check for directory traversal attempts
  if (filePath.split(/[\\/]+/).includes('..')) {
    throw new ValidationError('Path traversal detected');
  }

  // Check for null bytes (can cause issues in file operations)
  if (normalized.includes('\0')) {
    throw new ValidationError('Invalid null byte in path');
  }

  // If allowed roots specified, verify the path is within them
  if (allowedRoots && allowedRoots.length > 0) {
    const resolvedPath = path.resolve(normalized);
    const isAllowed = allowedRoots.some(root => {
      const resolvedRoot = path.resolve(root);
      return resolvedPath.startsWith(resolvedRoot + path.sep) || resolvedPath === resolvedRoot;
    });

    if (!isAllowed) {
      throw new ValidationError('Path is outside allowed directories');
    }
  }

  return normalized;
}

/**
 * Validate URL format
 */
export function validateUrl(url: string, allowedProtocols: string[] = ['http:', 'https:']): string {
  if (typeof url !== 'string' || !url) {
    throw new ValidationError('URL must be a non-empty string');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError('Invalid URL format');
  }

  // Check protocol
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new ValidationError(`Protocol ${parsed.protocol} not allowed`);
  }

  // Prevent localhost/internal IPs unless explicitly allowed
  const hostname = parsed.hostname.toLowerCase();
  const isLocal = hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('172.16.') ||
    hostname === '[::1]';

  if (isLocal && !allowedProtocols.includes('file:')) {
    // Allow local URLs only for specific use cases
    // This can be configured per use case
  }

  return url;
}

/**
 * Validate magnet URI
 */
export function validateMagnetUri(uri: string): string {
  if (typeof uri !== 'string' || !uri) {
    throw new ValidationError('Magnet URI must be a non-empty string');
  }

  if (!uri.startsWith('magnet:?')) {
    throw new ValidationError('Invalid magnet URI format');
  }

  // Check for required xt parameter (info hash)
  if (!uri.includes('xt=')) {
    throw new ValidationError('Magnet URI missing info hash (xt parameter)');
  }

  // Basic length check to prevent DoS
  if (uri.length > 10000) {
    throw new ValidationError('Magnet URI too long');
  }

  return uri;
}

/**
 * Validate info hash (40 hex chars for SHA-1)
 */
export function validateInfoHash(hash: string): string {
  if (typeof hash !== 'string' || !hash) {
    throw new ValidationError('Info hash must be a non-empty string');
  }

  if (!/^[a-fA-F0-9]{40}$/.test(hash)) {
    throw new ValidationError('Invalid info hash format (must be 40 hex characters)');
  }

  return hash.toLowerCase();
}

/**
 * Validate torrent ID (UUID v4)
 */
export function validateTorrentId(id: string): string {
  if (typeof id !== 'string' || !id) {
    throw new ValidationError('Torrent ID must be a non-empty string');
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    throw new ValidationError('Invalid torrent ID format (must be UUID v4)');
  }

  return id.toLowerCase();
}

/**
 * Validate port number
 */
export function validatePort(port: number | string): number {
  const portNum = typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : port;

  if (typeof portNum !== 'number' || !Number.isInteger(portNum)) {
    throw new ValidationError('Port must be an integer');
  }

  if (portNum < 1 || portNum > 65535) {
    throw new ValidationError('Port must be between 1 and 65535');
  }

  // Warn about privileged ports (optional, context-dependent)
  if (portNum < 1024) {
    // Most apps shouldn't bind to privileged ports
    // This is a warning, not an error
  }

  return portNum;
}

/**
 * Validate IPv4 address
 */
export function validateIPv4(ip: string): string {
  if (typeof ip !== 'string' || !ip) {
    throw new ValidationError('IP address must be a non-empty string');
  }

  const parts = ip.split('.');
  if (parts.length !== 4) {
    throw new ValidationError('Invalid IPv4 format');
  }

  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) {
      throw new ValidationError('Invalid IPv4 octet');
    }
  }

  return ip;
}

/**
 * Validate room code format
 */
export function validateRoomCode(code: string): string {
  if (typeof code !== 'string' || !code) {
    throw new ValidationError('Room code must be a non-empty string');
  }

  // Format: adj-adj-adj-noun-noun-NNNNN or adj-adj-adj-noun-noun-NNNNN-e2e
  const pattern = /^(?:(?:[a-z]+-){4}\d{4}|(?:[a-z]+-){5}\d{5})(?:-e2e)?$/;
  if (!pattern.test(code.toLowerCase())) {
    throw new ValidationError('Invalid room code format');
  }

  return code.toLowerCase();
}

/**
 * Validate email address
 */
export function validateEmail(email: string): string {
  if (typeof email !== 'string' || !email) {
    throw new ValidationError('Email must be a non-empty string');
  }

  // Basic email validation (RFC 5322 simplified)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new ValidationError('Invalid email format');
  }

  // Check length
  if (email.length > 254) {
    throw new ValidationError('Email too long');
  }

  return email.toLowerCase();
}

/**
 * Sanitize string for use in SQL/queries (even though we don't use SQL, good practice)
 */
export function sanitizeString(input: string, maxLength: number = 1000): string {
  if (typeof input !== 'string') {
    return '';
  }

  // Remove null bytes
  let sanitized = input.replace(/\0/g, '');

  // Trim whitespace
  sanitized = sanitized.trim();

  // Limit length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }

  return sanitized;
}

/**
 * Validate and sanitize torrent name
 */
export function validateTorrentName(name: string): string {
  if (typeof name !== 'string' || !name) {
    throw new ValidationError('Torrent name must be a non-empty string');
  }

  const sanitized = sanitizeString(name, 500);

  if (sanitized.length === 0) {
    throw new ValidationError('Torrent name cannot be empty after sanitization');
  }

  return sanitized;
}

/**
 * Validate integer within range
 */
export function validateInteger(
  value: number | string,
  min?: number,
  max?: number,
  fieldName: string = 'Value'
): number {
  const num = typeof value === 'string' ? parseInt(value, 10) : value;

  if (isNaN(num) || !Number.isInteger(num)) {
    throw new ValidationError(`${fieldName} must be an integer`);
  }

  if (min !== undefined && num < min) {
    throw new ValidationError(`${fieldName} must be at least ${min}`);
  }

  if (max !== undefined && num > max) {
    throw new ValidationError(`${fieldName} must be at most ${max}`);
  }

  return num;
}

/**
 * Validate float within range
 */
export function validateFloat(
  value: number | string,
  min?: number,
  max?: number,
  fieldName: string = 'Value'
): number {
  const num = typeof value === 'string' ? parseFloat(value) : value;

  if (isNaN(num) || !isFinite(num)) {
    throw new ValidationError(`${fieldName} must be a valid number`);
  }

  if (min !== undefined && num < min) {
    throw new ValidationError(`${fieldName} must be at least ${min}`);
  }

  if (max !== undefined && num > max) {
    throw new ValidationError(`${fieldName} must be at most ${max}`);
  }

  return num;
}

/**
 * Validate boolean
 */
export function validateBoolean(value: any, fieldName: string = 'Value'): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'yes') return true;
    if (lower === 'false' || lower === '0' || lower === 'no') return false;
  }

  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  throw new ValidationError(`${fieldName} must be a boolean`);
}

/**
 * Validate array with element validation
 */
export function validateArray<T>(
  value: any,
  elementValidator: (element: any) => T,
  minLength?: number,
  maxLength?: number,
  fieldName: string = 'Array'
): T[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${fieldName} must be an array`);
  }

  if (minLength !== undefined && value.length < minLength) {
    throw new ValidationError(`${fieldName} must have at least ${minLength} elements`);
  }

  if (maxLength !== undefined && value.length > maxLength) {
    throw new ValidationError(`${fieldName} must have at most ${maxLength} elements`);
  }

  return value.map((element, index) => {
    try {
      return elementValidator(element);
    } catch (error) {
      throw new ValidationError(
        `${fieldName}[${index}]: ${error instanceof Error ? error.message : 'Invalid element'}`
      );
    }
  });
}

/**
 * Validate object shape
 */
export function validateObject<T extends Record<string, any>>(
  value: any,
  validators: { [K in keyof T]: (val: any) => T[K] },
  fieldName: string = 'Object'
): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${fieldName} must be an object`);
  }

  const result: any = {};

  for (const [key, validator] of Object.entries(validators)) {
    try {
      result[key] = validator(value[key]);
    } catch (error) {
      throw new ValidationError(
        `${fieldName}.${key}: ${error instanceof Error ? error.message : 'Invalid value'}`
      );
    }
  }

  return result as T;
}

/**
 * Rate limiting helper - tracks calls per time window
 */
export class RateLimiter {
  private calls: Map<string, number[]> = new Map();

  constructor(
    private maxCalls: number,
    private windowMs: number
  ) {}

  check(key: string): boolean {
    const now = Date.now();
    const calls = this.calls.get(key) || [];

    // Remove old calls outside the window
    const recentCalls = calls.filter(time => now - time < this.windowMs);

    if (recentCalls.length >= this.maxCalls) {
      return false; // Rate limit exceeded
    }

    // Add current call
    recentCalls.push(now);
    this.calls.set(key, recentCalls);

    // Cleanup old entries periodically
    if (this.calls.size > 1000) {
      this.cleanup(now);
    }

    return true;
  }

  private cleanup(now: number): void {
    for (const [key, calls] of this.calls.entries()) {
      const recentCalls = calls.filter(time => now - time < this.windowMs);
      if (recentCalls.length === 0) {
        this.calls.delete(key);
      } else {
        this.calls.set(key, recentCalls);
      }
    }
  }

  reset(key: string): void {
    this.calls.delete(key);
  }

  clear(): void {
    this.calls.clear();
  }
}
