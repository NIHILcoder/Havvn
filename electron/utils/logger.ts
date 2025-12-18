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

  constructor() {
    // Will be initialized when app is ready
    this.logDir = '';
  }

  /**
   * Initialize the logger (call after app is ready)
   */
  initialize(options?: { minLevel?: LogLevel }): void {
    if (this.initialized) return;

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
      data,
    };

    // Console output (always)
    this.writeToConsole(entry);

    // File output (if initialized)
    if (this.initialized) {
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
