import { expect, it } from 'vitest';
import { consoleSeverity, filterConsole, parseSavedCommands } from './serverConsoleTools';
import type { ConsoleLine } from '../../../shared/types';
const line = (seq: number, text: string, stream: ConsoleLine['stream'] = 'out'): ConsoleLine => ({ seq, at: 0, text, stream });
it('recognizes game log levels in stdout and Java failures, preserving warning severity on stderr', () => {
  expect(consoleSeverity(line(1, '[Server thread/ERROR]: Failed'))).toBe('error');
  expect(consoleSeverity(line(2, 'java.lang.IllegalStateException: broken'))).toBe('error');
  expect(consoleSeverity(line(3, '[WARN] slow', 'err'))).toBe('warn');
  expect(consoleSeverity(line(4, 'Done (2s)!'))).toBe('all');
  const lines = [line(1, 'ERROR: Порт занят'), line(2, 'WARN: Порт нестандартный'), line(3, 'INFO: Ready')];
  expect(filterConsole(lines, ' порт ', 'error').map(l => l.seq)).toEqual([1]);
  expect(filterConsole(lines, '[', 'all')).toEqual([]);
});
it('rejects multi-line commands, overlong input and duplicate IDs in stored shortcuts', () => {
  const saved = { id: 'one', name: 'Save world', command: 'save-all' };
  expect(parseSavedCommands([saved, saved, { ...saved, id: 'bad', command: 'say hello\nstop' }, { ...saved, id: 'long', command: 'x'.repeat(513) }])).toEqual([saved]);
  expect(parseSavedCommands({})).toEqual([]);
});
