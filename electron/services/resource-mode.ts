import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import * as db from '../db/store';
import { logger } from '../utils';
import { ResourceModeController } from './resource-mode-controller';
import type { PowerSource } from '../../shared/resource-mode';
import { assertAppUiSender } from '../utils/app-ui-security';

const log = logger.child('ResourceMode');
let service: ResourceModeController | undefined;
let cleanup: (() => void) | undefined;
function readPower(): PowerSource {
  // Events are documented on Windows/macOS. Do not invent AC on other platforms.
  if (!app?.isReady?.() || !['win32', 'darwin'].includes(process.platform)) return 'unknown';
  const battery = powerMonitor.isOnBatteryPower();
  return typeof battery === 'boolean' ? battery ? 'battery' : 'ac' : 'unknown';
}
export function getResourceModeService(): ResourceModeController {
  if (!service) {
    service = new ResourceModeController({ readMode: async () => (await db.getSettings()).resourceMode ?? 'normal',
      writeMode: mode => db.updateSettings({ resourceMode: mode }), readPower });
    service.subscribe(snapshot => {
      for (const win of BrowserWindow?.getAllWindows?.() ?? []) if (!win.isDestroyed()) win.webContents.send('resources:changed', snapshot);
    });
  }
  return service;
}
export async function initResourceMode(getMainWindow: () => BrowserWindow | null): Promise<void> {
  if (cleanup) return;
  const controller = getResourceModeService();
  const battery = () => controller.receivePower('battery'), ac = () => controller.receivePower('ac');
  const refresh = () => { void controller.refresh().catch(error => log.warn('Resource mode refresh failed', { error: String(error) })); };
  powerMonitor.on('on-battery', battery); powerMonitor.on('on-ac', ac); powerMonitor.on('resume', refresh);
  const timer = setInterval(refresh, 30000);
  cleanup = () => { clearInterval(timer); powerMonitor.off('on-battery', battery); powerMonitor.off('on-ac', ac); powerMonitor.off('resume', refresh); ipcMain.removeHandler('resources:get'); ipcMain.removeHandler('resources:set'); };
  ipcMain.handle('resources:get', event => { assertAppUiSender(event, getMainWindow()); return controller.refresh(); });
  ipcMain.handle('resources:set', (event, mode: unknown) => { assertAppUiSender(event, getMainWindow()); return controller.setMode(mode); });
  await controller.refresh();
}
export function stopResourceMode(): void { cleanup?.(); cleanup = undefined; }
