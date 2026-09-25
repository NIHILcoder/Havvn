/**
 * Path-based subtitle helpers: probe embedded TEXT subtitle streams, list
 * selectable tracks (embedded + sidecar files), and extract a chosen track as
 * WebVTT — everything keyed by an absolute media path, so any caller that can
 * resolve a file on disk (torrent engines, ROOMS) gets the same behavior.
 *
 * Shared by the rooms player and both torrent engines so language, title and
 * sidecar association metadata agree everywhere.
 *
 * `ffmpeg -i <file>` with no output exits non-zero while printing the stream
 * table to stderr — collect stderr, ignore the exit code (the audio-probe
 * convention). No Electron imports; safe in any process.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { trackLanguage } from '../../shared/player-preferences';

export interface SubtitleTrackItem {
  key: string;   // 'embedded:<sIndex>' | 'external:<filename>'
  label: string;
  lang?: string;
  source: 'embedded' | 'external';
  title?: string;
  codec?: string;
  associated?: boolean;
}

/** Run ffmpeg and resolve its stdout as UTF-8 (VTT extraction). */
function ffmpegCapture(ffmpegPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    const out: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', () => { /* discard */ });
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error('Subtitle conversion failed')));
  });
}

/** Parse `ffmpeg -i` stderr for embedded TEXT subtitle streams (skip image subs). */
export function parseSubtitleStreams(stderr: string): Array<{ sIndex: number; lang?: string; codec: string; title?: string }> {
  const out: Array<{ sIndex: number; lang?: string; codec: string; title?: string }> = [];
  const lines = stderr.split(/\r?\n/);
  let sIndex = -1;
  const textCodecs = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'srt']);
  for (let i = 0; i < lines.length; i++) {
    const match = /Stream #\d+:\d+([^:]*): Subtitle: (\w+)/.exec(lines[i]);
    if (!match) continue;
    sIndex++;
    const codec = match[2].toLowerCase();
    if (!textCodecs.has(codec)) continue;
    let title: string | undefined;
    for (let j = i + 1; j < lines.length && !/Stream #/.test(lines[j]); j++) {
      const found = /^\s+title\s*:\s*(.+)$/.exec(lines[j]); if (found) { title = found[1].trim(); break; }
    }
    out.push({ sIndex, lang: /\(([^)]+)\)/.exec(match[1])?.[1], codec, title });
  }
  return out;
}
export function probeSubtitleStreams(ffmpegPath: string | null, file: string): Promise<ReturnType<typeof parseSubtitleStreams>> {
  if (!ffmpegPath) return Promise.resolve([]);
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-i', file], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    proc.on('error', () => resolve([]));
    proc.on('close', () => resolve(parseSubtitleStreams(err)));
  });
}

/** List selectable tracks for a media path: embedded text subs + dir sidecars. */
export async function listSubtitleTracks(ffmpegPath: string | null, diskPath: string): Promise<SubtitleTrackItem[]> {
  const tracks: SubtitleTrackItem[] = [];
  try {
    const streams = await probeSubtitleStreams(ffmpegPath, diskPath);
    streams.forEach((s, i) => {
      tracks.push({ key: `embedded:${s.sIndex}`, label: s.title || (s.lang ? `${s.lang.toUpperCase()} (embedded)` : `Embedded #${i + 1}`),
        lang: s.lang, title: s.title, codec: s.codec, source: 'embedded' });
    });
  } catch { /* ignore */ }
  try {
    for (const f of fs.readdirSync(path.dirname(diskPath))) {
      if (!/\.(srt|ass|ssa|vtt|sub)$/i.test(f)) continue;
      const base = path.basename(diskPath, path.extname(diskPath)).toLowerCase();
      const stem = path.basename(f, path.extname(f)).toLowerCase();
      const associated = stem === base || ['.', '_', ' ', '-'].some(separator => stem.startsWith(base + separator));
      const suffix = associated ? /^[._ -]+([a-z]{2,3})(?:[-_][a-z]{2})?(?:[._ -]|$)/i.exec(stem.slice(base.length))?.[1] : undefined;
      const language = trackLanguage(suffix);
      const lang = ['ru', 'en', 'uk', 'be', 'ja', 'ko', 'zh', 'fr', 'de', 'es', 'it', 'pt', 'pl', 'tr', 'ar', 'hi'].includes(language) ? language : undefined;
      tracks.push({ key: `external:${f}`, label: f, source: 'external', associated, lang });
    }
  } catch { /* ignore */ }
  return tracks;
}

/** Return the chosen track (from listSubtitleTracks keys) as WebVTT text. */
export async function getSubtitleVtt(ffmpegPath: string | null, diskPath: string, key: string): Promise<string> {
  if (key.startsWith('embedded:')) {
    if (!ffmpegPath) throw new Error('ffmpeg unavailable');
    const sIndex = Number(key.slice('embedded:'.length));
    if (!Number.isInteger(sIndex) || sIndex < 0) throw new Error('Unknown subtitle track');
    return ffmpegCapture(ffmpegPath, ['-i', diskPath, '-map', `0:s:${sIndex}`, '-f', 'webvtt', 'pipe:1']);
  }
  if (key.startsWith('external:')) {
    const name = key.slice('external:'.length);
    // The key names a file INSIDE the media's directory — never a path.
    if (name.includes('/') || name.includes('\\') || name.includes('..')) throw new Error('Unknown subtitle track');
    const full = path.join(path.dirname(diskPath), name);
    if (!fs.existsSync(full)) throw new Error('Subtitle file not found');
    if (/\.vtt$/i.test(full)) return fs.readFileSync(full, 'utf8');
    if (!ffmpegPath) throw new Error('ffmpeg unavailable');
    return ffmpegCapture(ffmpegPath, ['-i', full, '-f', 'webvtt', 'pipe:1']);
  }
  throw new Error('Unknown subtitle track');
}
