import Store from 'electron-store';
import * as db from '../db/store';
import { decryptSecretStrict, encryptSecret } from '../db/secrets';
import { setAutomationHooks } from '../db/automation-hooks';
import { AutomationRules } from './automation-rules';
import { recordAppEvent, resolveAppEvent } from './app-events';
import { showOsNotification } from '../utils/os-notify';
import { t } from '../i18n';
let instance: AutomationRules | undefined;
export function getAutomationRules(): AutomationRules {
  if (!instance) {
    let store: Store<{ payload: string }> | undefined;
    instance = new AutomationRules({
      readConfig: () => {
        store = new Store({ name: 'automation', defaults: { payload: '' }, clearInvalidConfig: false });
        const payload = store.get('payload');
        if (typeof payload !== 'string' || payload.length > 2 * 1024 * 1024) throw Error('Invalid automation storage');
        return payload ? JSON.parse(decryptSecretStrict(payload)) : null;
      },
      writeConfig: config => { if (!store) throw Error('Automation storage unavailable'); store.set('payload', encryptSecret(JSON.stringify(config), false)); },
      categories: db.getCategories, downloads: db.getAllDownloads, download: db.getDownloadById,
      persist: async (id, event, receipt) => {
        const download = await db.getDownloadById(id);
        if (!download || download.status === 'removed') throw Error('Download unavailable');
        await db.updateDownloadField(id, 'automation', { ...download.automation, [event]: receipt });
      },
      category: (id, category) => db.setDownloadCategory(id, category, 'automation'),
      notify: async (download, receipt) => {
        showOsNotification(t('automation.notification.title'), t('automation.notification.body', { name: download.name }),
          { context: { kind: receipt.event === 'completed' ? 'download-complete' : 'system', downloadId: download.id, group: 'automation' } });
      },
      history: (id, failed) => {
        if (failed) recordAppEvent('automation-failed', { kind: 'download', id });
        else { resolveAppEvent('automation-failed', { kind: 'download', id }); recordAppEvent('automation-applied', { kind: 'download', id }); }
      },
    });
    setAutomationHooks({
      // getCategories returns from the same config owner; capture is synchronous
      // with the completion write, using its already-validated category snapshot.
      completion: download => instance!.completion(download, db.getAutomationCategories()),
      committed: id => { void instance!.process(id).catch(() => {}); },
    });
  }
  return instance;
}
