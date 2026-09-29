import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import type { Download, TorrentFile } from '../../shared/types';
import type { HistoryPlaybackFile, HistoryPlaybackOptions } from '../../shared/history-playback';
import { classifyMediaKind, isDirectlyPlayable } from '../../shared/media';
import { streamStartSeconds, streamStartParam } from '../../shared/stream-position';
import { NativeMediaServer, type MediaFileInfo } from '../torrent/native/media-server';
import { audioTrackList, audioTrackParam, probeAudioStreams } from '../torrent/audio-probe';
import { getSubtitleVtt, listSubtitleTracks } from '../torrent/subtitle-probe';
import type { LocalMedia } from './external-player';
import type { WatchTarget } from '../../shared/watch-history';
import { mediaPath } from '../torrent/verified-media';

interface Dependencies {
  download: (id: string) => Promise<Download | null>;
  files: (id: string) => Promise<TorrentFile[]>;
  stream: (id: string, index: number, opts: HistoryPlaybackOptions & { noResume: true }) => Promise<{ url: string; name: string; kind: 'video' | 'audio' | 'other'; transcoded: boolean; startTime?: number }>;
  ffmpeg: () => string | null;
  cached: (identity: string) => TorrentFile[];
  cache: (identity: string, files: TorrentFile[]) => void;
}
/** Read-only resolution: never add a torrent, start the daemon or select pieces. */
export class HistoryPlayback {
  private readonly local = new Map<string, MediaFileInfo>();
  private readonly token = crypto.randomBytes(32).toString('hex');
  private readonly server: NativeMediaServer;
  constructor(private readonly deps: Dependencies) {
    this.server = new NativeMediaServer((id, index) => this.local.get(`${id}:${index}`) || null, deps.ffmpeg,
      async (id, index) => this.local.get(`${id}:${index}`)?.length || 0, this.token);
  }
  async files(id: string): Promise<HistoryPlaybackFile[]> {
    const d = await this.deps.download(id);
    if (!d || d.status === 'removed') return [];
    const identity = d.infoHash || d.id;
    let files = await this.deps.files(id).catch(() => []);
    if (files.length) this.deps.cache(identity, files);
    else files = this.deps.cached(identity);
    if (d.progress >= 1) files = files.map((f, i) => d.filePriorities?.[f.index ?? i] !== 'skip' && (!d.selectedFiles?.length || d.selectedFiles.includes(f.index ?? i)) ?
      { ...f, downloaded: f.length, progress: 1 } : f);
    if (!files.length && d.torrentFilePath) {
      try {
        const parse = createRequire(__filename)('parse-torrent') as (buf: Buffer) => { infoHash?: string; files?: Array<{ name: string; path: string; length: number }> };
        const metadata = parse(fs.readFileSync(d.torrentFilePath));
        if (d.infoHash && metadata.infoHash !== d.infoHash) throw new Error('Torrent metadata changed');
        files = (metadata.files || []).map((f, index) => {
          const complete = d.progress >= 1 && d.filePriorities?.[index] !== 'skip' && (!d.selectedFiles?.length || d.selectedFiles.includes(index));
          return { ...f, index, downloaded: complete ? f.length : 0, progress: complete ? 1 : 0 };
        });
        if (files.length) this.deps.cache(identity, files);
      } catch { /* Metadata may no longer be on disk; keep unavailable history. */ }
    }
    return files.map((f, index) => {
      const disk = this.diskPath(d, f);
      let exists = false; try { exists = !!disk && fs.statSync(disk).isFile() && fs.statSync(disk).size >= f.length; } catch { /* missing */ }
      const complete = f.length > 0 && f.downloaded >= f.length;
      return { ...f, index: f.index ?? index, availability: exists && complete ? 'local' : !disk || !fs.existsSync(disk) ? 'missing' :
        d.status === 'downloading' || d.status === 'seeding' ? 'stream' : 'paused' };
    });
  }
  private diskPath(d: Download, f: TorrentFile): string | null {
    const rel = f.path.replace(/\\/g, '/');
    if (!rel || rel.split('/').some(p => p === '..' || p === '.') || path.isAbsolute(rel) || rel.includes(':') || classifyMediaKind(f.name) === 'other') return null;
    try {
      const base = fs.realpathSync(d.savePath), candidate = fs.realpathSync(path.join(base, rel));
      if (candidate.startsWith(base + path.sep)) return candidate;
    } catch { /* Missing files are never recreated. */ }
    if (d.seedPaths?.length === 1) {
      try { const source = fs.realpathSync(d.seedPaths[0]); if (fs.statSync(source).isFile() && path.basename(source) === f.name) return source; } catch { /* missing */ }
    }
    return null;
  }
  private async resolve(id: string, index: number) {
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid media file');
    const d = await this.deps.download(id), files = await this.files(id), file = files.find(f => f.index === index);
    if (!d || !file || classifyMediaKind(file.name) === 'other') throw new Error('Media unavailable');
    const disk = this.diskPath(d, file); if (!disk) throw new Error('Media unavailable');
    return { file, disk };
  }
  async watchTarget(id: string, relativePath: string): Promise<WatchTarget | null> {
    const rel = mediaPath(relativePath); if (!rel) return null;
    const files = await this.files(id), d = await this.deps.download(id);
    const file = files.find(f => f.path.replace(/\\/g, '/') === rel);
    if (!d || d.status === 'removed' || !file) return null;
    return { identity: d.infoHash || d.id, downloadId: d.id, title: d.name, path: rel, fileIndex: file.index ?? files.indexOf(file) };
  }
  async localFile(id: string, relativePath: string): Promise<LocalMedia> {
    if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0') || classifyMediaKind(relativePath) === 'other') return { ok: false, reason: 'invalid-file' };
    const rel = relativePath.replace(/\\/g, '/');
    if (path.isAbsolute(rel) || rel.includes(':') || rel.split('/').some(p => p === '..' || p === '.')) return { ok: false, reason: 'invalid-file' };
    const files = await this.files(id), d = await this.deps.download(id);
    if (!d || d.status === 'removed') return { ok: false, reason: 'missing-file' };
    const file = files.find(f => f.path.replace(/\\/g, '/') === rel);
    if (!file || classifyMediaKind(file.name) === 'other') return { ok: false, reason: 'invalid-file' };
    const disk = this.diskPath(d, file);
    if (!disk) return { ok: false, reason: file.downloaded < file.length ? 'incomplete-file' : 'missing-file' };
    if (file.availability !== 'local') return { ok: false, reason: 'incomplete-file' };
    return { ok: true, disk, length: file.length };
  }
  async stream(id: string, index: number, opts: HistoryPlaybackOptions = {}) {
    const { file, disk } = await this.resolve(id, index);
    if (file.availability === 'stream') return this.deps.stream(id, index, { ...opts, noResume: true });
    if (file.availability !== 'local') throw new Error('Media unavailable: resume the download manually');
    if (this.local.size >= 200 && !this.local.has(`${id}:${index}`)) throw new Error('Too many open media files');
    this.local.set(`${id}:${index}`, { diskPath: disk, name: file.name, length: file.length, kind: classifyMediaKind(file.name) });
    const port = await this.server.ensure(), transcoded = opts.transcode === true || !isDirectlyPlayable(file.name);
    if (transcoded && !this.deps.ffmpeg()) throw new Error('Transcoder unavailable');
    const startTime = transcoded ? streamStartSeconds(opts.startTime) : 0;
    return { url: `http://127.0.0.1:${port}/${transcoded ? 'transcode' : 'direct'}/${encodeURIComponent(id)}/${index}?k=${this.token}&t=${Date.now()}${audioTrackParam(opts.audioTrack)}${streamStartParam(startTime)}`,
      name: file.name, kind: classifyMediaKind(file.name), transcoded, startTime };
  }
  async audio(id: string, index: number) { const { disk } = await this.resolve(id, index); return audioTrackList(await probeAudioStreams(this.deps.ffmpeg(), disk)); }
  async subtitles(id: string, index: number) { const { disk } = await this.resolve(id, index); return listSubtitleTracks(this.deps.ffmpeg(), disk); }
  async vtt(id: string, index: number, key: string) { const { disk } = await this.resolve(id, index); return getSubtitleVtt(this.deps.ffmpeg(), disk, key); }
  async duration(id: string, index: number): Promise<number | null> {
    const { disk } = await this.resolve(id, index); const ffmpeg = this.deps.ffmpeg(); if (!ffmpeg) return null;
    return new Promise(resolve => {
      const p = spawn(ffmpeg, ['-i', disk], { windowsHide: true }); let output = '';
      const timer = setTimeout(() => { p.kill(); resolve(null); }, 5000);
      p.stderr.on('data', chunk => { if (output.length < 32768) output += String(chunk); });
      p.on('error', () => { clearTimeout(timer); resolve(null); });
      p.on('close', () => { clearTimeout(timer); const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(output);
        resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null); });
    });
  }
  stop(id: string): void { for (const key of this.local.keys()) if (key.startsWith(`${id}:`)) this.local.delete(key); if (!this.local.size) this.server.close(); }
  close(): void { this.local.clear(); this.server.close(); }
}
