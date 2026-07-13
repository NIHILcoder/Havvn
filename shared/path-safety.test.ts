import { describe, it, expect } from 'vitest';
import { safeBaseName, safeDirSegment } from './path-safety';

describe('safeBaseName (room path-traversal guard)', () => {
  it('passes a normal filename through unchanged', () => {
    expect(safeBaseName('movie.mkv')).toBe('movie.mkv');
    expect(safeBaseName('My Show S01E01.mp4')).toBe('My Show S01E01.mp4');
  });

  it('strips POSIX traversal to a bare basename', () => {
    expect(safeBaseName('../../../etc/passwd')).toBe('passwd');
    expect(safeBaseName('a/b/c/evil.exe')).toBe('evil.exe');
  });

  it('strips Windows traversal (backslashes) to a bare basename', () => {
    expect(safeBaseName('..\\..\\..\\Startup\\evil.exe')).toBe('evil.exe');
    expect(safeBaseName('C:\\Windows\\System32\\x.dll')).toBe('x.dll');
  });

  it('strips mixed separators', () => {
    expect(safeBaseName('../a\\b/../evil.bin')).toBe('evil.bin');
  });

  it('rejects empty / dot / dotdot as unusable', () => {
    expect(safeBaseName('')).toBe('');
    expect(safeBaseName('.')).toBe('');
    expect(safeBaseName('..')).toBe('');
    expect(safeBaseName('a/..')).toBe('');
  });

  it('tolerates a trailing separator (strips it)', () => {
    expect(safeBaseName('foo/')).toBe('foo');
  });

  it('rejects non-strings', () => {
    expect(safeBaseName(undefined)).toBe('');
    expect(safeBaseName(null)).toBe('');
    expect(safeBaseName(42)).toBe('');
  });

  it('keeps dots INSIDE a name (not a traversal once it has no separators)', () => {
    expect(safeBaseName('my..file.txt')).toBe('my..file.txt');
  });
});

describe('safeDirSegment (room folder → one safe subdir segment)', () => {
  it('passes a normal folder name through', () => {
    expect(safeDirSegment('Movies')).toBe('Movies');
    expect(safeDirSegment('Season 1 · 1080p')).toBe('Season 1 · 1080p');
  });
  it('strips any directory component (no traversal, no nesting)', () => {
    expect(safeDirSegment('../../etc')).toBe('etc');
    expect(safeDirSegment('a/b/Movies')).toBe('Movies');
    expect(safeDirSegment('..\\..\\Startup')).toBe('Startup');
  });
  it('replaces Windows-illegal characters with a space', () => {
    expect(safeDirSegment('foo*bar?"baz"')).toBe('foo bar baz');
    expect(safeDirSegment('re:zero')).toBe('re zero');
  });
  it('strips a Windows drive prefix (safeBaseName drops it)', () => {
    expect(safeDirSegment('A:B*C')).toBe('B C');
  });
  it('trims trailing dots and spaces (illegal on Windows)', () => {
    expect(safeDirSegment('folder...')).toBe('folder');
    expect(safeDirSegment('name   ')).toBe('name');
  });
  it('rejects reserved device names', () => {
    expect(safeDirSegment('CON')).toBe('');
    expect(safeDirSegment('nul')).toBe('');
    expect(safeDirSegment('COM1')).toBe('');
    expect(safeDirSegment('LPT9')).toBe('');
  });
  it('returns empty when nothing usable remains', () => {
    expect(safeDirSegment('')).toBe('');
    expect(safeDirSegment('...')).toBe('');
    expect(safeDirSegment('/\\')).toBe('');
    expect(safeDirSegment(undefined)).toBe('');
    expect(safeDirSegment(42)).toBe('');
  });
  it('drops control characters and caps length', () => {
    expect(safeDirSegment('a\tb\nc')).toBe('abc');
    expect(safeDirSegment('x'.repeat(200)).length).toBe(80);
  });
});
