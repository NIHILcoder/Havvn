/**
 * ChromecastManager — "Cast to TV".
 *
 * Discovers Chromecast / Android TV / Google TV devices on the LAN (mDNS + SSDP
 * via chromecast-api, pure JS — no native modules) and tells a chosen device to
 * play a media URL served by our LAN cast server. The TV fetches the URL itself
 * (H.264/AAC MP4 for browser-playable files, HLS otherwise — both natively
 * supported by Chromecast), so the desktop only sends play/pause/seek commands.
 */

import { logger } from '../utils';

const log = logger.child('Chromecast');

export interface TvDevice { name: string; host: string; }
export interface TvMedia { url: string; contentType: string; title: string }

export class ChromecastManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private devices = new Map<string, any>(); // host -> chromecast-api Device

  private ensureClient(): void {
    if (this.client) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ChromecastAPI = require('chromecast-api');
      this.client = new ChromecastAPI();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.client.on('device', (device: any) => {
        if (device && device.host) {
          this.devices.set(device.host, device);
          log.info('TV found', { name: device.friendlyName, host: device.host });
        }
      });
    } catch (e) {
      log.warn('Chromecast init failed', { error: String(e) });
    }
  }

  /** Start discovery (idempotent) and return devices found so far. */
  list(): TvDevice[] {
    this.ensureClient();
    return Array.from(this.devices.values())
      .map((d) => ({ name: d.friendlyName || d.host, host: d.host }));
  }

  /** Re-scan the network for devices. */
  refresh(): void {
    this.ensureClient();
    try { this.client?.update?.(); } catch { /* ignore */ }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private dev(host: string): any {
    const d = this.devices.get(host);
    if (!d) throw new Error('TV not found — refresh the device list and try again');
    return d;
  }

  play(host: string, media: TvMedia): Promise<void> {
    const device = this.dev(host);
    const payload = {
      contentId: media.url,
      contentType: media.contentType,
      streamType: 'BUFFERED',
      metadata: { type: 0, metadataType: 0, title: media.title },
    };
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      device.play(payload, { autoplay: true }, (err: any) => (err ? reject(err) : resolve()));
    });
  }

  pause(host: string): Promise<void> { return this.ctl(host, 'pause'); }
  resume(host: string): Promise<void> { return this.ctl(host, 'resume'); }
  stop(host: string): Promise<void> { return this.ctl(host, 'stop'); }

  private ctl(host: string, method: 'pause' | 'resume' | 'stop'): Promise<void> {
    const device = this.dev(host);
    return new Promise((resolve, reject) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        device[method]((err: any) => (err ? reject(err) : resolve()));
      } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  destroy(): void {
    for (const d of this.devices.values()) { try { d.close?.(); } catch { /* ignore */ } }
    this.devices.clear();
    try { this.client?.destroy?.(); } catch { /* ignore */ }
    this.client = null;
    log.info('ChromecastManager destroyed');
  }
}

let chromecastManager: ChromecastManager | null = null;
export function getChromecastManager(): ChromecastManager {
  if (!chromecastManager) chromecastManager = new ChromecastManager();
  return chromecastManager;
}
