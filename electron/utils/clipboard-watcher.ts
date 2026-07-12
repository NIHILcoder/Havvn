/**
 * Clipboard magnet watcher (opt-in, default OFF).
 *
 * Polls the OS clipboard every 2s from the MAIN process (so it keeps working
 * in closed-to-tray mode) and, when a NEW magnet link appears, routes it
 * through the same OS-open flow as a double-clicked .torrent file
 * (deliverOpenTorrent → window fronts → add dialog opens). Never adds
 * silently.
 *
 * Privacy: the poll inevitably sees everything the user copies, so only a
 * sha1 of the last-seen text is kept in memory for dedupe — clipboard contents
 * are never logged, persisted, or sent anywhere. The settings description
 * spells the polling out; enabling is an explicit choice.
 *
 * Enabled via AppSettings.clipboardWatchEnabled (restart hook in
 * handlers.ts 'settings:update', same pattern as disk-guard).
 */

import crypto from 'node:crypto';
import { clipboard } from 'electron';
import { logger } from './logger';
import * as db from '../db/store';
import { extractInfoHashFromMagnet } from '../../shared/magnet';

const log = logger.child('ClipboardWatch');

const POLL_INTERVAL_MS = 2_000;

let timer: NodeJS.Timeout | null = null;
let deliver: ((uri: string) => void) | null = null;
let hasWindow: (() => boolean) | null = null;
let seeded = false;
let lastSeenHash = '';
let lastDeliveredInfoHash = '';

const sha1 = (s: string): string => crypto.createHash('sha1').update(s).digest('hex');

export function initClipboardWatcher(opts: { deliver: (uri: string) => void; hasWindow: () => boolean }): void {
  deliver = opts.deliver;
  hasWindow = opts.hasWindow;
  void restartClipboardWatcherFromConfig();
}

/** (Re)start or stop the poll loop based on the persisted setting. */
export async function restartClipboardWatcherFromConfig(): Promise<void> {
  let enabled = false;
  try {
    enabled = (await db.getSettings()).clipboardWatchEnabled === true;
  } catch {
    enabled = false;
  }

  stopClipboardWatcher();
  if (!enabled) {
    log.info('Clipboard magnet watcher disabled');
    return;
  }

  // Seed the dedupe state with whatever is in the clipboard RIGHT NOW: a
  // magnet already sitting there must not pop the add dialog the moment the
  // toggle (or the app) turns on — only a fresh copy fires. If the read fails
  // (clipboard locked), the FIRST successful tick seeds instead of delivering,
  // so a transient failure here can't leak a pre-existing magnet through.
  try {
    lastSeenHash = sha1(clipboard.readText().trim());
    seeded = true;
  } catch {
    lastSeenHash = '';
    seeded = false;
  }
  lastDeliveredInfoHash = '';
  log.info('Clipboard magnet watcher enabled');
  timer = setInterval(tick, POLL_INTERVAL_MS);
}

export function stopClipboardWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function tick(): void {
  try {
    if (!hasWindow?.()) return;
    const text = clipboard.readText().trim();
    const hash = sha1(text);
    if (!seeded) {
      // The enable-time seed failed — this first successful read becomes the
      // baseline; deliver only what is copied AFTER it.
      seeded = true;
      lastSeenHash = hash;
      return;
    }
    if (!text || hash === lastSeenHash) return;
    lastSeenHash = hash;
    // Validate + normalize: malformed and v2-only (btmh) magnets are ignored
    // (the engine can't add them). The infohash latch stops a dn=-tweaked copy
    // of the SAME magnet from re-opening the dialog, but copying anything ELSE
    // clears it — deliberately re-copying a magnet later (after the dialog was
    // cancelled, or to re-add a removed torrent) works again.
    const infoHash = text.startsWith('magnet:?') ? extractInfoHashFromMagnet(text) : null;
    if (!infoHash) {
      lastDeliveredInfoHash = '';
      return;
    }
    if (infoHash === lastDeliveredInfoHash) return;
    lastDeliveredInfoHash = infoHash;
    log.info('Magnet link detected in clipboard — opening the add dialog');
    deliver?.(text);
  } catch {
    // Clipboard locked by another app / non-text content — skip this tick
    // WITHOUT touching lastSeenHash, so a transient failure can't re-fire.
  }
}
