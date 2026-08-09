/**
 * Parsing the system Java probe.
 *
 * The major version is the whole point of reading these properties: PATH offers
 * whatever the user happens to have, and a Java 8 launching a server that needs
 * 21 dies with an UnsupportedClassVersionError stack nobody can act on. Getting
 * `1.8` → 8 wrong in either direction either blocks a working setup or lets that
 * crash through.
 */
import { describe, expect, it } from 'vitest';
import { parseJavaMajor } from './runtime-store';

/** What `java -XshowSettings:properties -version` actually prints (abridged). */
const settings = (specVersion: string, banner: string): string => [
  'Property settings:',
  '    java.home = C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.1',
  `    java.specification.version = ${specVersion}`,
  '    java.vendor = Eclipse Adoptium',
  '',
  banner,
].join('\n');

describe('parseJavaMajor', () => {
  it('reads a modern feature release', () => {
    expect(parseJavaMajor(settings('21', 'openjdk version "21.0.1" 2023-10-17'))).toBe(21);
    expect(parseJavaMajor(settings('17', 'openjdk version "17.0.9" 2023-10-17'))).toBe(17);
    expect(parseJavaMajor(settings('26', 'openjdk version "26" 2026-03-17'))).toBe(26);
  });

  it('reads legacy 1.x as its feature number', () => {
    // Java 8 reports `1.8`, and treating that as major 1 would refuse every
    // server — while treating it as 18 would let a real mismatch through.
    expect(parseJavaMajor(settings('1.8', 'java version "1.8.0_402"'))).toBe(8);
  });

  it('falls back to the banner when the properties are missing', () => {
    expect(parseJavaMajor('openjdk version "21.0.1" 2023-10-17')).toBe(21);
    expect(parseJavaMajor('java version "1.8.0_402"')).toBe(8);
  });

  it('returns 0 when it cannot tell — callers must not risk it', () => {
    expect(parseJavaMajor('')).toBe(0);
    expect(parseJavaMajor('command not found')).toBe(0);
    expect(parseJavaMajor('Property settings:\n    java.home = /usr/lib/jvm/x')).toBe(0);
  });

  it('is not fooled by another property that ends in .version', () => {
    const text = [
      '    java.class.version = 65.0',
      '    java.specification.version = 21',
      '    java.vm.specification.version = 21',
    ].join('\n');
    expect(parseJavaMajor(text)).toBe(21);
  });
});
