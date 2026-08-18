import { describe, it, expect } from 'vitest';
import { parsePluginManifest } from './plugin-manifest';

const WITH_MANIFEST = `#!/usr/bin/env python3
"""An example indexer."""
# th-plugin: {"name": "Example", "version": "1.2", "categories": ["2000", "5000"], "requires": ["username", "password"]}

import sys
`;

describe('parsePluginManifest', () => {
  it('reads a manifest comment', () => {
    expect(parsePluginManifest(WITH_MANIFEST)).toEqual({
      name: 'Example',
      version: '1.2',
      description: undefined,
      categories: ['2000', '5000'],
      requires: ['username', 'password'],
    });
  });

  it('returns null when there is no manifest — plugins without one still work', () => {
    expect(parsePluginManifest('import sys\nprint("[]")\n')).toBeNull();
  });

  it('returns null on malformed JSON rather than refusing the plugin', () => {
    expect(parsePluginManifest('# th-plugin: {not json}')).toBeNull();
  });

  it('returns null when the manifest is not an object', () => {
    expect(parsePluginManifest('# th-plugin: ["a"]')).toBeNull();
  });

  it('tolerates spacing around the marker', () => {
    expect(parsePluginManifest('   #   th-plugin:   {"name":"X"}')?.name).toBe('X');
  });

  it('is case-insensitive on the marker', () => {
    expect(parsePluginManifest('# TH-Plugin: {"name":"X"}')?.name).toBe('X');
  });

  it('accepts numeric category ids', () => {
    expect(parsePluginManifest('# th-plugin: {"categories":[2000,5000]}')?.categories)
      .toEqual(['2000', '5000']);
  });

  it('drops category ids that are not plausible', () => {
    expect(parsePluginManifest('# th-plugin: {"categories":["2000","../etc",""]}')?.categories)
      .toEqual(['2000']);
  });

  it('drops duplicate categories', () => {
    expect(parsePluginManifest('# th-plugin: {"categories":["2000","2000"]}')?.categories)
      .toEqual(['2000']);
  });

  it('keeps only known credential requirements', () => {
    expect(parsePluginManifest('# th-plugin: {"requires":["username","totp","APIKEY"]}')?.requires)
      .toEqual(['username', 'apikey']);
  });

  it('ignores non-string names', () => {
    expect(parsePluginManifest('# th-plugin: {"name": 42}')?.name).toBeUndefined();
  });

  it('caps an absurdly long field', () => {
    const long = 'x'.repeat(500);
    const parsed = parsePluginManifest(`# th-plugin: {"name":"${long}"}`);
    expect(parsed?.name?.length).toBe(200);
  });

  it('ignores a manifest far down a long file', () => {
    const padding = '# filler\n'.repeat(1000);
    expect(parsePluginManifest(`${padding}# th-plugin: {"name":"Late"}`)).toBeNull();
  });

  it('handles an empty source', () => {
    expect(parsePluginManifest('')).toBeNull();
  });
});
