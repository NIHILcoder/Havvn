import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Desktop-entry string escaping is separate from shell escaping. */
export function desktopExecArgument(value: string): string {
  if (!value || /[\r\n\0]/.test(value)) throw new Error('Invalid autostart path');
  return '"' + value.replace(/\\/g, '\\\\\\\\').replace(/["`$]/g, '\\\\$&').replace(/%/g, '%%') + '"';
}

export function writeLinuxAutoLaunch(enabled: boolean, executable: string, configDir: string, args: string[] = []): void {
  const directory = path.join(configDir, 'autostart');
  const file = path.join(directory, 'havvn.desktop');
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return;
  }
  if (!path.isAbsolute(executable) || executable.includes('=')) throw new Error('Invalid autostart executable');
  const exec = [executable, ...args, '--havvn-start-hidden'].map(desktopExecArgument).join(' ');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, '[Desktop Entry]\nType=Application\nName=Havvn\nExec=' + exec +
    '\nIcon=havvn\nTerminal=false\nX-GNOME-Autostart-enabled=true\n', { mode: 0o600 });
}

export function setAutoLaunch(enabled: boolean): void {
  if (process.platform === 'linux') {
    const configDir = process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
      ? process.env.XDG_CONFIG_HOME : path.join(os.homedir(), '.config');
    // AppImage's mounted executable is temporary; register the original file.
    const executable = process.env.APPIMAGE || process.execPath;
    const args = process.defaultApp ? [app.getAppPath()] : [];
    writeLinuxAutoLaunch(enabled, executable, configDir, args);
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--havvn-start-hidden'], name: 'Havvn', path: process.execPath });
  }
}
