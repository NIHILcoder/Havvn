import { expect, it } from 'vitest';
import { sanitizeSecrets } from './log-sanitizer';

it.each(['a-b-c-d-1234', 'a-b-c-d-1234-e2e', 'a-b-c-d-e-12345', 'a-b-c-d-e-12345-e2e'])(
  'redacts supported room codes even when they are too short for the generic token filter: %s', code => {
    expect(sanitizeSecrets('Join ' + code)).toBe('Join [REDACTED]');
  },
);
