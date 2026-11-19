import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AddDownloadSchema, GetStreamUrlSchema, SchedulerConfigSchema, validate } from './validation';

describe('validation with the patched Zod runtime', () => {
  it('accepts a download request with an absolute destination and preserves explicit false/null values', () => {
    const input = { magnetUri: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), downloadDir: path.resolve('fixture-downloads'), paused: false, category: null };
    expect(validate(AddDownloadSchema, input)).toEqual(input);
  });

  it('reports nested validation errors without depending on the removed Zod errors alias', () => {
    expect(() => validate(GetStreamUrlSchema, { id: 'download', fileIndex: 0, opts: { audioTrack: -1 } }))
      .toThrow(/Validation error: opts\.audioTrack:/);
  });

  it('keeps schedule action parameter records and rejects non-object parameters', () => {
    const input = { enabled: true, rules: [{ name: 'Night', enabled: true,
      schedule: { type: 'time', value: '22:00' }, action: { type: 'setSpeed', params: { downKbps: 0, upKbps: 128, enabled: false } } }] };
    expect(validate(SchedulerConfigSchema, input)).toEqual(input);
    expect(() => validate(SchedulerConfigSchema, { ...input, rules: [{ ...input.rules[0], action: { type: 'setSpeed', params: 'invalid' } }] }))
      .toThrow(/Validation error: rules\.0\.action\.params:/);
  });
});
