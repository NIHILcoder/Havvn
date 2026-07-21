import { describe, it, expect } from 'vitest';
import { parseChatSegments, isCopyworthy, splitLinks } from './chat-format';

describe('parseChatSegments', () => {
  it('plain text passes through as one segment', () => {
    expect(parseChatSegments('hello world')).toEqual([{ kind: 'text', text: 'hello world' }]);
  });

  it('empty input yields no segments', () => {
    expect(parseChatSegments('')).toEqual([]);
  });

  it('splits a fenced block with surrounding text', () => {
    expect(parseChatSegments('look:\n```\necho hi\n```\ndone')).toEqual([
      { kind: 'text', text: 'look:' },
      { kind: 'code', text: 'echo hi' },
      { kind: 'text', text: 'done' },
    ]);
  });

  it('discards a language tag on the opening fence', () => {
    expect(parseChatSegments('```bat\n@echo off\n```')).toEqual([
      { kind: 'code', text: '@echo off' },
    ]);
  });

  it('an unclosed fence swallows the rest as code', () => {
    expect(parseChatSegments('intro\n```\ncd /d "%~dp0"\nstart me3.exe')).toEqual([
      { kind: 'text', text: 'intro' },
      { kind: 'code', text: 'cd /d "%~dp0"\nstart me3.exe' },
    ]);
  });

  it('preserves tabs and indentation inside code', () => {
    const code = '\tif exist ".\\SeamlessCoop\\ersc.dll" (\n\t\techo hi\n\t)';
    expect(parseChatSegments('```\n' + code + '\n```')).toEqual([{ kind: 'code', text: code }]);
  });

  it('handles multiple fences and drops empty in-between runs', () => {
    expect(parseChatSegments('```\na\n```\n\n```\nb\n```')).toEqual([
      { kind: 'code', text: 'a' },
      { kind: 'code', text: 'b' },
    ]);
  });

  it('keeps an empty code fence out of the output', () => {
    expect(parseChatSegments('x\n```\n```\ny')).toEqual([
      { kind: 'text', text: 'x' },
      { kind: 'text', text: 'y' },
    ]);
  });

  it('a body of bare fences falls back to raw text (never an empty bubble)', () => {
    expect(parseChatSegments('```')).toEqual([{ kind: 'text', text: '```' }]);
    expect(parseChatSegments('```\n```')).toEqual([{ kind: 'text', text: '```\n```' }]);
  });
});

describe('isCopyworthy', () => {
  it('true for fences and multiline, false for one-liners', () => {
    expect(isCopyworthy('```\nx\n```')).toBe(true);
    expect(isCopyworthy('line1\nline2')).toBe(true);
    expect(isCopyworthy('short message')).toBe(false);
  });
});

describe('splitLinks', () => {
  it('plain text stays one plain run', () => {
    expect(splitLinks('no links here')).toEqual([{ kind: 'plain', text: 'no links here' }]);
  });

  it('empty input yields no runs', () => {
    expect(splitLinks('')).toEqual([]);
  });

  it('finds an http(s) url with surrounding text', () => {
    expect(splitLinks('see https://example.com/a?b=1 ok')).toEqual([
      { kind: 'plain', text: 'see ' },
      { kind: 'link', text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { kind: 'plain', text: ' ok' },
    ]);
  });

  it('finds several urls', () => {
    const runs = splitLinks('http://a.io and https://b.io');
    expect(runs.filter((r) => r.kind === 'link').map((r) => r.text)).toEqual(['http://a.io', 'https://b.io']);
  });

  it('trims trailing punctuation', () => {
    expect(splitLinks('go to https://a.io/x.')).toEqual([
      { kind: 'plain', text: 'go to ' },
      { kind: 'link', text: 'https://a.io/x', href: 'https://a.io/x' },
      { kind: 'plain', text: '.' },
    ]);
    expect(splitLinks('really? https://a.io/x?!')[1]).toEqual(
      { kind: 'link', text: 'https://a.io/x', href: 'https://a.io/x' });
  });

  it('keeps balanced parens, peels an unbalanced closer', () => {
    expect(splitLinks('https://en.wikipedia.org/wiki/Bug_(film)')[0]).toEqual(
      { kind: 'link', text: 'https://en.wikipedia.org/wiki/Bug_(film)', href: 'https://en.wikipedia.org/wiki/Bug_(film)' });
    expect(splitLinks('(see https://a.io/x).')).toEqual([
      { kind: 'plain', text: '(see ' },
      { kind: 'link', text: 'https://a.io/x', href: 'https://a.io/x' },
      { kind: 'plain', text: ').' },
    ]);
  });

  it('never links non-http schemes', () => {
    for (const s of ['javascript:alert(1)', 'file:///c:/x', 'ftp://a.io', 'magnet:?xt=urn:btih:x']) {
      expect(splitLinks(`try ${s} now`)).toEqual([{ kind: 'plain', text: `try ${s} now` }]);
    }
  });

  it('ignores a bare scheme with no host', () => {
    expect(splitLinks('https:// is a prefix')).toEqual([{ kind: 'plain', text: 'https:// is a prefix' }]);
    // Punctuation right after the scheme trims down to a bare scheme — still no link.
    expect(splitLinks('see https://, ok')).toEqual([{ kind: 'plain', text: 'see https://, ok' }]);
    expect(splitLinks('check http://.')).toEqual([{ kind: 'plain', text: 'check http://.' }]);
  });
});
