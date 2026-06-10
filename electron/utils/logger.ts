/**
 * TorrentHunt Logger
 * 
 * Provides structured logging to both console and file.
 * Logs are rotated daily and stored in the app's userData directory.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private logDir: string;
  private currentLogFile: string | null = null;
  private currentLogDate: string | null = null;
  private writeStream: fs.WriteStream | null = null;
  private minLevel: LogLevel = 'info';
  private initialized = false;
  // Privacy controls (wired from PrivacyConfig at startup / on change)
  private fileLoggingDisabled = false;
  private sanitize = false;

  constructor() {
    // Will be initialized when app is ready
    this.logDir = '';
  }

  /**
   * Initialize the logger (call after app is ready)
   */
  initialize(options?: { minLevel?: LogLevel; disableFileLogging?: boolean; sanitize?: boolean }): void {
    if (this.initialized) return;

    this.fileLoggingDisabled = options?.disableFileLogging ?? false;
    this.sanitize = options?.sanitize ?? false;

    this.logDir = path.join(app.getPath('userData'), 'logs');

    // Ensure log directory exists
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    if (options?.minLevel) {
      this.minLevel = options.minLevel;
    }

    // Set based on NODE_ENV
    if (process.env.NODE_ENV === 'development') {
      this.minLevel = 'debug';
    }

    this.rotateLogFile();
    this.initialized = true;

    this.info('Logger', 'Logger initialized', { logDir: this.logDir, minLevel: this.minLevel });
  }

  /**
   * Update privacy-related logging behavior at runtime (from PrivacyConfig).
   */
  setPrivacyOptions(options: { disableFileLogging?: boolean; sanitize?: boolean }): void {
    if (options.disableFileLogging !== undefined) {
      this.fileLoggingDisabled = options.disableFileLogging;
    }
    if (options.sanitize !== undefined) {
      this.sanitize = options.sanitize;
    }
  }

  /**
   * Strip/anonymize sensitive values (IPv4/IPv6, magnet infohashes, peer IDs)
   * from log payloads when sanitize mode is on.
   */
  private sanitizeData(data: unknown): unknown {
    if (!this.sanitize || data == null) return data;
    try {
      let json = JSON.stringify(data);
      json = json
        // IPv4
        .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[ip]')
        // IPv6 (rough)
        .replace(/\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9]{1,4}\b/gi, '[ip6]')
        // 40-char hex infohashes
        .replace(/\b[a-f0-9]{40}\b/gi, '[infohash]')
        // magnet xt
        .replace(/urn:btih:[a-z0-9]+/gi, 'urn:btih:[hash]');
      return JSON.parse(json);
    } catch {
      return data;
    }
  }

  /**
   * Create a child logger for a specific module
   */
  child(module: string): ModuleLogger {
    return new ModuleLogger(this, module);
  }

  /**
   * Log a debug message
   */
  debug(module: string, message: string, data?: unknown): void {
    this.log('debug', module, message, data);
  }

  /**
   * Log an info message
   */
  info(module: string, message: string, data?: unknown): void {
    this.log('info', module, message, data);
  }

  /**
   * Log a warning message
   */
  warn(module: string, message: string, data?: unknown): void {
    this.log('warn', module, message, data);
  }

  /**
   * Log an error message
   */
  error(module: string, message: string, data?: unknown): void {
    this.log('error', module, message, data);
  }

  /**
   * Internal log method
   */
  private log(level: LogLevel, module: string, message: string, data?: unknown): void {
    // Check if this level should be logged
    if (LOG_LEVELS[level] < LOG_LEVELS[this.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
      data: this.sanitizeData(data),
    };

    // Console output (always)
    this.writeToConsole(entry);

    // File output (unless disabled via privacy settings)
    if (this.initialized && !this.fileLoggingDisabled) {
      this.writeToFile(entry);
    }
  }

  /**
   * Write log entry to console
   */
  private writeToConsole(entry: LogEntry): void {
    const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.module}]`;
    const msg = `${prefix} ${entry.message}`;

    switch (entry.level) {
      case 'debug':
        console.debug(msg, entry.data ?? '');
        break;
      case 'info':
        console.info(msg, entry.data ?? '');
        break;
      case 'warn':
        console.warn(msg, entry.data ?? '');
        break;
      case 'error':
        console.error(msg, entry.data ?? '');
        break;
    }
  }

  /**
   * Write log entry to file
   */
  private writeToFile(entry: LogEntry): void {
    // Check if we need to rotate
    this.rotateLogFile();

    if (!this.writeStream) return;

    const line = JSON.stringify(entry) + '\n';
    this.writeStream.write(line);
  }

  /**
   * Rotate log file if date has changed
   */
  private rotateLogFile(): void {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    if (this.currentLogDate === today && this.writeStream) {
      return; // No rotation needed
    }

    // Close existing stream
    if (this.writeStream) {
      this.writeStream.end();
    }

    // Create new log file
    this.currentLogDate = today;
    this.currentLogFile = path.join(this.logDir, `torrenthunt-${today}.log`);
    this.writeStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' });

    // Clean up old logs (keep last 7 days)
    this.cleanupOldLogs();
  }

  /**
   * Remove log files older than 7 days
   */
  private cleanupOldLogs(): void {
    try {
      const files = fs.readdirSync(this.logDir);
      const now = Date.now();
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

      for (const file of files) {
        if (!file.startsWith('torrenthunt-') || !file.endsWith('.log')) continue;

        const filePath = path.join(this.logDir, file);
        const stat = fs.statSync(filePath);
        
        if (now - stat.mtime.getTime() > maxAge) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  /**
   * Close the logger (call on app quit)
   */
  close(): void {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }

  /**
   * Get path to current log file
   */
  getCurrentLogPath(): string | null {
    return this.currentLogFile;
  }

  /**
   * Get path to logs directory
   */
  getLogDir(): string {
    return this.logDir;
  }

  /**
   * Delete all log files immediately (privacy "clear logs now" action).
   * Closes the active stream, removes every torrenthunt-*.log, then reopens a
   * fresh stream so logging continues. Returns the number of files removed.
   */
  clearLogs(): number {
    let removed = 0;
    try {
      // Stop writing so the current file can be deleted on Windows
      if (this.writeStream) {
        this.writeStream.end();
        this.writeStream = null;
      }
      this.currentLogDate = null;

      if (this.logDir && fs.existsSync(this.logDir)) {
        for (const file of fs.readdirSync(this.logDir)) {
          if (!file.startsWith('torrenthunt-') || !file.endsWith('.log')) continue;
          try { fs.unlinkSync(path.join(this.logDir, file)); removed++; } catch { /* locked — skip */ }
        }
      }
    } catch {
      /* best-effort */
    } finally {
      // Reopen a fresh log file unless file logging is disabled
      if (this.initialized && !this.fileLoggingDisabled) {
        this.rotateLogFile();
      }
    }
    return removed;
  }
}

/**
 * Module-specific logger wrapper
 */
class ModuleLogger {
  constructor(
    private parent: Logger,
    private module: string
  ) {}

  debug(message: string, data?: unknown): void {
    this.parent.debug(this.module, message, data);
  }

  info(message: string, data?: unknown): void {
    this.parent.info(this.module, message, data);
  }

  warn(message: string, data?: unknown): void {
    this.parent.warn(this.module, message, data);
  }

  error(message: string, data?: unknown): void {
    this.parent.error(this.module, message, data);
  }
}

// Singleton instance
export const logger = new Logger();

// Export ModuleLogger type for typing
export type { ModuleLogger };
