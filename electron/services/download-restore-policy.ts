import type { AppSettings, Download, VpnBindStatus } from '../../shared/types';
import type { DownloadUndoWarning } from '../../shared/download-removal';
import { shouldStopSeeding } from '../../shared/seeding-limits';

export async function downloadRestoreWarnings(download: Download, policy: {
  settings(): Promise<AppSettings>;
  privacy(): Promise<{ vpnKillSwitch?: boolean; vpnBindEngine?: boolean }>;
  bind(): VpnBindStatus | null;
  vpnSafe(bind: VpnBindStatus | null): Promise<boolean>;
  free(path: string): Promise<number | null>;
  now?: () => number;
}): Promise<DownloadUndoWarning[]> {
  const active = ['queued', 'downloading', 'seeding'].includes(download.status);
  const warnings: DownloadUndoWarning[] = [];
  const settings = await policy.settings();
  const privacy = await policy.privacy();
  const bind = policy.bind();
  if ((privacy.vpnKillSwitch || privacy.vpnBindEngine || bind?.enabled) && !await policy.vpnSafe(bind).catch(() => false)) warnings.push('vpn');
  if (active && settings.diskGuardEnabled !== false) {
    const free = await policy.free(download.savePath).catch(() => null);
    if (free === null || free < Math.max(0, settings.diskGuardMinFreeMB ?? 2048) * 1024 * 1024) warnings.push('disk');
  }
  if (download.status === 'seeding' && shouldStopSeeding(download, {
    ratioLimit: download.seedRatioLimit ?? settings.defaultSeedRatioLimit ?? 0,
    timeLimitMinutes: download.seedTimeLimitMinutes ?? settings.defaultSeedTimeLimitMinutes ?? 0,
  }, (policy.now ?? Date.now)()).stop) warnings.push('seed-limit');
  return warnings;
}
