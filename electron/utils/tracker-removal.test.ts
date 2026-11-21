import { expect, it } from 'vitest';
import { validateTrackerRemoval, validateTrackerUrl } from './security';
it.each(['http://127.0.0.1:8000/announce', 'ftp://old.invalid/announce', 'broken tracker from metadata'])('allows removing existing tracker %s without weakening add validation', value => {
  expect(() => validateTrackerRemoval(value)).not.toThrow();
  expect(() => validateTrackerUrl(value)).toThrow();
});
it.each(['', ' ', 'x'.repeat(2049), 'http://a\nhttp://b', '\0'])('rejects invalid removal reference', value => {
  expect(() => validateTrackerRemoval(value)).toThrow();
});
