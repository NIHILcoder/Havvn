import { ipcMain, type BrowserWindow } from 'electron';
import { getAutomationRules } from '../services/automation-runtime';
import { validateAutomationInput } from '../../shared/automation-rules';
import type { AutomationConfig, AutomationEvent } from '../../shared/automation-rules';
export function registerAutomationIpc(getWindow: () => BrowserWindow): void {
  const service = getAutomationRules();
  const trusted = (event: Electron.IpcMainInvokeEvent) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw Error('Untrusted automation request');
  };
  ipcMain.handle('automation:get', event => { trusted(event); return service.snapshot(); });
  ipcMain.handle('automation:save', (event, config: AutomationConfig) => { trusted(event); return service.save(config); });
  ipcMain.handle('automation:preview', (event, input: unknown, rules: unknown) => { trusted(event); return service.preview(validateAutomationInput(input), rules); });
  ipcMain.handle('automation:retry', async (event, id: unknown, kind: AutomationEvent) => {
    trusted(event);
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !['added','completed'].includes(kind)) throw Error('Invalid automation retry');
    await service.process(id, true); return service.snapshot();
  });
  void service.recover().catch(() => {});
}
