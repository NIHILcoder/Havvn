/**
 * Per-instance console: a bounded in-memory ring for the UI plus an appended
 * on-disk log for after the fact.
 *
 * The split matters. The renderer only ever needs the tail, and holding a whole
 * session's output in main would let a chatty server (a mod logging per tick)
 * grow this process without limit. The disk log is where the full history goes,
 * rotated so it cannot fill the disk either.
 *
 * Subscribers receive lines already normalised (ANSI stripped, control chars
 * removed, length capped) by shared/gameserver-core — the renderer never has to
 * interpret escape sequences, and game output cannot drive the terminal view.
 */
import fs from 'fs';
import path from 'path';
import { ensureDir } from './paths';
import { normalizeConsoleLine } from '../../shared/gameserver-core';
import { CONSOLE_BUFFER_LINES } from '../../shared/gameserver-types';
import type { ConsoleLine } from '../../shared/gameserver-types';
import { logger } from '../utils';

const log = logger.child('GameConsole');

/** Rotate at 8 MB, keep 3 generations — enough to cover a crash and its lead-up
 *  without ever costing more than ~32 MB per instance. */
const LOG_ROTATE_BYTES = 8 * 1024 * 1024;
const LOG_GENERATIONS = 3;

export class ConsoleBuffer {
  private lines: ConsoleLine[] = [];
  private seq = 0;
  private stream: fs.WriteStream | null = null;
  private written = 0;
  private readonly listeners = new Set<(line: ConsoleLine) => void>();

  constructor(private readonly logsDir: string) {}

  /** Sequence of the newest line; the renderer sends this back to resume. */
  get lastSeq(): number { return this.seq; }

  /** Tail of the buffer, oldest first. `after` resumes from a known sequence. */
  snapshot(after = 0, limit = CONSOLE_BUFFER_LINES): ConsoleLine[] {
    const fresh = after > 0 ? this.lines.filter((l) => l.seq > after) : this.lines;
    return fresh.length > limit ? fresh.slice(fresh.length - limit) : [...fresh];
  }

  subscribe(fn: (line: ConsoleLine) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Open (or reopen) the on-disk log for a new run. */
  openLog(): void {
    this.closeLog();
    try {
      ensureDir(this.logsDir);
      const file = path.join(this.logsDir, 'console.log');
      this.rotateIfNeeded(file);
      this.stream = fs.createWriteStream(file, { flags: 'a' });
      // A failed log write must never take the server down with it.
      this.stream.on('error', (err) => {
        log.warn('console log write failed', { err: String(err) });
        this.stream = null;
      });
      this.written = fs.existsSync(file) ? fs.statSync(file).size : 0;
    } catch (err) {
      log.warn('could not open console log', { err: String(err) });
      this.stream = null;
    }
  }

  closeLog(): void {
    // destroy(), not end(): end() finishes asynchronously and on Windows leaves
    // the file locked long enough for a following rmSync of the instance folder
    // to throw ENOTEMPTY. destroy() drops the handle immediately.
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    try {
      stream.destroy();
    } catch {
      /* already closed */
    }
  }

  private rotateIfNeeded(file: string): void {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // no log yet
    }
    if (size < LOG_ROTATE_BYTES) return;
    for (let i = LOG_GENERATIONS - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      const to = `${file}.${i}`;
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch {
        // A locked generation is not worth failing a server start over.
      }
    }
  }

  /** Append one already-split line. */
  push(stream: ConsoleLine['stream'], raw: string): ConsoleLine {
    const text = normalizeConsoleLine(raw);
    const line: ConsoleLine = { seq: ++this.seq, at: Date.now(), stream, text };

    this.lines.push(line);
    if (this.lines.length > CONSOLE_BUFFER_LINES) {
      this.lines.splice(0, this.lines.length - CONSOLE_BUFFER_LINES);
    }

    if (this.stream) {
      const record = `${new Date(line.at).toISOString()} ${stream === 'err' ? 'E' : stream === 'sys' ? '*' : ' '} ${text}\n`;
      this.written += record.length;
      this.stream.write(record);
      if (this.written >= LOG_ROTATE_BYTES) this.openLog(); // reopens with rotation
    }

    for (const fn of this.listeners) {
      try {
        fn(line);
      } catch (err) {
        log.warn('console subscriber threw', { err: String(err) });
      }
    }
    return line;
  }

  /** A line from Havvn itself rather than the process ("starting…", "exited"). */
  system(text: string): ConsoleLine {
    return this.push('sys', text);
  }

  clear(): void {
    this.lines = [];
  }
}
