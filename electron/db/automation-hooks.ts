import type { Download } from '../../shared/types';
import type { AutomationReceipt } from '../../shared/automation-rules';
let hooks: { completion(download: Download): AutomationReceipt | undefined; committed(id: string): void } | undefined;
export function setAutomationHooks(next: typeof hooks): void { hooks = next; }
export function captureAutomationCompletion(download: Download): void {
  if (!download.automation?.completed) {
    const receipt = hooks?.completion(download);
    if (receipt) download.automation = { ...download.automation, completed: receipt };
  }
}
export function automationCommitted(id: string): void { hooks?.committed(id); }
