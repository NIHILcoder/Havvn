/**
 * Lazy Chromium WebRTC seeder host for instant share links.
 * The hidden renderer is retired five seconds after its last share stops.
 */
import path from 'path';
import { logger } from '../utils';
import { ShareInfo } from '../../shared/types';
import { HiddenEngine } from './hidden-engine';

const log = logger.child('ShareManager');
export class ShareManager {
  private engine = new HiddenEngine('share', path.join(__dirname, 'share-seeder.js'), undefined,
    message => log.info('Seeder', { msg: message }));

  share(downloadId: string, contentPath: string, name: string, useTurn: boolean,
    turnServers: { urls: string; username?: string; credential?: string }[] = [], trackers: string[] = []): Promise<ShareInfo> {
    // Hashing a large source has no command timeout; it keeps the window alive.
    return this.engine.call('share', { downloadId, contentPath, name, useTurn, turnServers, trackers }, 0);
  }
  stop(downloadId: string): Promise<{ ok: boolean }> {
    return this.engine.hasWindow ? this.engine.call('stop', { downloadId }) : Promise.resolve({ ok: true });
  }
  get(downloadId: string): Promise<(ShareInfo & { peers: number }) | null> {
    return this.engine.hasWindow ? this.engine.call('get', { downloadId }) : Promise.resolve(null);
  }
  list(): Promise<ShareInfo[]> {
    return this.engine.hasWindow ? this.engine.call('list') : Promise.resolve([]);
  }
  destroy(): void { this.engine.destroy(); log.info('ShareManager destroyed'); }
}

let shareManager: ShareManager | null = null;
export function getShareManager(): ShareManager {
  if (!shareManager) shareManager = new ShareManager();
  return shareManager;
}
export function downloadContentPath(savePath: string, name: string): string { return path.join(savePath, name); }
