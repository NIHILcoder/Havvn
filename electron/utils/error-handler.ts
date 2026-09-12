/**
 * Centralized Error Handling for Havvn
 * Provides consistent error handling across the application with security in mind
 */

/**
 * Base application error class
 */
export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public isOperational: boolean = true,
    public context?: Record<string, any>
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      ...(this.context && { context: this.context }),
    };
  }
}

/**
 * Validation error - invalid user input
 */
export class ValidationError extends AppError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'VALIDATION_ERROR', 400, true, context);
  }
}

/**
 * Security error - attempted security violation
 */
export class SecurityError extends AppError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'SECURITY_ERROR', 403, true, context);
  }
}

/**
 * Rate limit exceeded error
 */
export class RateLimitError extends AppError {
  constructor(message: string = 'Too many requests', context?: Record<string, any>) {
    super(message, 'RATE_LIMIT_ERROR', 429, true, context);
  }
}

/**
 * Resource not found error
 */
export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(
      `${resource}${id ? ` with id ${id}` : ''} not found`,
      'NOT_FOUND',
      404,
      true,
      { resource, id }
    );
  }
}

/**
 * Network error - external service failure
 */
export class NetworkError extends AppError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'NETWORK_ERROR', 503, true, context);
  }
}

/**
 * File system error
 */
export class FileSystemError extends AppError {
  constructor(message: string, filePath?: string) {
    super(message, 'FILE_SYSTEM_ERROR', 500, true, { filePath });
  }
}

/**
 * Torrent error
 */
export class TorrentError extends AppError {
  constructor(message: string, infoHash?: string) {
    super(message, 'TORRENT_ERROR', 500, true, { infoHash });
  }
}

/**
 * Room error - room/sharing related errors
 */
export class RoomError extends AppError {
  constructor(message: string, roomId?: string) {
    super(message, 'ROOM_ERROR', 500, true, { roomId });
  }
}

/**
 * Cryptography error
 */
export class CryptoError extends AppError {
  constructor(message: string) {
    super(message, 'CRYPTO_ERROR', 500, true);
  }
}

/**
 * Check if an error is operational (expected) vs programmer error (bug)
 */
export function isOperationalError(error: Error): boolean {
  if (error instanceof AppError) {
    return error.isOperational;
  }
  return false;
}

/**
 * Get a safe error message for display to users
 * Strips sensitive information and provides user-friendly text
 */
export function getSafeErrorMessage(error: Error): string {
  if (error instanceof AppError) {
    return error.message;
  }

  // Generic message for unknown errors (don't expose internals)
  return 'An unexpected error occurred. Please try again.';
}

/**
 * Get detailed error info for logging (includes stack trace)
 * Should NEVER be shown to users
 */
export function getErrorDetails(error: Error): {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  context?: Record<string, any>;
} {
  const details: any = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };

  if (error instanceof AppError) {
    details.code = error.code;
    details.statusCode = error.statusCode;
    if (error.context) {
      details.context = error.context;
    }
  }

  return details;
}

/**
 * Handle an error with proper logging and optional user notification
 */
export function handleError(
  error: Error,
  context?: string,
  options?: {
    silent?: boolean;
    rethrow?: boolean;
  }
): AppError {
  const logger = require('./logger').logger;

  // Convert to AppError if it isn't one
  const appError = error instanceof AppError
    ? error
    : new AppError(error.message, 'UNKNOWN_ERROR', 500, false);

  // Log the error
  if (!options?.silent) {
    const logContext = {
      ...(context && { context }),
      ...getErrorDetails(appError),
    };

    if (isOperationalError(appError)) {
      logger.warn('Error', appError.message, logContext);
    } else {
      logger.error('Error', appError.message, logContext);
    }
  }

  // Rethrow if requested
  if (options?.rethrow) {
    throw appError;
  }

  return appError;
}

/**
 * Async error handler wrapper
 * Catches errors and converts them to proper format
 */
export function asyncHandler<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  context?: string
): T {
  return (async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (error) {
      throw handleError(error as Error, context, { rethrow: true });
    }
  }) as T;
}

/**
 * IPC error handler wrapper
 * Converts errors to JSON-safe format for IPC communication
 */
