/**
 * Path-based subtitle helpers: probe embedded TEXT subtitle streams, list
 * selectable tracks (embedded + sidecar files), and extract a chosen track as
 * WebVTT — everything keyed by an absolute media path, so any caller that can
 * resolve a file on disk (torrent engines, ROOMS) gets the same behavior.
 *
 * Extracted for the rooms player; the two torrent managers still carry their
 * own private copies of this logic (manager.ts / native-manager.ts) — folding
 * them onto this module is a pending cleanup, not a behavior requirement.
 *
 * `ffmpeg -i <file>` with no output exits non-zero while printing the stream
 * table to stderr — collect stderr, ignore the exit code (the audio-probe
 * convention). No Electron imports; safe in any process.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface SubtitleTrackItem {
  key: string;   // 'embedded:<sIndex>' | 'external:<filename>'
  label: string;
  lang?: string;
  source: 'embedded' | 'external';
}

/** Run ffmpeg and resolve its stdout as UTF-8 (VTT extraction). */
function ffmpegCapture(ffmpegPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    const out: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', () => { /* discard */ });
    proc.on('error', reject);
    proc.on('close', () => resolve(Buffer.concat(out).toString('utf8')));
  });
}

/** Parse `ffmpeg -i` stderr for embedded TEXT subtitle streams (skip image subs). */
export function probeSubtitleStreams(ffmpegPath: string | null, file: string): Promise<Array<{ sIndex: number; lang?: string; codec: string }>> {
  if (!ffmpegPath) return Promise.resolve([]);
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-i', file], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    proc.on('error', () => resolve([]));
    proc.on('close', () => {
      const out: Array<{ sIndex: number; lang?: string; codec: string }> = [];
      let sIndex = 0;
      const re = /Stream #\d+:\d+(?:\(([a-zA-Z]+)\))?: Subtitle: (\w+)/g;
      let m: RegExpExecArray | null;
      const textCodecs = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'srt']);
      while ((m = re.exec(err)) !== null) {
        const codec = m[2].toLowerCase();
        if (textCodecs.has(codec)) out.push({ sIndex, lang: m[1], codec });
        sIndex++; // count all subtitle streams so -map 0:s:<n> stays aligned
      }
      resolve(out);
    });
  });
}

/** List selectable tracks for a media path: embedded text subs + dir sidecars. */
export async function listSubtitleTracks(ffmpegPath: string | null, diskPath: string): Promise<SubtitleTrackItem[]> {
  const tracks: SubtitleTrackItem[] = [];
  try {
    const streams = await probeSubtitleStreams(ffmpegPath, diskPath);
    streams.forEach((s, i) => {
      tracks.push({ key: `embedded:${s.sIndex}`, label: s.lang ? `${s.lang.toUpperCase()} (embedded)` : `Embedded #${i + 1}`, lang: s.lang, source: 'embedded' });
    });
  } catch { /* ignore */ }
  try {
    for (const f of fs.readdirSync(path.dirname(diskPath))) {
      if (!/\.(srt|ass|ssa|vtt|sub)$/i.test(f)) continue;
      tracks.push({ key: `external:${f}`, label: f, source: 'external' });
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
