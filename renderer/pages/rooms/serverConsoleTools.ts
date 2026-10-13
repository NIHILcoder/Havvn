import type { ConsoleLine } from '../../../shared/types';

export type ConsoleFilter = 'all' | 'warn' | 'error';
export function consoleSeverity(line: ConsoleLine): ConsoleFilter {
  if (/\b(?:ERROR|FATAL|SEVERE|\w*Exception|OutOfMemoryError)\b/i.test(line.text)) return 'error';
  if (/\bWARN(?:ING)?\b|can't keep up/i.test(line.text)) return 'warn';
  return line.stream === 'err' ? 'error' : 'all';
}
export function filterConsole(lines: ConsoleLine[], query: string, filter: ConsoleFilter): ConsoleLine[] {
  const q = query.trim().toLocaleLowerCase();
  return lines.filter(line => (filter === 'all' || consoleSeverity(line) === filter) && (!q || line.text.toLocaleLowerCase().includes(q)));
}
export interface SavedServerCommand { id: string; name: string; command: string }
export const MAX_SAVED_COMMANDS = 12;
export const CONSOLE_COMMAND_KEY = 'serverConsoleCommands.v1';
export function parseSavedCommands(raw: unknown): SavedServerCommand[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.slice(0, MAX_SAVED_COMMANDS).flatMap(p => {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id || p.id.length > 128 || seen.has(p.id)
      || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80 || typeof p.command !== 'string'
      || !p.command.trim() || p.command.length > 512 || /[\r\n\0]/.test(p.command)) return [];
    seen.add(p.id);
    return [{ id: p.id, name: p.name.trim(), command: p.command.trim() }];
  });
}
export function loadSavedCommands(scope: string): SavedServerCommand[] {
  try { return parseSavedCommands(JSON.parse(localStorage.getItem(CONSOLE_COMMAND_KEY) || '{}')[scope]); } catch { return []; }
}
export function saveCommands(scope: string, commands: SavedServerCommand[]): boolean {
  try {
    const raw = JSON.parse(localStorage.getItem(CONSOLE_COMMAND_KEY) || '{}');
    const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw).slice(-63) : [];
    localStorage.setItem(CONSOLE_COMMAND_KEY, JSON.stringify(Object.fromEntries([...entries.filter(([id]) => id !== scope), [scope, parseSavedCommands(commands)]])));
    return true;
  } catch { return false; }
}