export function withErrorHandler<T extends (...args: any[]) => any>(
  handler: T,
  context: string
): T {
  return ((...args: any[]) => {
    try {
      const result = handler(...args);

      // Handle async handlers
      if (result instanceof Promise) {
        return result.catch((error: Error) => {
          const appError = handleError(error, context);
          // Return error in a format that IPC can serialize
          throw {
            isError: true,
            name: appError.name,
            message: getSafeErrorMessage(appError),
            code: appError.code,
            statusCode: appError.statusCode,
          };
        });
      }

      return result;
    } catch (error) {
      const appError = handleError(error as Error, context);
      // Return error in a format that IPC can serialize
      throw {
        isError: true,
        name: appError.name,
        message: getSafeErrorMessage(appError),
        code: appError.code,
        statusCode: appError.statusCode,
      };
    }
  }) as T;
}

/**
 * Retry helper for transient errors
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    delayMs?: number;
    backoff?: boolean;
    context?: string;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    delayMs = 1000,
    backoff = true,
    context = 'withRetry',
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Don't retry operational errors (they're expected)
      if (error instanceof AppError && error.isOperational && error.statusCode < 500) {
        throw error;
      }

      // Don't retry on last attempt
      if (attempt === maxAttempts) {
        break;
      }

      // Calculate delay (with backoff if enabled)
      const delay = backoff ? delayMs * Math.pow(2, attempt - 1) : delayMs;

      const logger = require('./logger').logger;
      logger.warn(
        context,
        `Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms`,
        { error: (error as Error).message }
      );

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // All attempts failed
  throw handleError(
    lastError || new Error('All retry attempts failed'),
    context,
    { rethrow: true }
  );
}

/**
 * Timeout helper - wraps a promise with a timeout
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string = 'Operation timed out'
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new AppError(message, 'TIMEOUT', 504)), timeoutMs)
    ),
  ]);
}

/**
 * Circuit breaker pattern implementation
 * Prevents cascading failures by stopping requests to failing services
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private readonly threshold: number = 5,
    private readonly resetTimeMs: number = 60000
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit should transition to half-open
    if (
      this.state === 'open' &&
      Date.now() - this.lastFailureTime > this.resetTimeMs
    ) {
      this.state = 'half-open';
      this.failures = 0;
    }

    // Reject immediately if circuit is open
    if (this.state === 'open') {
      throw new AppError(
        'Circuit breaker is open - service temporarily unavailable',
        'CIRCUIT_OPEN',
        503
      );
    }

    try {
      const result = await fn();

      // Success - close circuit if it was half-open
      if (this.state === 'half-open') {
        this.state = 'closed';
        this.failures = 0;
      }

      return result;
    } catch (error) {
      this.failures++;
      this.lastFailureTime = Date.now();

      // Open circuit if threshold exceeded
      if (this.failures >= this.threshold) {
        this.state = 'open';
        const logger = require('./logger').logger;
        logger.error(
          'CircuitBreaker',
          'Circuit breaker opened due to repeated failures',
          { failures: this.failures }
        );
      }

      throw error;
    }
  }

  getState() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
    };
  }

  reset() {
    this.state = 'closed';
    this.failures = 0;
    this.lastFailureTime = 0;
  }
}

/**
 * Parse IPC error (convert serialized error back to Error object)
 */
export function parseIpcError(error: any): Error {
  if (error?.isError) {
    return new AppError(error.message, error.code, error.statusCode, true, error.context);
  }
  return error;
}

/**
 * Global unhandled rejection handler
 * Should be set up early in the application
 */
export function setupGlobalErrorHandlers() {
  const logger = require('./logger').logger;

  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    logger.error('UnhandledRejection', 'Unhandled promise rejection', {
      reason: reason?.message || String(reason),
      stack: reason?.stack,
    });

    // In development, also log to console for visibility
    if (process.env.NODE_ENV === 'development') {
      console.error('Unhandled Rejection:', reason);
    }
  });

  process.on('uncaughtException', (error: Error) => {
    logger.error('UncaughtException', 'Uncaught exception', {
      error: error.message,
      stack: error.stack,
    });

    // In development, also log to console
    if (process.env.NODE_ENV === 'development') {
      console.error('Uncaught Exception:', error);
    }

    // For programmer errors, we should exit
    if (!isOperationalError(error)) {
      logger.error('FATAL', 'Non-operational error - exiting', {
        error: error.message,
      });
      process.exit(1);
    }
  });
}
