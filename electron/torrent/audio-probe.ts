/**
 * Audio-track probe + the shared plumbing of the audio-track feature: stderr
 * parsing, the IPC track-list shape, the &a= URL param, and the ffmpeg -map
 * argument builder — one module so the two engines (webtorrent manager and the
 * native media-server) can never drift apart on any of it.
 *
 * ffprobe is NOT bundled (package.json ships only ffmpeg-static; cast-server's
 * probeDuration documents the same convention), and `ffmpeg -i <file>` with no
 * output exits non-zero while printing the stream table to stderr — so collect
 * stderr and ignore the exit code, exactly like probeSubtitleStreams.
 *
 * No Electron imports — runs in the torrent-host utilityProcess for both
 * engines, and the pure functions are unit-tested directly.
 */

import { spawn } from 'node:child_process';

export interface AudioTrackInfo {
  /** Ordinal for `-map 0:a:<aIndex>` — counts EVERY audio stream, decodable or not. */
  aIndex: number;
  lang?: string;
  codec: string;
  channels?: string; // 'stereo', '5.1(side)', …
  isDefault?: boolean;
  title?: string;
}

/** The wire shape of audioTracks:list (what the player's menu renders). */
export interface AudioTrackListItem {
  index: number;
  label: string;
  lang?: string;
  isDefault?: boolean;
  title?: string;
  codec?: string;
  channels?: string;
}

export function probeAudioStreams(ffmpegPath: string | null, filePath: string): Promise<AudioTrackInfo[]> {
  if (!ffmpegPath) return Promise.resolve([]);
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-i', filePath], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    proc.on('error', () => resolve([]));
    proc.on('close', () => resolve(parseAudioStreams(err)));
  });
}

/**
 * Parse the ffmpeg stream table. Typical lines:
 *   Stream #0:1(eng): Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s (default)
 *   Stream #0:2[0x2](pt-BR): Audio: ac3, 48000 Hz, 5.1(side), fltp, 448 kb/s
 * The prefix between the stream index and ': Audio:' is matched loosely
 * ([^:]*) — language tags are NOT limited to 2-3 letters (mkvmerge writes
 * BCP-47 like 'pt-BR'); a dropped line here would shift every later track's
 * -map ordinal onto the wrong stream, so err on the side of matching.
 * An optional following Metadata block may carry `title : …`.
 * Exported separately so the line format is unit-testable without ffmpeg.
 */
export function parseAudioStreams(stderr: string): AudioTrackInfo[] {
  const out: AudioTrackInfo[] = [];
  const lines = stderr.split(/\r?\n/);
  let aIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /Stream #\d+:\d+([^:]*): Audio: ([A-Za-z0-9_]+)(.*)/.exec(lines[i]);
    if (!m) continue;
    // Count every audio stream (even undecodable codecs) so aIndex stays
    // aligned with ffmpeg's -map 0:a:N ordinal — same rule the subtitle probe
    // follows for -map 0:s:N.
    aIndex++;
    const lang = /\(([^)]+)\)/.exec(m[1])?.[1];
    const rest = m[3] ?? '';
    const channels = /\d+ Hz, ([^,]+)/.exec(rest)?.[1]?.trim();
    const isDefault = /\(default\)/.test(rest) || undefined;
    let title: string | undefined;
    for (let j = i + 1; j < lines.length && !/Stream #/.test(lines[j]); j++) {
      const tm = /^\s+title\s*:\s*(.+)$/.exec(lines[j]);
      if (tm) { title = tm[1].trim(); break; }
    }
    out.push({ aIndex, lang, codec: m[2].toLowerCase(), channels, isDefault, title });
  }
  return out;
}

/** Map probed streams to the audioTracks:list wire shape (shared by both engines). */
export function audioTrackList(streams: AudioTrackInfo[]): AudioTrackListItem[] {
  return streams.map((s, i) => ({
    index: s.aIndex,
    label: s.title || [s.lang ? s.lang.toUpperCase() : `Track ${i + 1}`, s.codec, s.channels].filter(Boolean).join(' · '),
    lang: s.lang,
    isDefault: s.isDefault,
    title: s.title,
    codec: s.codec,
    channels: s.channels,
  }));
}

/** `&a=N` URL suffix for getStreamUrl, or '' when no explicit track was chosen. */
export function audioTrackParam(audioTrack: number | undefined): string {
  return Number.isInteger(audioTrack) && (audioTrack as number) >= 0 ? `&a=${audioTrack}` : '';
}

/** Parse the `a` query param back into a track ordinal (undefined = default). */
export function parseAudioTrackParam(raw: string | null): number | undefined {
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/**
 * The ffmpeg -map arguments for a transcode. Empty when no explicit track was
 * chosen: any -map disables ffmpeg's auto-selection, so default playback must
 * keep the historical no-map args byte-for-byte. The video map uses the
 * OPTIONAL form '0:v:0?' — media kind is classified by file EXTENSION, so a
 * "video" container may hold no video stream at all (audiobook rip named
 * .mkv), and a hard '0:v:0' would make ffmpeg exit with "matches no streams".
 */
export function transcodeMapArgs(kind: 'video' | 'audio' | 'other', audioTrack: number | undefined): string[] {
  if (audioTrack === undefined) return [];
  const audio = ['-map', `0:a:${audioTrack}`];
  return kind === 'audio' ? audio : ['-map', '0:v:0?', ...audio];
}
