import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('electron', () => ({ app: { setLoginItemSettings: vi.fn() } }));
import { app } from 'electron';
import { desktopExecArgument, writeLinuxAutoLaunch, setAutoLaunch } from './auto-launch';
const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
it('leaves the primary OS startup registration intact when an isolated test profile starts or changes preferences', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-autostart-')); directories.push(dir);
  fs.mkdirSync(path.join(dir, 'autostart')); const entry = path.join(dir, 'autostart/havvn.desktop'); fs.writeFileSync(entry, 'primary application entry');
  vi.stubEnv('TH_INSTANCE', ' file-sync-pilot '); vi.stubEnv('XDG_CONFIG_HOME', dir);
  setAutoLaunch(false); setAutoLaunch(true);
  expect(app.setLoginItemSettings).not.toHaveBeenCalled(); expect(fs.readFileSync(entry, 'utf8')).toBe('primary application entry');
});
describe('Linux autostart', () => {
  it('quotes desktop-entry arguments and rejects line/key injection', () => {
    expect(desktopExecArgument('/a folder/havvn')).toBe('"/a folder/havvn"');
    expect(desktopExecArgument('a"$`\\%b')).toBe('"a\\\\"\\\\$\\\\`\\\\\\\\%%b"');
    expect(() => desktopExecArgument('/app\nHidden=true')).toThrow();
  });
  it('registers the original executable, replaces its path and removes only its entry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-autostart-')); directories.push(dir);
    const executable = path.resolve(dir, 'Havvn AppImage');
    writeLinuxAutoLaunch(true, executable, dir);
    const file = path.join(dir, 'autostart/havvn.desktop');
    expect(fs.readFileSync(file, 'utf8')).toContain('Exec=' + desktopExecArgument(executable) + ' "--havvn-start-hidden"');
    const unrelated = path.join(dir, 'autostart/other.desktop'); fs.writeFileSync(unrelated, 'keep');
    const moved = path.resolve(dir, 'moved AppImage');
    writeLinuxAutoLaunch(true, moved, dir);
    expect(fs.readFileSync(file, 'utf8')).toContain(desktopExecArgument(moved));
    writeLinuxAutoLaunch(false, moved, dir); writeLinuxAutoLaunch(false, moved, dir);
    expect(fs.existsSync(file)).toBe(false); expect(fs.readFileSync(unrelated, 'utf8')).toBe('keep');
  });
});
