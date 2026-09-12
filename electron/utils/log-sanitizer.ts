/**
 * Enhanced logger with secret detection and sanitization
 * Prevents sensitive data from being logged
 */

const SECRET_PATTERNS = [
  // API keys and tokens
  /\b[a-zA-Z0-9_-]{20,}\b/g,                      // Long tokens
  /sk_[a-z]+_[A-Za-z0-9]+/gi,                     // Stripe-like keys
  /(?:bearer|token|api[_-]?key)[:\s=]+[^\s\n]+/gi, // Bearer tokens, API keys

  // Passwords and credentials
  /"password"\s*:\s*"[^"]+"/gi,                   // JSON passwords
  /password[:\s=]+[^\s\n&]+/gi,                   // URL/form passwords
  /"secret"\s*:\s*"[^"]+"/gi,                     // JSON secrets

  // Authorization headers
  /Authorization:\s*Bearer\s+\S+/gi,
  /Authorization:\s*Basic\s+\S+/gi,

  // Connection strings
  /(?:mongodb|postgres|mysql):\/\/[^@\s]+:[^@\s]+@[^\s]+/gi,

  // Private keys
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]+?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,

  // Room invite codes (format: word-word-word-word-NNNN or with -e2e)
  /\b[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{4}(?:-e2e)?\b/gi,

  // Email addresses (optional - might be needed in some logs)
  // /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,

  // IP addresses (only private ranges - public IPs might be intentional)
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,

  // Credit card numbers (basic pattern)
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
];

/**
 * Redact secrets from a string
 */
function redactSecrets(str: string): string {
  let redacted = str;

  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }

  return redacted;
}

/**
 * Recursively sanitize an object, redacting any sensitive values
 */
export function sanitizeSecrets(obj: any, maxDepth = 10, currentDepth = 0): any {
  // Prevent infinite recursion
  if (currentDepth > maxDepth) {
    return '[MAX_DEPTH_EXCEEDED]';
  }

  // Handle null/undefined
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle strings - check for secrets
  if (typeof obj === 'string') {
    return redactSecrets(obj);
  }

  // Handle numbers, booleans, etc.
  if (typeof obj !== 'object') {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeSecrets(item, maxDepth, currentDepth + 1));
  }

  // Handle Error objects specially
  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: redactSecrets(obj.message),
      stack: obj.stack ? redactSecrets(obj.stack) : undefined,
    };
  }

  // Handle plain objects
  const sanitized: any = {};

  for (const [key, value] of Object.entries(obj)) {
    // Redact entire value if key name suggests it's sensitive
    const keyLower = key.toLowerCase();
    if (
      keyLower.includes('password') ||
      keyLower.includes('secret') ||
      keyLower.includes('token') ||
      keyLower.includes('key') ||
      keyLower.includes('auth') ||
      keyLower.includes('credential')
    ) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = sanitizeSecrets(value, maxDepth, currentDepth + 1);
    }
  }

  return sanitized;
}

/**
 * Sanitize log arguments before passing to logger
 */
export function sanitizeLogArgs(...args: any[]): any[] {
  return args.map(arg => {
    if (typeof arg === 'string') {
      return redactSecrets(arg);
    }
    if (typeof arg === 'object' && arg !== null) {
      return sanitizeSecrets(arg);
    }
    return arg;
  });
}

/**
 * Test if a string contains potential secrets
 */
export function containsSecrets(str: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(str)) {
      return true;
    }
  }
  return false;
}

/**
 * Get sanitized error message safe for logging
 */
export function getSafeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }
  if (typeof error === 'string') {
    return redactSecrets(error);
  }
  return '[Error: unknown type]';
}

/**
 * Get sanitized stack trace safe for logging
 */
export function getSafeStackTrace(error: unknown): string | undefined {
  if (error instanceof Error && error.stack) {
    return redactSecrets(error.stack);
  }
  return undefined;
}

/**
 * Wrap logger methods to automatically sanitize
 */
export function createSanitizingLogger(logger: any): any {
  const methods = ['debug', 'info', 'warn', 'error'];
  const wrapped: any = {};

  for (const method of methods) {
    if (typeof logger[method] === 'function') {
      wrapped[method] = (...args: any[]) => {
        const sanitized = sanitizeLogArgs(...args);
        return logger[method](...sanitized);
      };
    }
  }

  // Copy other properties/methods as-is
  for (const key of Object.keys(logger)) {
    if (!methods.includes(key)) {
      wrapped[key] = logger[key];
    }
  }

  return wrapped;
}
