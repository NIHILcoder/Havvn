/**
 * IP Blocklist Service
 * Downloads and applies P2P IP blocklists to filter malicious/surveillance peers.
 * Applies via WebTorrent 'wire' events (best-effort, no full TCP-level filtering).
 */

import https from 'https';
import http from 'http';
import zlib from 'zlib';
import { URL } from 'url';
import { logger } from '../utils';
import * as db from '../db/store';

const log = logger.child('IPBlocklist');

interface IPRange {
  start: number;
  end: number;
}

export class IPBlocklistService {
  private ranges: IPRange[] = [];

  get entryCount(): number {
    return this.ranges.length;
  }

  /**
   * The merged, sorted blocked ranges as [start, end] number pairs. The actual
   * peer filtering runs in the torrent-host process (where the WebTorrent client
   * lives), so main ships these over to the host via the manager proxy.
   */
  getRanges(): Array<[number, number]> {
    return this.ranges.map((r) => [r.start, r.end]);
  }

  /**
   * Load all enabled blocklists from store and merge into in-memory ranges.
   */
  async loadAll(): Promise<void> {
    const blocklists = await db.getIPBlocklists();
    const enabled = blocklists.filter(b => b.enabled);

    const allRanges: IPRange[] = [];

    for (const bl of enabled) {
      const data = await db.getBlocklistData(bl.id);
      if (!data) continue;

      const parsed = this.parsePackedRanges(data);
      allRanges.push(...parsed);
    }

    // Sort, then merge overlapping/adjacent ranges. Without merging, the binary
    // search in isBlocked() can miss an IP that falls inside an earlier, wider
    // range (e.g. ranges (1,100) and (50,60): a lookup of 80 lands on (50,60),
    // walks right, and never sees that (1,100) also covers it).
    allRanges.sort((a, b) => a.start - b.start);
    this.ranges = this.mergeRanges(allRanges);

    log.info(`Loaded ${this.ranges.length} blocked IP ranges from ${enabled.length} blocklists`);
  }

  /** Coalesce a sorted list of ranges into non-overlapping ranges. */
  private mergeRanges(sorted: IPRange[]): IPRange[] {
    const merged: IPRange[] = [];
    for (const r of sorted) {
      const last = merged[merged.length - 1];
      // +1 so touching ranges (…,100) and (101,…) collapse into one.
      if (last && r.start <= last.end + 1) {
        if (r.end > last.end) last.end = r.end;
      } else {
        merged.push({ ...r });
      }
    }
    return merged;
  }


  /**
   * Download and parse a blocklist, save to store, reload.
   */
  async updateBlocklist(id: string): Promise<number> {
    const blocklists = await db.getIPBlocklists();
    const bl = blocklists.find(b => b.id === id);
    if (!bl) throw new Error(`Blocklist not found: ${id}`);

    log.info('Downloading IP blocklist', { name: bl.name, url: bl.url });

    const content = await this.fetchText(bl.url);
    const ranges = this.parseBlocklistContent(content);

    log.info(`Parsed ${ranges.length} ranges from blocklist`, { name: bl.name });

    // Pack and save
    const packed = this.packRanges(ranges);
    await db.saveBlocklistData(id, packed);
    await db.updateIPBlocklist(id, {
      lastUpdated: new Date().toISOString(),
      entryCount: ranges.length,
    });

    // Reload all
    await this.loadAll();

    return ranges.length;
  }

  // Peer filtering itself now runs in the torrent-host process (see
  // TorrentManager.applyIpBlocklist) — this service owns the lists/parsing in
  // main and ships the merged ranges over via getRanges().

  private parseBlocklistContent(content: string): IPRange[] {
    const ranges: IPRange[] = [];

    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

      // Format: "Description:StartIP-EndIP" (DAT/P2P format)
      const datMatch = trimmed.match(/^[^:]*:(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+)$/);
      if (datMatch) {
        try {
          ranges.push({
            start: this.ipToNum(datMatch[1]),
            end: this.ipToNum(datMatch[2]),
          });
        } catch (_) { continue; }
        continue;
      }

      // Format: "StartIP-EndIP" (plain range)
      const rangeMatch = trimmed.match(/^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+)$/);
      if (rangeMatch) {
        try {
          ranges.push({
            start: this.ipToNum(rangeMatch[1]),
            end: this.ipToNum(rangeMatch[2]),
          });
        } catch (_) { continue; }
        continue;
      }

      // Format: CIDR "192.168.0.0/16"
      const cidrMatch = trimmed.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
      if (cidrMatch) {
        try {
          const baseIp = this.ipToNum(cidrMatch[1]);
          const prefix = parseInt(cidrMatch[2]);
          const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
          const start = (baseIp & mask) >>> 0;
          const end = (start | (~mask >>> 0)) >>> 0;
          ranges.push({ start, end });
        } catch (_) { continue; }
      }
    }

    return ranges;
  }

  private ipToNum(ip: string): number {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
      throw new Error(`Invalid IP: ${ip}`);
    }
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }

  private packRanges(ranges: IPRange[]): string {
    // Store as "start,end;start,end;..." for efficient storage
    return ranges.map(r => `${r.start},${r.end}`).join(';');
  }

  private parsePackedRanges(data: string): IPRange[] {
    if (!data) return [];
    return data.split(';').map(pair => {
      const [start, end] = pair.split(',').map(Number);
      return { start, end };
    }).filter(r => !isNaN(r.start) && !isNaN(r.end));
  }

  private async fetchText(url: string): Promise<string> {
    return (await this.fetchBuffer(url, 0)).toString('utf8');
  }

  /**
   * Fetch a blocklist as a Buffer, following redirects and transparently
   * decompressing gzip/deflate. Most public lists (iblocklist, etc.) are served
   * as .gz; the previous string-concatenation reader corrupted that binary data
   * and parsed zero ranges.
   */
  private fetchBuffer(url: string, redirects: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (redirects > 5) { reject(new Error('Too many redirects fetching blocklist')); return; }
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;

      const req = lib.get(url, {
        headers: { 'User-Agent': 'TorrentHunt Blocklist', 'Accept-Encoding': 'gzip, deflate' },
        timeout: 30000,
      }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          this.fetchBuffer(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} fetching blocklist`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc.includes('gzip') || /\.gz$/i.test(parsed.pathname)) buf = zlib.gunzipSync(buf);
            else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
          } catch (_) {
            // Not actually compressed (server lied / plain .gz alias) — use raw bytes.
          }
          resolve(buf);
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Blocklist fetch timeout')); });
    });
  }
}

let ipBlocklistService: IPBlocklistService | null = null;

export function getIPBlocklistService(): IPBlocklistService {
  if (!ipBlocklistService) {
    ipBlocklistService = new IPBlocklistService();
  }
  return ipBlocklistService;
}
