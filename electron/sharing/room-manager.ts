/**
 * RoomManager — main-process proxy for friend swarms (Phase 3).
 *
 * Mirrors ShareManager: it owns a hidden BrowserWindow whose preload
 * (room-engine.ts) runs the actual WebRTC rendezvous + WebTorrent transfers,
 * and it message-passes commands to it. On top of that it:
 *   • persists joined rooms (electron-store) and re-joins them on startup,
 *   • supplies this install's identity + ICE/TURN config to the engine,
 *   • caches the latest RoomState per room and forwards live updates to the
 *     renderer (channel 'rooms:update').
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { BrowserWindow, ipcMain, app, shell } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils';
import { t } from '../i18n';
import * as db from '../db/store';
import { RoomState, RoomSummary, RoomProfile, VoiceSettings, VoiceDeviceInfo } from '../../shared/types';
import { generateRoomCode, normalizeCode, codeIsE2E, parseInvite } from './room-crypto';
import { classifyMediaKind, isDirectlyPlayable } from '../../shared/media';
import { listSubtitleTracks, getSubtitleVtt, SubtitleTrackItem } from '../torrent/subtitle-probe';
import { generateRoomSecret } from './room-e2e';
import { serializeMirrorBody } from '../gameserver/server-mirror';
import { decideGlobalPtt, isGlobalPttAvailable, resolveUiohookKeycode, startGlobalPtt, stopGlobalPtt } from '../utils/global-ptt';
import { getLanManager } from '../lan/lan-manager';
import { evaluateLanDiagnostics } from '../../shared/lan-quality';
import type { LanDiagInput, LanDiagReport } from '../../shared/lan-quality';
import {
  withPicks, addPick, removePick, addApp, removeApp, sameLanPrefs,
  reusableSessionId, sessionFloor, withSession, noteSessionFloor, rotateSession,
} from '../../shared/lan-prefs';
import type { LanRoomPrefs } from '../../shared/lan-prefs';

const log = logger.child('RoomManager');

// Same relay set as share links — friends behind symmetric NATs need TURN to
// connect. Honors the existing "Use TURN relays" privacy toggle.
import { customTurnToIce, resolveTrackers } from './ice-servers';
import { showOsNotification } from '../utils/os-notify';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

function slugify(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'room';
}

export class RoomManager {
  private win: BrowserWindow | null = null;
  private mainWindow: BrowserWindow | null = null;
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private pending = new Map<number, Pending>();
  private reqSeq = 0;
  private ipcWired = false;
  private cache = new Map<string, RoomState>();
  // Set by the VPN kill-switch: while true, no room may (re)join the network —
  // every lazy reactivation funnels through reactivate(), so gating it there
  // closes every re-leak path at once.
  private networkSuspended = false;
  // Last global voice settings the renderer sent — re-asserted on engine respawn
  // (the engine's own store is session-only and would reset to defaults).
  private voiceSettingsCache: VoiceSettings | null = null;
  // Phase 2B relay willingness (AppSettings.lanRelayEnabled, absent ⇒ true).
  // Cached for the same reason as voiceSettingsCache — the engine store is
  // session-only, so a respawned window would come back willing to relay after
  // the user switched it off. null = not read from the store yet.
  private lanRelayCache: boolean | null = null;
  // Global push-to-talk config (renderer prefs) + what the hook is currently
  // tuned to. The OS key hook runs ONLY while some room is in voice in PTT mode.
  private globalPtt: { enabled: boolean; keycode: number | null } = { enabled: false, keycode: null };
  private globalPttTarget: { roomId: string; keycode: number } | null = null;

  // The room currently open on screen (reported by the renderer). Activity in this
  // room is not OS-notified (the user is already looking at it).
  private activeRoomId: string | null = null;
  // Per-room OS-notification throttle so a hostile member can't detonate a toast
  // storm — at most one toast per room per NOTIFY_COOLDOWN_MS.
  private lastNotify = new Map<string, number>();
  /** Hooks fired after every live RoomState push (prev may be undefined). */
  private roomUpdateHooks = new Set<(state: RoomState, prev: RoomState | undefined) => void>();

  constructor() {
    // Renderer-facing liveness channels live HERE (not ipc/handlers.ts): they
    // are room-stack plumbing end to end, and the singleton constructor makes
    // the ipcMain.handle registration run exactly once.
    ipcMain.handle('rooms:typing', async (_e, roomId: string) => { this.typing(String(roomId || '')); return { ok: true }; });
    ipcMain.handle('rooms:reactFile', async (_e, roomId: string, fileId: string, emoji: string) =>
      this.reactFile(String(roomId || ''), String(fileId || ''), String(emoji || '')));
    ipcMain.handle('rooms:reactChat', async (_e, roomId: string, msgId: string, emoji: string) =>
      this.reactChat(String(roomId || ''), String(msgId || ''), String(emoji || '')));
    // Wire the main-process LAN helper lifecycle to this manager. `isNetSuspended`
    // is re-read AFTER the UAC await (plan §7); teardown is cooperative — main
    // cannot force-kill the elevated helper (medium→high IL = Access Denied), it
    // asks the engine to send the pipe `shutdown` verb.
    getLanManager().configure({
      isNetSuspended: () => this.networkSuspended,
      requestEngineShutdown: () => {
        const rid = getLanManager().activeRoomId();
        if (rid) { try { void this.call('lanStop', { roomId: rid }, 5000).catch(() => { /* engine gone */ }); } catch { /* ignore */ } }
      },
      onWarning: (msg: string) => {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.webContents.send('rooms:lanWarn', String(msg || ''));
      },
      log: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => { try { (log as any)[level]?.(msg, extra); } catch { /* ignore */ } },
    });
  }

  setMainWindow(win: BrowserWindow): void { this.mainWindow = win; }

  /** Subscribe to room state pushes. Returns an unsubscribe function. */
  onRoomUpdate(hook: (state: RoomState, prev: RoomState | undefined) => void): () => void {
    this.roomUpdateHooks.add(hook);
    return () => { this.roomUpdateHooks.delete(hook); };
  }

  private wireIpc(): void {
    if (this.ipcWired) return;
    this.ipcWired = true;
    ipcMain.on('room-res', (_e, msg: any) => {
      const p = this.pending.get(msg?.reqId);
      if (!p) return;
      this.pending.delete(msg.reqId);
      if (msg.ok) p.resolve(msg.data); else p.reject(new Error(msg.error || 'Room error'));
    });
    ipcMain.on('room-ready', () => {
      this.ready = true;
      const waiters = this.readyWaiters; this.readyWaiters = [];
      waiters.forEach((f) => f());
    });
    ipcMain.on('room-update', (_e, state: RoomState) => {
      const prev = state?.roomId ? this.cache.get(state.roomId) : undefined;
      if (state?.roomId) this.cache.set(state.roomId, state);
      this.reevalGlobalPtt(); // voice/inputMode may have changed — retune the OS key hook
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('rooms:update', state);
      }
      for (const hook of this.roomUpdateHooks) {
        try { hook(state, prev); } catch (e) { log.warn('room update hook failed', { err: String(e) }); }
      }
    });
    ipcMain.on('room-log', (_e, m: any) => log.info('Engine', { msg: String(m) }));
    // Watch-together: forward a peer's playback control to the renderer player.
    ipcMain.on('room-sync', (_e, payload: any) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('rooms:sync', payload);
      }
    });
    // Live mic level while a settings-modal mic test runs (≈10 Hz, fire-and-forget).
    ipcMain.on('room-mic-level', (_e, payload: { level: number }) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('rooms:micLevel', Number(payload?.level) || 0);
      }
    });
    // Screen-watch loopback signaling: engine forwarder → visible renderer.
    ipcMain.on('room-screen-signal', (_e, payload: { roomId: string; memberId: string; kind: string; data?: unknown }) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('rooms:screenSignal', payload);
      }
    });
    // Audio hardware changed in the engine window — the UI should refresh pickers.
    ipcMain.on('room-voice-devices', () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('rooms:voiceDevicesChanged');
      }
    });
    // A folder was deleted — drop its persisted auto-fetch override too.
    ipcMain.on('room-folder-fetch-del', (_e, payload: { roomId: string; folderId: string }) => {
      try { if (payload?.roomId && payload?.folderId) db.setRoomFolderFetch(payload.roomId, payload.folderId, null); } catch { /* ignore */ }
    });
    // Transient voice warning from the engine (e.g. a mid-call mic fell back).
    ipcMain.on('room-voice-warn', (_e, payload: { msg: string }) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('rooms:voiceWarn', String(payload?.msg || ''));
      }
    });
    // Transient virtual-LAN warning from the engine (UAC cancelled, helper crashed,
    // driver missing, direct-connect failed) — surfaced as a renderer toast.
    ipcMain.on('room-lan-warn', (_e, payload: { msg: string }) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('rooms:lanWarn', String(payload?.msg || ''));
      }
    });
    // The LAN session's admit/evict anti-replay watermark advanced. Persisting it
    // is what lets the NEXT run re-enter the same session id — and therefore keep
    // the same subnet and vIPs — without re-opening the cross-session replay the
    // id gate normally closes. Rare (a handful per session: admits at start, an
    // invite, an evict, a rekey re-mint); noteSessionFloor ignores anything for
    // another session and never moves the number backwards.
    ipcMain.on('room-lan-floor', (_e, payload: { roomId: string; sessionId: string; at: number }) => {
      const roomId = String(payload?.roomId || '');
      const sessionId = String(payload?.sessionId || '');
      const at = Number(payload?.at);
      if (!roomId || !sessionId || !Number.isSafeInteger(at)) return;
      this.updateLanPrefs(roomId, (p) => noteSessionFloor(p, sessionId, at));
    });
    // A file was deleted — persist the tombstone so it stays gone after restart,
    // plus its author/owner signature (when present) so the deletion re-verifies
    // as it gossips and survives our own restart as an authenticated tombstone.
    ipcMain.on('room-tomb', (_e, payload: { roomId: string; fileId: string; at?: number; by?: string; pub?: string; sig?: string }) => {
      try {
        if (!payload?.roomId || !payload?.fileId) return;
        db.addRoomTombstone(payload.roomId, payload.fileId, Number(payload.at) || Date.now());
        if (payload.by && payload.pub && payload.sig) {
          db.addRoomTombstoneProof(payload.roomId, payload.fileId, { by: payload.by, pub: payload.pub, sig: payload.sig });
        }
      } catch { /* ignore */ }
    });
    // A file was explicitly re-shared after deletion — lift the persisted
    // tombstone (and its proof) so the revive survives restart.
    ipcMain.on('room-tomb-del', (_e, payload: { roomId: string; fileId: string }) => {
      try {
        if (!payload?.roomId || !payload?.fileId) return;
        db.removeRoomTombstone(payload.roomId, payload.fileId);
        db.removeRoomTombstoneProof(payload.roomId, payload.fileId);
      } catch { /* ignore */ }
    });
    // A VERIFIED revive — persist its revAt so the re-deletion guard survives a
    // restart (a re-gossiped equal/older tombstone can't silently re-delete it).
    ipcMain.on('room-revive', (_e, payload: { roomId: string; fileId: string; revAt?: number }) => {
      try { if (payload?.roomId && payload?.fileId && Number.isFinite(payload.revAt)) db.addRoomRevive(payload.roomId, payload.fileId, Number(payload.revAt)); } catch { /* ignore */ }
    });
    // A strictly-newer deletion superseded the revive — drop the persisted guard.
    ipcMain.on('room-revive-del', (_e, payload: { roomId: string; fileId: string }) => {
      try { if (payload?.roomId && payload?.fileId) db.removeRoomRevive(payload.roomId, payload.fileId); } catch { /* ignore */ }
    });
    // A file entered/changed in a room's manifest — persist it so the room shows
    // and re-seeds it immediately on the next launch, before peers reconnect.
    ipcMain.on('room-manifest-add', (_e, payload: { roomId: string; file: import('../../shared/types').PersistedRoomFile }) => {
      try { if (payload?.roomId && payload?.file?.fileId) db.upsertRoomManifestFile(payload.roomId, payload.file); } catch { /* ignore */ }
    });
    ipcMain.on('room-manifest-del', (_e, payload: { roomId: string; fileId: string }) => {
      try { if (payload?.roomId && payload?.fileId) db.removeRoomManifestFile(payload.roomId, payload.fileId); } catch { /* ignore */ }
    });
    // A folder was created/edited (ours or a peer's) — persist so it (and the
    // file grouping) survives restart, before peers reconnect.
    ipcMain.on('room-folder-upsert', (_e, payload: { roomId: string; folder: import('../../shared/types').PersistedRoomFolder }) => {
      try { if (payload?.roomId && payload?.folder?.id) db.upsertRoomFolder(payload.roomId, payload.folder); } catch { /* ignore */ }
    });
    // A folder was deleted — persist the tombstone; drop it from the set ONLY if
    // the engine actually removed it (an edit-after-delete keeps a newer folder
    // live, and dropping it here would make it vanish on the next restart).
    ipcMain.on('room-folder-del', (_e, payload: { roomId: string; id: string; at?: number; removed?: boolean }) => {
      try {
        if (payload?.roomId && payload?.id) {
          db.addRoomFolderTombstone(payload.roomId, payload.id, Number(payload.at) || Date.now());
          if (payload.removed !== false) db.removeRoomFolder(payload.roomId, payload.id);
        }
      } catch { /* ignore */ }
    });
    // A new activity-log event was observed — persist it (capped) so the room's
    // history survives restart.
    ipcMain.on('room-history-add', (_e, payload: { roomId: string; event: import('../../shared/types').RoomEvent }) => {
      try {
        if (!payload?.roomId || !payload?.event?.id) return;
        db.appendRoomEvents(payload.roomId, [payload.event]);
        // Notify when SOMEONE ELSE adds a file to a room you're not looking at.
        const ev = payload.event;
        if (ev.type === 'file-added' && ev.actorId && ev.actorId !== db.getRoomProfile().memberId) {
          this.notifyRoomActivity(payload.roomId, ev.actorName || t('notify.room.someone'), t('notify.room.sharedFile', { file: ev.fileName || t('notify.room.aFile') }));
        }
      } catch { /* ignore */ }
    });
    // A chat message (sent or received) — persist it (capped, deduped by id) and,
    // if it's from someone else and not the room you're looking at, OS-notify.
    ipcMain.on('room-chat-add', (_e, payload: { roomId: string; message: import('../../shared/types').RoomChatMessage; backfill?: boolean }) => {
      try {
        if (!payload?.roomId || !payload?.message?.id) return;
        const isNew = db.appendRoomChats(payload.roomId, [payload.message]);
        const m = payload.message;
        if (isNew && !payload.backfill && m.memberId && m.memberId !== db.getRoomProfile().memberId) {
          // If you're looking at this room (and the window is focused), the message
          // is already read — no badge; else notify (rate-limited per room).
          if (payload.roomId === this.activeRoomId && this.mainWindowFocused()) db.setRoomLastRead(payload.roomId, Date.now());
          // A message naming the user is a mention — it may bypass the normal
          // per-room notification cooldown (but never a muted room). Word-
          // boundary match: a short name must not fire inside ordinary words
          // ("Ann" in "channel"), and the text is peer-controlled.
          const selfName = (db.getRoomProfile().name || '').trim();
          let mentioned = false;
          if (selfName.length >= 2) {
            try {
              const esc = selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              mentioned = new RegExp(`(^|[^\\p{L}\\p{N}_])${esc}($|[^\\p{L}\\p{N}_])`, 'iu').test(m.text || '');
            } catch { /* exotic name — fall back to no bypass */ }
          }
          this.notifyRoomActivity(payload.roomId, m.name || t('notify.room.someone'), m.text || '', mentioned);
        }
      } catch { /* ignore */ }
    });
    // A file reaction toggled (ours or a peer's) — persist the room's whole
    // reaction map (toggles don't append well) so it survives restart.
    ipcMain.on('room-reacts', (_e, payload: { roomId: string; reacts: Record<string, Record<string, string[]>> }) => {
      try { if (payload?.roomId && payload?.reacts) db.setRoomReacts(payload.roomId, payload.reacts); } catch { /* ignore */ }
    });
    ipcMain.on('room-chat-reacts', (_e, payload: { roomId: string; reacts: Record<string, Record<string, string[]>> }) => {
      try { if (payload?.roomId && payload?.reacts) db.setRoomChatReacts(payload.roomId, payload.reacts); } catch { /* ignore */ }
    });
    ipcMain.on('room-chat-edits', (_e, payload: { roomId: string; edits: Record<string, { text: string; at: number; by: string; pub: string; sig: string }> }) => {
      try { if (payload?.roomId && payload?.edits) db.setRoomChatEdits(payload.roomId, payload.edits); } catch { /* ignore */ }
    });
    // The engine TOFU-bound a member's public key — persist so the binding (and
    // thus anti-impersonation) survives restarts.
    ipcMain.on('room-identity-add', (_e, payload: { roomId: string; memberId: string; pub: string }) => {
      try { if (payload?.roomId && payload?.memberId && payload?.pub) db.addRoomIdentity(payload.roomId, payload.memberId, payload.pub); } catch { /* ignore */ }
    });
    // A joiner learned who the room owner is from a peer — persist it.
    ipcMain.on('room-owner', (_e, payload: { roomId: string; ownerId: string }) => {
      try {
        if (!payload?.roomId || !payload?.ownerId) return;
        const r = db.getPersistedRooms().find((x) => x.roomId === payload.roomId);
        if (r && r.ownerId !== payload.ownerId) {
          db.savePersistedRoom({ ...r, ownerId: payload.ownerId });
          log.info('Room owner learned from peer', { roomId: payload.roomId });
        }
      } catch { /* ignore */ }
    });
    // An ownership transfer applied (or the chain grew) — persist the WHOLE
    // chain (capped) so a restart re-verifies and re-serves it to joiners.
    ipcMain.on('room-transfer', (_e, payload: { roomId: string; chain: db.PersistedRoom['transferChain'] }) => {
      try {
        if (!payload?.roomId || !Array.isArray(payload.chain)) return;
        const r = db.getPersistedRooms().find((x) => x.roomId === payload.roomId);
        if (!r) return;
        const chain = payload.chain.slice(0, 8).map((l) => ({
          newOwnerId: String(l?.newOwnerId || ''), at: Number(l?.at) || 0,
          by: String(l?.by || ''), pub: String(l?.pub || ''), sig: String(l?.sig || ''),
        })).filter((l) => l.newOwnerId && l.by && l.pub && l.sig && l.at > 0);
        if (JSON.stringify(r.transferChain || []) !== JSON.stringify(chain)) {
          db.savePersistedRoom({ ...r, transferChain: chain });
          log.info('Room ownership-transfer chain persisted', { roomId: payload.roomId, links: chain.length });
        }
      } catch { /* ignore */ }
    });
    // The room was rekeyed (a member was kicked) — persist the new invite code so
    // reconnecting/restarting lands on the new swarm, not the abandoned one.
    ipcMain.on('room-rekey', (_e, payload: { roomId: string; code: string; banId?: string }) => {
      try {
        if (!payload?.roomId || !payload?.code) return;
        const r = db.getPersistedRooms().find((x) => x.roomId === payload.roomId);
        if (!r) return;
        const banId = String(payload.banId || '');
        const bans = banId && !(r.bans || []).includes(banId) ? [...(r.bans || []), banId] : r.bans;
        if (r.code !== payload.code || bans !== r.bans) {
          db.savePersistedRoom({ ...r, code: payload.code, ...(bans ? { bans } : {}) });
          log.info('Room rekeyed', { roomId: payload.roomId, banned: !!banId });
        }
      } catch { /* ignore */ }
    });
    // A joiner learned the room's E2E mode + content secret from a peer — persist
    // them (with the owner-signed config blob, so it can be re-verified and
    // re-served after restart) so encrypted files keep decrypting.
    ipcMain.on('room-e2e', (_e, payload: { roomId: string; e2e: boolean; secret: string; prevSecrets?: string[]; cfg?: db.PersistedRoom['e2eCfg'] }) => {
      try {
        if (!payload?.roomId) return;
        const r = db.getPersistedRooms().find((x) => x.roomId === payload.roomId);
        const cfg = payload.cfg || undefined;
        const prev = Array.isArray(payload.prevSecrets) ? payload.prevSecrets.slice(0, 8) : [];
        if (r && (r.e2e !== payload.e2e || r.secret !== payload.secret || r.e2eCfg?.sig !== cfg?.sig
          || JSON.stringify(r.prevSecrets || []) !== JSON.stringify(prev))) {
          db.savePersistedRoom({ ...r, e2e: payload.e2e, secret: payload.secret, prevSecrets: prev, e2eCfg: cfg });
          log.info('Room E2E config learned from peer', { roomId: payload.roomId, e2e: payload.e2e, signed: !!cfg, keyring: prev.length });
        }
      } catch { /* ignore */ }
    });
    // A joiner learned the room's friendly name from a peer (it had only the
    // code) — persist it so the name survives restart and shows in the list even
    // before the room reconnects. Live UI updates ride the normal room-update.
    ipcMain.on('room-name', (_e, payload: { roomId: string; name: string; at?: number }) => {
      try {
        if (!payload?.roomId || !payload?.name) return;
        const r = db.getPersistedRooms().find((x) => x.roomId === payload.roomId);
        const at = Math.min(Number(payload.at) || 0, Date.now() + 60_000); // never persist a future clock (LWW-wedge guard)
        if (r && (r.name !== payload.name || at > (r.nameAt ?? 0))) {
          db.savePersistedRoom({ ...r, name: payload.name, ...(at ? { nameAt: at } : {}) });
          log.info('Room name updated', { roomId: payload.roomId, name: payload.name });
        }
      } catch { /* ignore */ }
    });
    // Topic changed (signed gossip / owner set / hello bootstrap) — persist it.
    ipcMain.on('room-topic', (_e, payload: { roomId: string; text?: string; at?: number; by?: string; pub?: string; sig?: string }) => {
      try {
        if (!payload?.roomId) return;
        const r = db.getPersistedRooms().find((x) => x.roomId === payload.roomId);
        const at = Math.min(Number(payload.at) || 0, Date.now() + 60_000); // never persist a future clock (LWW-wedge guard)
        const text = String(payload.text ?? '').slice(0, 300);
        if (r && (r.topic !== text || at > (r.topicAt ?? 0))) {
          db.savePersistedRoom({
            ...r, topic: text, ...(at ? { topicAt: at } : {}),
            // The signature travels with the topic so we can re-serve it in
            // HELLOs after a restart (receivers re-verify — never trusted).
            topicBy: String(payload.by ?? ''), topicPub: String(payload.pub ?? ''), topicSig: String(payload.sig ?? ''),
          });
        }
      } catch { /* ignore */ }
    });
  }

  private failAll(message: string): void {
    for (const [, p] of this.pending) p.reject(new Error(message));
    this.pending.clear();
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    this.wireIpc();
    if (this.win && !this.win.isDestroyed()) {
      if (this.ready) return this.readied(this.win);
      await new Promise<void>((res) => this.readyWaiters.push(res));
      return this.readied(this.win);
    }
    this.ready = false;
    const preload = path.join(__dirname, 'room-engine.js');
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload,
        nodeIntegration: false,
        contextIsolation: false, // preload shares the page window (native WebRTC)
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log.warn('Room window renderer gone', { reason: details?.reason });
      this.failAll('Room networking stopped unexpectedly (the engine crashed).');
      this.ready = false;
      if (this.win === win) this.win = null;
      // The engine window owned the LAN session's pipe; with it gone the helper is
      // orphaned. Tear it down (its own PID-watchdog is the backstop).
      getLanManager().onEngineGone();
      // The cached RoomStates are now stale (their engine is gone); leaving them
      // would keep decideGlobalPtt seeing voice.inVoice=true and the OS key hook
      // installed with no session behind it. Clear + re-evaluate so the hook stops.
      this.cache.clear();
      this.reevalGlobalPtt();
    });
    win.on('closed', () => {
      if (this.win === win) { this.win = null; this.ready = false; this.cache.clear(); this.reevalGlobalPtt(); }
    });
    this.win = win;
    // Load a blank file:// page, NOT about:blank: file:// is a SECURE CONTEXT, so
    // navigator.mediaDevices exists and the engine can capture the mic for voice
    // chat (a top-level about:blank is not trustworthy → getUserMedia is undefined).
    // The page is just a host for the preload (which does all the work).
    let enginePage = '';
    try {
      enginePage = path.join(app.getPath('userData'), 'room-engine.html');
      if (!fs.existsSync(enginePage)) {
        fs.writeFileSync(enginePage, '<!doctype html><html><head><meta charset="utf-8"><title>engine</title></head><body></body></html>');
      }
    } catch { enginePage = ''; }
    if (enginePage) {
      try { await win.loadFile(enginePage); } catch { await win.loadURL('about:blank'); }
    } else {
      await win.loadURL('about:blank');
    }
    if (!this.ready) await new Promise<void>((res) => this.readyWaiters.push(res));
    log.info('Room window ready');
    return this.readied(win);
  }

  /**
   * Hand back a ready engine window, re-asserting the kill-switch gate first: a
   * window spawned (or re-spawned after a crash) DURING a VPN outage must start
   * suspended, or a 'join' that raced the manager flag would bring up networking
   * on the real IP. Fire-and-forget — the engine sets its flag synchronously and
   * this send precedes the caller's command (IPC preserves order), so the gate is
   * up before any join is processed.
   */
  private readied(win: BrowserWindow): BrowserWindow {
    if (this.networkSuspended) win.webContents.send('room-cmd', { type: 'netSuspend', reqId: ++this.reqSeq });
    // Re-assert the user's voice settings: the engine store is session-only, so a
    // respawned window would otherwise capture with defaults (wrong mic/gain).
    if (this.voiceSettingsCache) {
      win.webContents.send('room-cmd', { type: 'voiceSettings', reqId: ++this.reqSeq, settings: this.voiceSettingsCache });
    }
    // Same reasoning for the LAN relay-willingness bit: the engine's copy is
    // session-only, so a respawn would silently revert an explicit "don't relay
    // for others" to the default ON. (lanStart also carries it, which covers the
    // case where the store was never read on this run.)
    if (this.lanRelayCache !== null) {
      win.webContents.send('room-cmd', { type: 'lanSettings', reqId: ++this.reqSeq, relayEnabled: this.lanRelayCache });
    }
    return win;
  }

  private async call<T = any>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 0): Promise<T> {
    const win = await this.ensureWindow();
    const reqId = ++this.reqSeq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      if (timeoutMs > 0) setTimeout(() => { if (this.pending.delete(reqId)) reject(new Error('Room engine did not respond')); }, timeoutMs);
      win.webContents.send('room-cmd', { type, reqId, ...payload });
    });
  }

  private async roomsBase(): Promise<string> {
    let base: string;
    try { base = (await db.getSettings()).defaultDownloadDir; }
    catch { base = path.join(app.getPath('downloads'), 'Havvn'); }
    return path.join(base, 'Rooms');
  }

  /** Where a room's ciphertext copies live in E2E mode (outside the room folder). */
  private encCacheDir(roomId: string): string {
    return path.join(app.getPath('userData'), 'room-enc', roomId);
  }

  private async joinPayload(roomId: string, name: string, code: string, folder: string, ownerId?: string, e2e?: boolean, secret?: string, e2eCfg?: db.PersistedRoom['e2eCfg'], ownerPin?: string) {
    const profile = db.getRoomProfile();
    const identity = db.getRoomIdentity();
    const persisted = db.getPersistedRooms().find((r) => r.roomId === roomId);
    let useTurn = true;
    let turnServers: ReturnType<typeof customTurnToIce> = [];
    let trackers = resolveTrackers();
    try {
      const s = await db.getSettings();
      useTurn = s.shareUseTurn !== false;
      turnServers = customTurnToIce(s.customTurnUrl, s.customTurnUsername, s.customTurnCredential);
      trackers = resolveTrackers(s.customTrackers);
    } catch { /* default on, no custom TURN, public trackers */ }
    const lanSession = db.getRoomLanPrefs(roomId).session;
    return {
      type: 'join',
      payload: {
        roomId, name, code, folder,
        self: { memberId: profile.memberId, name: profile.name, avatarSeed: profile.avatarSeed, color: profile.color ?? '', status: profile.status ?? '', avatarImg: profile.avatarImg ?? '', pub: identity.pub, priv: identity.priv },
        useTurn,
        turnServers,
        trackers,
        tombstones: db.getRoomTombstones(roomId),
        tombSigs: db.getRoomTombstoneProofs(roomId),
        revives: db.getRoomRevives(roomId),
        manifest: db.getRoomManifest(roomId),
        folders: db.getRoomFolders(roomId),
        folderTombs: db.getRoomFolderTombstones(roomId),
        ownerId: ownerId ?? '',
        ownerPin: ownerPin ?? '',
        transferChain: persisted?.transferChain ?? [],
        nameAt: persisted?.nameAt ?? 0,
        topicText: persisted?.topic ?? '',
        topicAt: persisted?.topicAt ?? 0,
        topicMsg: persisted?.topicSig
          ? { text: persisted.topic ?? '', at: persisted.topicAt ?? 0, by: persisted.topicBy ?? '', pub: persisted.topicPub ?? '', sig: persisted.topicSig }
          : null,
        mutes: db.getRoomMutes(roomId),
        // The LAN session this room re-enters + its watermark. Carried at JOIN
        // because a joiner's PASSIVE session is built from the host's gossip
        // before any lanStart — that core needs the floor from the very first
        // admit it sees. lanStart re-asserts both from disk when a session is
        // actually brought up.
        lanSession: lanSession?.id ?? '',
        lanFloor: lanSession?.floor ?? 0,
        history: db.getRoomHistory(roomId),
        chat: db.getRoomChats(roomId),
        reacts: db.getRoomReacts(roomId),
        chatReacts: db.getRoomChatReacts(roomId),
        chatEdits: db.getRoomChatEdits(roomId),
        identities: db.getRoomIdentities(roomId),
        e2e: e2e ?? false,
        secret: secret ?? '',
        prevSecrets: persisted?.prevSecrets ?? [],
        bans: persisted?.bans ?? [],
        e2eCfg: e2eCfg ?? null,
        cacheDir: this.encCacheDir(roomId),
        // Per-room preferences (absent → auto-download on, no speed limits).
        autoFetch: persisted?.autoFetch !== false,
        folderFetch: db.getRoomFolderFetch(roomId),
        upKbps: persisted?.upKbps ?? 0,
        downKbps: persisted?.downKbps ?? 0,
      },
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  getProfile(): RoomProfile { return db.getRoomProfile(); }

  setProfile(updates: Partial<Pick<RoomProfile, 'name' | 'avatarSeed' | 'color' | 'status' | 'avatarImg'>>): RoomProfile {
    const profile = db.updateRoomProfile(updates);
    // Push the change into the live engine so active rooms re-broadcast the new
    // identity to peers immediately (no rejoin needed). Skip if not running yet.
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', {
        type: 'profile', reqId: ++this.reqSeq,
        payload: { name: profile.name, avatarSeed: profile.avatarSeed, color: profile.color ?? '', status: profile.status ?? '', avatarImg: profile.avatarImg ?? '' },
      });
    }
    return profile;
  }

  /** Refuse any fresh join while the VPN kill-switch has rooms suspended —
   *  createRoom/joinRoom drive the engine's 'join' directly, bypassing the
   *  reactivate() gate, so they must check here too or they'd start leaking. */
  private assertNotSuspended(): void {
    if (this.networkSuspended) throw new Error('Rooms are paused: the VPN is down. Reconnect it first.');
  }

  async createRoom(name: string, e2e = false): Promise<RoomState> {
    this.assertNotSuspended();
    const roomId = uuidv4();
    const code = generateRoomCode(e2e); // E2E rooms carry the marker in the code itself
    const folder = path.join(await this.roomsBase(), slugify(name) + '-' + roomId.slice(0, 6));
    fs.mkdirSync(folder, { recursive: true });
    const createdAt = Date.now();
    const ownerId = db.getRoomProfile().memberId; // the creator owns the room
    // E2E rooms get a content secret (separate from the rotating gossip key) so a
    // later kick/rekey doesn't strand access to already-shared files.
    const secret = e2e ? generateRoomSecret() : undefined;
    // We ARE the owner, so pin ourselves — our shared invite carries this id and
    // joiners will only accept us as owner (no self-declared-owner hijack).
    db.savePersistedRoom({ roomId, name, code, folder, createdAt, ownerId, ownerPin: ownerId, e2e, secret });
    const { type, payload } = await this.joinPayload(roomId, name, code, folder, ownerId, e2e, secret, undefined, ownerId);
    const state = await this.call<RoomState>(type, { payload });
    state.createdAt = createdAt;
    this.cache.set(roomId, state);
    return state;
  }

  async joinRoom(rawCode: string): Promise<RoomState> {
    this.assertNotSuspended();
    // The invite may pin the owner ("<code>~<ownerId>"); the pin is not part of the
    // KDF, so bare-code and pinned joiners derive the same key.
    const { code, ownerPin } = parseInvite(rawCode);
    if (!code) throw new Error('Empty room code');
    // Already joined this code? Return the existing room.
    const existing = db.getPersistedRooms().find((r) => normalizeCode(r.code) === code);
    if (existing) return this.getRoom(existing.roomId).then((s) => s || this.reactivate(existing));
    const roomId = uuidv4();
    const name = code; // placeholder until a peer's HELLO/PING carries the real name
    const folder = path.join(await this.roomsBase(), slugify(code) + '-' + roomId.slice(0, 6));
    fs.mkdirSync(folder, { recursive: true });
    const createdAt = Date.now();
    // A "-e2e" code tells us the room is end-to-end encrypted before any peer
    // does — so the engine refuses to seed plaintext even into an empty swarm.
    const e2e = codeIsE2E(code);
    db.savePersistedRoom({ roomId, name, code, folder, createdAt, e2e, ownerPin: ownerPin || undefined });
    const { type, payload } = await this.joinPayload(roomId, name, code, folder, undefined, e2e, undefined, undefined, ownerPin);
    const state = await this.call<RoomState>(type, { payload });
    state.createdAt = createdAt;
    this.cache.set(roomId, state);
    return state;
  }

  private async reactivate(r: db.PersistedRoom): Promise<RoomState> {
    // The VPN is down (kill-switch). Never rejoin the network — hand back the
    // last-known state if we have it, otherwise fail closed.
    if (this.networkSuspended) {
      const cached = this.cache.get(r.roomId);
      if (cached) return cached;
      throw new Error('Rooms are paused: the VPN is down (kill-switch)');
    }
    const { type, payload } = await this.joinPayload(r.roomId, r.name, r.code, r.folder, r.ownerId, r.e2e, r.secret, r.e2eCfg, r.ownerPin);
    const state = await this.call<RoomState>(type, { payload });
    state.createdAt = r.createdAt;
    this.cache.set(r.roomId, state);
    return state;
  }

  /**
   * Leave a room. By default the downloaded files stay on disk; pass
   * `deleteFiles` to also remove the room's download folder (files a member
   * shared from their ORIGINAL location outside the folder are untouched).
   */
  async leaveRoom(roomId: string, deleteFiles = false): Promise<{ ok: boolean }> {
    // Resolve the folder BEFORE the db entry is deleted below.
    const folder = deleteFiles ? this.folderOf(roomId) : null;
    try { await this.call('leave', { roomId }, 8000); } catch { /* engine may be down */ }
    db.deletePersistedRoom(roomId);
    db.clearRoomTombstones(roomId);
    db.clearRoomTombstoneProofs(roomId);
    db.clearRoomRevives(roomId);
    db.clearRoomManifest(roomId);
    db.clearRoomFolders(roomId);
    db.clearRoomHistory(roomId);
    db.clearRoomMutes(roomId);
    db.clearRoomLanPrefs(roomId);
    db.clearRoomFolderFetch(roomId);
    db.clearRoomChats(roomId);
    db.clearRoomLastRead(roomId);
    db.clearRoomReacts(roomId);
    db.clearRoomChatReacts(roomId);
    db.clearRoomChatEdits(roomId);
    db.clearRoomIdentities(roomId);
    try { fs.rmSync(this.encCacheDir(roomId), { recursive: true, force: true }); } catch { /* ignore */ }
    // The engine's 'leave' above destroys the room's WebTorrent client, so the
    // file handles should be released by now; best-effort delete (a Windows AV
    // lock can still hold one, in which case the folder simply stays).
    if (folder) {
      try { fs.rmSync(folder, { recursive: true, force: true }); }
      catch (e) { log.warn('leaveRoom: could not delete room folder', { roomId, err: String(e) }); }
    }
    this.cache.delete(roomId);
    this.reevalGlobalPtt(); // the left room may have been the PTT hook's target
    return { ok: true };
  }

  async list(): Promise<RoomSummary[]> {
    const self = db.getRoomProfile().memberId;
    return db.getPersistedRooms().map((r) => {
      const s = this.cache.get(r.roomId);
      const lastRead = db.getRoomLastRead(r.roomId);
      const unread = db.getRoomChats(r.roomId).filter((m) => m.at > lastRead && m.memberId !== self).length;
      return {
        roomId: r.roomId,
        name: r.name,
        code: r.code,
        folder: r.folder,
        memberCount: s ? s.members.length : 1,
        onlineCount: s ? s.members.filter((m) => m.online).length : 1,
        fileCount: s ? s.files.length : 0,
        createdAt: r.createdAt,
        e2e: r.e2e ?? false,
        suspended: this.networkSuspended,
        lan: s?.lan?.active === true, // rail-collapsed LAN badge (built per-field)
        unread,
        notifyMuted: r.notifyMuted === true,
      };
    });
  }

  /**
   * This install's virtual-LAN address in a room, or undefined when no session
   * is up. Synchronous and cache-only on purpose: the game-server manager reads
   * it on every state build, and reactivating a room as a side effect of drawing
   * a panel would be a surprising thing for a getter to do.
   */
  cachedLanVip(roomId: string): string | undefined {
    const lan = this.cache.get(roomId)?.lan;
    return lan?.active && lan.selfVip ? lan.selfVip : undefined;
  }

  /** Room folders for binding server content slots. */
  listRoomFolders(roomId: string): { id: string; name: string }[] {
    const folders = this.cache.get(roomId)?.folders ?? [];
    return folders.map((f) => ({ id: f.id, name: f.name }));
  }

  /**
   * Room files with best-effort local paths for content sync. Files still
   * downloading have no `localPath`.
   */
  listRoomContentFiles(roomId: string): Array<{
    fileId: string;
    name: string;
    folderId: string;
    infoHash: string;
    size: number;
    localPath?: string;
  }> {
    const state = this.cache.get(roomId);
    const folder = this.folderOf(roomId);
    if (!state || !folder) return [];
    return state.files.map((f) => {
      const tr = state.transfers?.[f.fileId];
      let localPath: string | undefined;
      if (tr?.localPath && fs.existsSync(tr.localPath)) localPath = tr.localPath;
      else {
        const flat = path.join(folder, f.name);
        if (fs.existsSync(flat)) localPath = flat;
      }
      return {
        fileId: f.fileId,
        name: f.name,
        folderId: f.folderId ?? '',
        infoHash: f.infoHash,
        size: f.size,
        ...(localPath ? { localPath } : {}),
      };
    });
  }

  async getRoom(roomId: string): Promise<RoomState | null> {
    const cached = this.cache.get(roomId);
    if (cached) return cached;
    const persisted = db.getPersistedRooms().find((r) => r.roomId === roomId);
    if (!persisted) return null;
    return this.reactivate(persisted).catch(() => null);
  }

  async addFiles(roomId: string, paths: string[], opts?: { folderId?: string; folderName?: string }): Promise<RoomState> {
    const persisted = db.getPersistedRooms().find((r) => r.roomId === roomId);
    if (!persisted) throw new Error('Room not found');
    if (!this.cache.has(roomId)) await this.reactivate(persisted);
    const state = await this.call<RoomState>('addFiles', { roomId, paths, opts });
    state.createdAt = persisted.createdAt;
    this.cache.set(roomId, state);
    return state;
  }

  folderOf(roomId: string): string | null {
    return db.getPersistedRooms().find((r) => r.roomId === roomId)?.folder ?? null;
  }

  /**
   * Open a room file from disk. First tells the engine to stop seeding it so
   * Windows releases the file handle (otherwise archives can't be opened while
   * the file is being shared), then opens it with the OS default app.
   */
  async openFile(roomId: string, fileId: string): Promise<void> {
    const state = this.cache.get(roomId);
    const file = state?.files.find((f) => f.fileId === fileId);
    const folder = this.folderOf(roomId);
    try { await this.call('releaseFile', { roomId, fileId }, 8000); } catch { /* engine may be down */ }
    // Prefer the engine-known on-disk path (a folder subdir for foldered files,
    // or a shared file's original location); fall back to the flat room join.
    const tr = state?.transfers?.[fileId];
    const abs = (tr?.localPath && fs.existsSync(tr.localPath)) ? tr.localPath
      : (folder && file) ? path.join(folder, file.name) : null;
    if (abs) {
      try { await shell.openPath(abs); } catch { /* ignore */ }
    }
  }

  /**
   * Reveal a room file in the OS file manager (Explorer/Finder), selecting it.
   * Unlike openFile this does NOT release the seed — the handle stays held, we
   * only highlight the file in its folder.
   */
  async revealFile(roomId: string, fileId: string): Promise<void> {
    const state = this.cache.get(roomId);
    const file = state?.files.find((f) => f.fileId === fileId);
    const folder = this.folderOf(roomId);
    const tr = state?.transfers?.[fileId];
    const abs = (tr?.localPath && fs.existsSync(tr.localPath)) ? tr.localPath
      : (folder && file) ? path.join(folder, file.name) : null;
    if (abs && fs.existsSync(abs)) shell.showItemInFolder(abs);
    else if (folder) await shell.openPath(folder); // not on disk yet — open the room folder
  }

  /**
   * Resolve a room file for the in-app player. A COMPLETE file goes through the
   * cast server's disk path (full features: direct/HLS transcode, cover art,
   * subtitles). A still-DOWNLOADING file (non-E2E, directly-playable only) is
   * streamed live from the engine's WebTorrent stream server — watch-while-
   * downloading. `streaming` tells the renderer to load it no-cors (the stream
   * server emits no ACAO) and that HLS/cover/subtitles aren't available yet.
   */
  async watchFile(roomId: string, fileId: string): Promise<{ directUrl: string; hlsUrl: string; playerUrl: string; coverUrl?: string; direct: boolean; kind: string; name: string; streaming?: boolean }> {
    const state = this.cache.get(roomId);
    const file = state?.files.find((f) => f.fileId === fileId);
    const tr = state?.transfers?.[fileId];
    if (file && !tr?.haveLocally) {
      // Not on disk yet → watch while it downloads. Constrained to what actually
      // works without the full file: plaintext (non-E2E) and a browser-native
      // container (no live transcode). Anything else stays gated until complete.
      if (state?.e2e) throw new Error('Encrypted room files can only be watched once fully downloaded.');
      if (!isDirectlyPlayable(file.name)) throw new Error('This format can only be watched once it has finished downloading.');
      const { port, index } = await this.call<{ port: number; index: number }>('watchStream', { roomId, fileId }, 30000);
      return { directUrl: `http://127.0.0.1:${port}/${index}`, hlsUrl: '', playerUrl: '', direct: true, kind: classifyMediaKind(file.name), name: file.name, streaming: true };
    }
    const abs = this.resolveLocalPath(roomId, fileId);
    // The cast server runs in the torrent host; publish the room file there.
    const { getTorrentManager } = await import('../torrent');
    return getTorrentManager().castPublishDiskFile(abs);
  }

  /** Publish a DOWNLOADED room image on the cast server and return a loopback URL
   *  for an in-app <img> (row thumbnail + lightbox). Throws until the file is
   *  fully on disk (resolveLocalPath). */
  async imageUrl(roomId: string, fileId: string): Promise<{ url: string }> {
    const abs = this.resolveLocalPath(roomId, fileId);
    const { getTorrentManager } = await import('../torrent');
    return getTorrentManager().castPublishImage(abs);
  }

  /**
   * Resolve a room file's absolute on-disk path. Prefers the engine-known
   * path: a *shared* file is seeded from its original location (not the room
   * folder), while a *downloaded* one lives in the room folder.
   */
  private resolveLocalPath(roomId: string, fileId: string): string {
    const state = this.cache.get(roomId);
    const file = state?.files.find((f) => f.fileId === fileId);
    const folder = this.folderOf(roomId);
    if (!file || !folder) throw new Error('File not available in this room');
    const tr = state?.transfers?.[fileId];
    const abs = (tr?.localPath && fs.existsSync(tr.localPath)) ? tr.localPath : path.join(folder, file.name);
    if (!fs.existsSync(abs)) throw new Error('This file is not fully downloaded yet');
    return abs;
  }

  /** Subtitle tracks for a downloaded room file (embedded text + sidecars). */
  async subtitleList(roomId: string, fileId: string): Promise<SubtitleTrackItem[]> {
    const abs = this.resolveLocalPath(roomId, fileId);
    const { getTorrentManager } = await import('../torrent');
    return listSubtitleTracks(getTorrentManager().ffmpegBinary, abs);
  }

  /** A chosen subtitle track as WebVTT text (renderer wraps it in a blob URL). */
  async subtitleGet(roomId: string, fileId: string, key: string): Promise<string> {
    const abs = this.resolveLocalPath(roomId, fileId);
    const { getTorrentManager } = await import('../torrent');
    return getSubtitleVtt(getTorrentManager().ffmpegBinary, abs, key);
  }

  /** Stop seeding one room file (keeps the local copy; reversible). */
  async releaseFile(roomId: string, fileId: string): Promise<{ ok: boolean }> {
    await this.call('releaseFile', { roomId, fileId }, 8000);
    return { ok: true };
  }

  /** Resume seeding a released room file. */
  async reseedFile(roomId: string, fileId: string): Promise<{ ok: boolean }> {
    await this.call('reseedFile', { roomId, fileId }, 8000);
    return { ok: true };
  }

  // ── Folders / sections ──────────────────────────────────────────────────────
  /** Route a folder command through a live engine (reactivating the room if idle). */
  private async folderCmd(roomId: string, type: string, extra: Record<string, unknown>): Promise<RoomState> {
    const persisted = db.getPersistedRooms().find((r) => r.roomId === roomId);
    if (!persisted) throw new Error('Room not found');
    if (!this.cache.has(roomId)) await this.reactivate(persisted);
    const state = await this.call<RoomState>(type, { roomId, ...extra });
    state.createdAt = persisted.createdAt;
    this.cache.set(roomId, state);
    return state;
  }

  /** Owner-only room rename — the engine gates + signs it, then gossips + persists. */
  renameRoom(roomId: string, name: string): Promise<RoomState> {
    return this.folderCmd(roomId, 'rename', { name });
  }

  /** Owner-only: set (or clear with '') the room topic — signed + gossiped. */
  async setTopic(roomId: string, text: string): Promise<RoomState> {
    return this.folderCmd(roomId, 'setTopic', { text });
  }

  createFolder(roomId: string, name: string, icon: string, color: string, parentId?: string): Promise<RoomState> {
    return this.folderCmd(roomId, 'createFolder', { name, icon, color, parentId });
  }
  updateFolder(roomId: string, folderId: string, patch: { name?: string; icon?: string; color?: string; parentId?: string | null }): Promise<RoomState> {
    return this.folderCmd(roomId, 'updateFolder', { folderId, patch });
  }
  deleteFolder(roomId: string, folderId: string): Promise<RoomState> {
    return this.folderCmd(roomId, 'deleteFolder', { folderId });
  }
  assignFile(roomId: string, fileId: string, folderId: string | null): Promise<RoomState> {
    return this.folderCmd(roomId, 'assignFile', { fileId, folderId });
  }
  /** Batched multi-file move (mirrors removeFiles): one cmd, one state refresh. */
  assignFiles(roomId: string, fileIds: string[], folderId: string | null): Promise<RoomState> {
    const ids = (fileIds || []).filter((x) => typeof x === 'string' && x);
    return this.folderCmd(roomId, 'assignFiles', { fileIds: ids, folderId });
  }
  /** Per-folder auto-fetch override (local pref): true/false forces, null inherits
   *  the room-wide toggle again. Persisted, and re-applied on every (re)join. */
  setFolderAutoFetch(roomId: string, folderId: string, mode: boolean | null): Promise<RoomState> {
    db.setRoomFolderFetch(roomId, folderId, mode);
    return this.folderCmd(roomId, 'setFolderAutoFetch', { folderId, mode });
  }

  // ── Voice ─────────────────────────────────────────────────────────────────
  /** Join a room's serverless mesh voice channel (captures the mic). Rejects if
   *  the VPN kill-switch is up or mic permission is denied — the caller toasts it. */
  async voiceJoin(roomId: string): Promise<{ ok: boolean }> {
    this.assertNotSuspended(); // a voice call leaks the real IP just like seeding
    await this.ensureMicAccess();
    const persisted = db.getPersistedRooms().find((r) => r.roomId === roomId);
    if (persisted && !this.cache.has(roomId)) await this.reactivate(persisted);
    return this.call<{ ok: boolean }>('voiceJoin', { roomId }, 15000);
  }
  voiceLeave(roomId: string): Promise<{ ok: boolean }> { return this.call<{ ok: boolean }>('voiceLeave', { roomId }); }
  voiceMute(roomId: string, muted: boolean): Promise<{ ok: boolean }> { return this.call<{ ok: boolean }>('voiceMute', { roomId, muted }); }
  voiceDeafen(roomId: string, deafened: boolean): Promise<{ ok: boolean }> { return this.call<{ ok: boolean }>('voiceDeafen', { roomId, deafened }); }
  voiceVolume(roomId: string, memberId: string, volume: number): Promise<{ ok: boolean }> { return this.call<{ ok: boolean }>('voiceVolume', { roomId, memberId, volume }); }
  voiceInputMode(roomId: string, mode: string): Promise<{ ok: boolean }> { return this.call<{ ok: boolean }>('voiceInputMode', { roomId, mode }); }
  voicePtt(roomId: string, active: boolean): Promise<{ ok: boolean }> { return this.call<{ ok: boolean }>('voicePtt', { roomId, active }); }
  /** Global push-to-talk config from the renderer (OS-level key hook while in
   *  voice + PTT mode). `code` is a DOM KeyboardEvent.code; `supported` tells the
   *  UI whether that key is expressible by the hook. */
  voiceGlobalPtt(enabled: boolean, code: string): { ok: boolean; available: boolean; supported: boolean } {
    const available = isGlobalPttAvailable();
    const keycode = resolveUiohookKeycode(String(code || ''));
    this.globalPtt = { enabled: !!enabled && available, keycode };
    this.reevalGlobalPtt();
    return { ok: true, available, supported: keycode !== null };
  }

  /** Retune the OS key hook to the current decision (some room in voice + PTT +
   *  toggle on). Idempotent and cheap — called on every room-state push. */
  private reevalGlobalPtt(): void {
    const rooms = Array.from(this.cache.values()).map((s) => ({
      roomId: s.roomId,
      inVoice: !!s.voice?.inVoice,
      inputMode: String(s.voice?.inputMode || 'always'),
    }));
    const d = decideGlobalPtt(this.globalPtt, rooms);
    if (!d.run) {
      if (this.globalPttTarget) { this.globalPttTarget = null; stopGlobalPtt(); }
      return;
    }
    if (this.globalPttTarget && this.globalPttTarget.roomId === d.roomId && this.globalPttTarget.keycode === d.keycode) return;
    const roomId = d.roomId;
    const ok = startGlobalPtt(
      d.keycode,
      () => { void this.voicePtt(roomId, true).catch(() => { /* engine gone — reeval will stop us */ }); },
      () => { void this.voicePtt(roomId, false).catch(() => { /* ignore */ }); },
    );
    this.globalPttTarget = ok ? { roomId, keycode: d.keycode } : null;
  }
  /** Global voice settings (devices/gain/VAD/processing). Cached so a respawned
   *  engine window starts from the user's config, not defaults (see readied()). */
  voiceSettings(settings: VoiceSettings): Promise<{ ok: boolean }> {
    this.voiceSettingsCache = settings;
    return this.call<{ ok: boolean }>('voiceSettings', { settings });
  }
  /** Audio devices as the ENGINE window sees them (its deviceId space is the one
   *  the capture pipeline uses — main-renderer ids would not match). */
  voiceDevices(): Promise<VoiceDeviceInfo[]> { return this.call<VoiceDeviceInfo[]>('voiceDevices', {}, 15000); }
  async voiceMicTestStart(settings: VoiceSettings, monitor = false): Promise<{ ok: boolean }> {
    await this.ensureMicAccess(); // macOS TCC prompt, same as joining voice
    return this.call<{ ok: boolean }>('voiceMicTestStart', { settings, monitor }, 15000);
  }
  voiceMicTestStop(): Promise<{ ok: boolean }> { return this.call<{ ok: boolean }>('voiceMicTestStop', {}); }

  // ── Screenshare ───────────────────────────────────────────────────────────
  /** Shareable screens/windows with picker thumbnails (data URLs). */
  async screenSources(): Promise<Array<{ id: string; name: string; thumbnail: string; display: boolean }>> {
    const { desktopCapturer } = await import('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), display: s.id.startsWith('screen:') }));
  }

  async screenShareStart(roomId: string, sourceId: string, withAudio = false): Promise<{ ok: boolean }> {
    this.assertNotSuspended(); // a share leg leaks the real IP just like voice
    await this.ensureScreenAccess();
    return this.call<{ ok: boolean }>('screenShareStart', { roomId, sourceId, withAudio }, 15000);
  }
  screenShareStop(roomId: string): Promise<{ ok: boolean }> { return this.call<{ ok: boolean }>('screenShareStop', { roomId }); }
  screenWatchStart(roomId: string, memberId: string): Promise<{ ok: boolean }> { return this.call<{ ok: boolean }>('screenWatchStart', { roomId, memberId }, 8000); }
  screenWatchStop(roomId: string, memberId: string): Promise<{ ok: boolean }> { return this.call<{ ok: boolean }>('screenWatchStop', { roomId, memberId }); }
  /** The renderer's loopback answer/ICE back to the engine forwarder. */
  screenSignal(roomId: string, memberId: string, kind: string, data: unknown): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('screenSignal', { roomId, memberId, kind, data });
  }

  // ── Virtual-LAN (Havvn LAN) ─────────────────────────────────────────────────
  /** Host: start a virtual-LAN session and admit the picked members (1 UAC).
   *  Gates the VPN kill-switch, reactivates a dormant room, acquires the single
   *  global elevated helper via LanManager, then hands the pipe scope to the engine
   *  window which pins genesis + admits the picks. If the engine push fails after
   *  the helper spawned, the helper is torn down so nothing leaks. */
  async lanStart(roomId: string, memberIds: string[]): Promise<{ ok: boolean; sessionId?: string; warning?: string }> {
    this.assertNotSuspended(); // a LAN adapter exposes the real interface just like seeding
    const persisted = db.getPersistedRooms().find((r) => r.roomId === roomId);
    if (persisted && !this.cache.has(roomId)) await this.reactivate(persisted);
    const selfMemberId = db.getRoomProfile().memberId;
    const prefs = db.getRoomLanPrefs(roomId);
    // RE-ENTER the room's own session when we have one, so the subnet and every
    // member's vIP are the same as last night (both derive from the id). Only a
    // session WE created qualifies — the id commits to its creator, and pinGenesis
    // binds `by` to that prefix. Otherwise mint a self-describing id
    // (`${host}.${16hexRandom}`, must-fix #7) so the pinned host stays derivable.
    //
    // Reuse is safe only WITH the watermark below: a fresh core has empty floors,
    // so without it every host-signed admit ever issued under this id could be
    // replayed back in (LanSessionCore.applyAdmit / floorSeed).
    const sessionId = reusableSessionId(prefs, selfMemberId)
      ?? `${selfMemberId}.${crypto.randomBytes(8).toString('hex')}`;
    const floor = sessionFloor(prefs, sessionId);
    const admit = Array.isArray(memberIds) ? memberIds.map(String) : [];
    const relayEnabled = await this.lanRelayPref();
    const handle = await getLanManager().start({ roomId, sessionId, hostId: selfMemberId, selfMemberId });
    try {
      await this.call('lanStart', {
        roomId, sessionId: handle.sessionId, pipeName: handle.pipeName, token: handle.token,
        subnet: handle.subnet, admit, isHost: true,
        relayEnabled, floor,
      }, 30000);
    } catch (e) {
      try { await getLanManager().stop(handle.sessionId); } catch { /* ignore */ }
      throw e;
    }
    // Remember only what actually took: the admit list rode a start that succeeded.
    this.updateLanPrefs(roomId, (p) => withPicks(withSession(p, sessionId), admit, selfMemberId));
    this.reapplyLanApps(roomId);
    return { ok: true, sessionId: handle.sessionId };
  }

  /** Stop the LAN session: cooperative engine teardown (reverts the adapter via the
   *  pipe shutdown verb) then release the main-side helper handle. */
  async lanStop(roomId: string): Promise<{ ok: boolean }> {
    try { await this.call('lanStop', { roomId }, 8000); } catch { /* engine may be down */ }
    const sid = getLanManager().activeSessionId();
    if (sid) { try { await getLanManager().stop(sid); } catch { /* ignore */ } }
    return { ok: true };
  }

  /** Host admits one more member into an already-live session. Remembered too, so
   *  the next Start offers the group that actually played rather than the group
   *  that was picked before the last two people showed up. The engine's reply is an
   *  acknowledgement, not proof an admit was signed (LanSession.control no-ops for
   *  a non-host) — remembering it anyway is harmless, since a pick only ever
   *  pre-ticks THIS install's own picker. */
  async lanInvite(roomId: string, memberId: string): Promise<{ ok: boolean }> {
    const res = await this.call<{ ok: boolean }>('lanSignal', { roomId, kind: 'invite', memberId });
    const selfMemberId = db.getRoomProfile().memberId;
    this.updateLanPrefs(roomId, (p) => addPick(p, memberId, selfMemberId));
    return res;
  }

  /** Host removes a member (host-signed lan-evict). Forgetting the pick is part of
   *  the eviction: a pre-ticked tile at the next Start would quietly undo it, and
   *  that admit WOULD go through (the sticky `evicted` set is session-only). */
  async lanEvict(roomId: string, memberId: string): Promise<{ ok: boolean }> {
    const res = await this.call<{ ok: boolean }>('lanSignal', { roomId, kind: 'evict', memberId });
    // Rotate the session as well as forgetting the pick. `evicted` is a sticky
    // in-memory set, so re-entering the SAME id after a restart would downgrade
    // "terminal for this session" to "terminal until the app closes". A new id
    // makes every grant ever issued under the old one inert at the sessionId gate
    // — stronger than the watermark, at the price of new addresses after a
    // removal, which is the right trade for a removal.
    this.updateLanPrefs(roomId, (p) => rotateSession(removePick(p, memberId)));
    return res;
  }

  /** This room's remembered LAN setup — the renderer reads it to pre-tick the peer
   *  picker. Never an authority: see the header of shared/lan-prefs.ts. */
  lanPrefs(roomId: string): LanRoomPrefs {
    return db.getRoomLanPrefs(roomId);
  }

  /** Read-modify-write the room's remembered LAN setup through the pure helpers.
   *  Skips the disk write when nothing changed (electron-store rewrites the whole
   *  file on every set), and never lets a store failure break a LAN action. */
  private updateLanPrefs(roomId: string, fn: (prefs: LanRoomPrefs) => LanRoomPrefs): void {
    try {
      const before = db.getRoomLanPrefs(roomId);
      const after = fn(before);
      if (!sameLanPrefs(before, after)) db.setRoomLanPrefs(roomId, after);
    } catch (e) {
      log.warn('could not persist LAN prefs', { roomId, err: String(e) });
    }
  }

  /**
   * Re-create the scoped firewall allow-rules this room has collected, once a
   * session is up. Fire-and-forget on purpose: the rules matter when a game
   * actually connects (seconds later), and the panel must not sit spinning behind
   * a PowerShell round-trip per remembered game.
   *
   * Teardown deletes every rule the session made — that "leaves nothing behind"
   * guarantee is worth keeping — so remembering the PATHS and re-making the rules
   * is the honest way to spare the user the same trip through the .exe picker
   * every session.
   *
   * A path the helper rejects as bad ('bad-app-path': uninstalled, moved, refused
   * by the validator) is FORGOTTEN, because it will fail identically forever and
   * would otherwise cost a round-trip at every start. Every other failure is
   * treated as transient and the entry is kept.
   */
  private reapplyLanApps(roomId: string): void {
    const apps = db.getRoomLanPrefs(roomId).apps;
    if (apps.length === 0) return;
    void (async () => {
      for (const exe of apps) {
        try {
          const r = await this.call<{ ok: boolean; code?: string; error?: string }>(
            'lanAllowApp', { roomId, exePath: exe }, 35000,
          );
          if (r?.ok) continue;
          if (r?.code === 'bad-app-path') {
            log.info('forgetting a LAN game rule whose executable is gone', { roomId, exe });
            this.updateLanPrefs(roomId, (p) => removeApp(p, exe));
          } else {
            log.warn('could not re-apply a LAN game rule', { roomId, exe, err: r?.error });
          }
        } catch (e) {
          // The engine or the session went away — stop, keep every entry.
          log.warn('LAN rule re-apply stopped', { roomId, err: String(e) });
          return;
        }
      }
    })();
  }

  /** Persisted relay willingness (AppSettings.lanRelayEnabled, absent ⇒ true).
   *  Read through the cache so the start payload never blocks on the store twice,
   *  and so a store read failure degrades to the default rather than throwing into
   *  the LAN start path. */
  private async lanRelayPref(): Promise<boolean> {
    if (this.lanRelayCache !== null) return this.lanRelayCache;
    try {
      const s = await db.getSettings();
      this.lanRelayCache = s.lanRelayEnabled !== false;
    } catch { this.lanRelayCache = true; }
    return this.lanRelayCache;
  }

  /**
   * Phase 2B — flip whether THIS install forwards other players' LAN frames.
   * GLOBAL (it spends one uplink, not one room's), so it is persisted in
   * AppSettings and pushed to the engine, which applies it to every live session
   * and re-reads it on the forward path. Switching it off publishes relay:false
   * (removing us from every peer's candidate set) and stops forwarding on the very
   * next packet — see the AppSettings comment for the bandwidth AND privacy cost.
   */
  async lanSetRelay(enabled: boolean): Promise<{ ok: boolean }> {
    const on = enabled !== false;
    this.lanRelayCache = on;
    try { await db.updateSettings({ lanRelayEnabled: on }); } catch { /* keep the session-only value */ }
    // Fire-and-forget into a LIVE engine only — deliberately NOT this.call(),
    // which would SPAWN the engine window just to record a preference. A window
    // that is down (or spawns later) picks the value up from readied()/lanStart.
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'lanSettings', reqId: ++this.reqSeq, relayEnabled: on });
    }
    return { ok: true };
  }

  /**
   * Phase 2A item C — the connectivity report. Facts come from three places and
   * are judged in exactly one: main owns the driver probe + helper liveness, the
   * engine owns the session/peer view and relays the elevated helper's own
   * adapter/vIP/firewall facts, and the pure evaluator turns the merged input into
   * checks + a verdict + one most-likely cause. An engine that cannot answer
   * degrades rows to 'unknown' instead of failing the whole run.
   */
  async lanDiagnose(roomId: string): Promise<LanDiagReport> {
    const mgr = getLanManager();
    const avail = mgr.available();
    let engine: Partial<LanDiagInput> = {};
    try {
      engine = await this.call<Partial<LanDiagInput>>('lanDiagnose', { roomId }, 12000);
    } catch { /* engine down / no room — everything downstream reads 'unknown' */ }
    const active = engine.active === true;
    const input: LanDiagInput = {
      platformWin32: process.platform === 'win32',
      available: avail.ok,
      ...(avail.reason ? { availableReason: avail.reason } : {}),
      active,
      ...(engine.blocked !== undefined ? { blocked: engine.blocked } : {}),
      ...(this.networkSuspended ? { suspended: true } : {}),
      // The helper is unkillable from main; LanManager's watchdog drops the active
      // session as soon as its PID dies, so "engine says active, main has no
      // session" is exactly the helper-died signal.
      ...(active ? { helperAlive: mgr.activeSessionId() !== null } : {}),
      ...(engine.adapterName !== undefined ? { adapterName: engine.adapterName } : {}),
      ...(engine.adapterPresent !== undefined ? { adapterPresent: engine.adapterPresent } : {}),
      ...(engine.adapterUp !== undefined ? { adapterUp: engine.adapterUp } : {}),
      ...(engine.selfVip !== undefined ? { selfVip: engine.selfVip } : {}),
      ...(engine.expectedVip !== undefined ? { expectedVip: engine.expectedVip } : {}),
      ...(engine.subnet !== undefined ? { subnet: engine.subnet } : {}),
      ...(engine.mtu !== undefined ? { mtu: engine.mtu } : {}),
      ...(engine.firewallRuleCount !== undefined ? { firewallRuleCount: engine.firewallRuleCount } : {}),
      ...(engine.turnConfigured !== undefined ? { turnConfigured: engine.turnConfigured } : {}),
      peers: Array.isArray(engine.peers) ? engine.peers : [],
    };
    return evaluateLanDiagnostics(input);
  }

  /**
   * Phase 2A item D — scoped inbound allow-rule for one game executable. The path
   * is picked by a MAIN-process dialog (handlers.ts) and re-validated by the
   * already-elevated helper, so this adds NO new UAC prompt. A rejection resolves
   * as ok:false — it must never surface as a helper error (that tears the tunnel
   * down).
   */
  async lanAllowApp(roomId: string, exePath: string): Promise<{ ok: boolean; canceled?: boolean; exe?: string; rule?: string; error?: string }> {
    const p = String(exePath || '');
    if (!p) return { ok: false, canceled: true };
    // Budget = the engine's readiness wait (10 s) + its helper request (20 s), with
    // headroom: giving up on a rule that then lands would show an error for an
    // exception the user actually has.
    const res = await this.call<{ ok: boolean; exe?: string; rule?: string; code?: string; error?: string }>(
      'lanAllowApp', { roomId, exePath: p }, 35000,
    );
    // Remember the game so the next session re-creates the rule by itself. Only on
    // success: a path the helper refused must not come back every start.
    const exe = res?.exe;
    if (res?.ok && exe) this.updateLanPrefs(roomId, (pr) => addApp(pr, exe));
    return res;
  }

  /** Joiner: acquire our own elevated helper leg for the session the host
   *  advertised (its scope comes from the cached RoomState.lan), wire the engine,
   *  then accept. Tears the helper down if the engine push fails. */
  async lanAccept(roomId: string): Promise<{ ok: boolean; warning?: string }> {
    this.assertNotSuspended();
    const persisted = db.getPersistedRooms().find((r) => r.roomId === roomId);
    if (persisted && !this.cache.has(roomId)) await this.reactivate(persisted);
    const lan = this.cache.get(roomId)?.lan;
    if (!lan?.sessionId || !lan.hostId) throw new Error('No LAN session to join yet.');
    if (!lan.selfAdmitted) throw new Error('The host has not invited you to this LAN session yet.');
    const selfMemberId = db.getRoomProfile().memberId;
    const relayEnabled = await this.lanRelayPref();
    // A joiner keeps its own watermark for the host's session: the grants it must
    // refuse a second time are the same ones, and its core is just as fresh.
    const floor = sessionFloor(db.getRoomLanPrefs(roomId), lan.sessionId);
    const handle = await getLanManager().start({ roomId, sessionId: lan.sessionId, hostId: lan.hostId, selfMemberId });
    try {
      await this.call('lanStart', {
        roomId, sessionId: handle.sessionId, pipeName: handle.pipeName, token: handle.token,
        subnet: handle.subnet, admit: [], isHost: false,
        relayEnabled, floor,
      }, 30000);
      await this.call('lanSignal', { roomId, kind: 'accept' }, 8000);
    } catch (e) {
      try { await getLanManager().stop(handle.sessionId); } catch { /* ignore */ }
      throw e;
    }
    // Record the session we joined, so our next visit seeds the same watermark
    // (and so a host that rotates leaves us starting cleanly on the new id).
    this.updateLanPrefs(roomId, (p) => withSession(p, lan.sessionId as string));
    // A joiner collects game rules of its own (its games need the same inbound
    // exception), so the re-apply is not host-only.
    this.reapplyLanApps(roomId);
    return { ok: true };
  }

  /** macOS gates screen recording at TCC and it cannot be prompted from code —
   *  surface a clear pointer at System Settings instead of a silent black frame.
   *  No-op elsewhere (Windows needs nothing). */
  private async ensureScreenAccess(): Promise<void> {
    if (process.platform !== 'darwin') return;
    try {
      const { systemPreferences } = await import('electron');
      if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
        throw new Error('Screen Recording permission is off — enable it for Havvn in System Settings › Privacy & Security.');
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('Screen Recording')) throw e;
      /* getMediaAccessStatus unavailable — let capture surface its own error */
    }
  }

  /** macOS gates the microphone at the OS (TCC) level; prompt once from the main
   *  process before capture. No-op on Windows/Linux (handled by the OS/permission
   *  handler). */
  private async ensureMicAccess(): Promise<void> {
    if (process.platform !== 'darwin') return;
    try {
      const { systemPreferences } = await import('electron');
      if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
        await systemPreferences.askForMediaAccess('microphone');
      }
    } catch { /* best-effort — getUserMedia will surface a denial */ }
  }

  /** Remove a shared file from the room for everyone (persists a tombstone). */
  async removeFile(roomId: string, fileId: string): Promise<{ ok: boolean }> {
    const at = Date.now(); // one timestamp for the persisted tombstone AND the gossip 'del'
    db.addRoomTombstone(roomId, fileId, at);
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'removeFile', reqId: ++this.reqSeq, roomId, fileId, at });
    }
    return { ok: true };
  }

  /** Remove several files at once (one gossip pass; per-file authorization in the
   *  engine is unchanged — a file you can't delete for everyone is a local hide). */
  async removeFiles(roomId: string, fileIds: string[]): Promise<{ ok: boolean }> {
    const ids = (fileIds || []).filter((x) => typeof x === 'string' && x);
    if (!ids.length) return { ok: true };
    const at = Date.now();
    for (const fileId of ids) db.addRoomTombstone(roomId, fileId, at);
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'removeFiles', reqId: ++this.reqSeq, roomId, fileIds: ids, at });
    }
    return { ok: true };
  }

  /** Ask peers to share something — rides the signed chat pipeline (no new gossip
   *  type). The renderer decorates the text so it renders as a request. */
  async requestFile(roomId: string, text: string): Promise<{ ok: boolean }> {
    return this.sendChat(roomId, text);
  }

  /** Mark a room read up to now (clears its unread badge). The renderer refreshes
   *  its list once this resolves; live chat refreshes via the room-update push. */
  async markRead(roomId: string): Promise<{ ok: boolean }> {
    db.setRoomLastRead(roomId, Date.now());
    return { ok: true };
  }

  /** The renderer tells us which room is on screen, so we don't OS-notify it. */
  async setActiveRoom(roomId: string | null): Promise<{ ok: boolean }> {
    this.activeRoomId = roomId || null;
    if (roomId) db.setRoomLastRead(roomId, Date.now()); // opening a room reads it
    return { ok: true };
  }

  private mainWindowFocused(): boolean {
    return !!this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.isFocused();
  }

  /** OS-notify activity in a room that isn't the one on screen (best-effort).
   *  `urgent` (an @-mention of the user) bypasses the per-room cooldown, but
   *  NOT the per-room mute — an explicitly silenced room stays silent. */
  private async notifyRoomActivity(roomId: string, who: string, body: string, urgent = false): Promise<void> {
    try {
      // Looking right at it (and the app is focused)? No notification.
      if (roomId === this.activeRoomId && this.mainWindowFocused()) return;
      const rec = db.getPersistedRooms().find((r) => r.roomId === roomId);
      if (rec?.notifyMuted) return;
      // Rate-limit: one toast per room per cooldown, so a burst/backfill can't
      // spam. Mentions shorten the window but keep a floor — the text is
      // peer-controlled, and a mention-per-message flood must still be bounded.
      const cooldown = urgent ? 2000 : 8000;
      const now = Date.now();
      if (now - (this.lastNotify.get(roomId) ?? 0) < cooldown) return;
      const settings = await db.getSettings();
      if (settings.enableNotifications === false) return;
      this.lastNotify.set(roomId, now);
      const roomName = rec?.name || t('notify.room.fallbackName');
      const preview = body.length > 140 ? body.slice(0, 140) + '…' : body;
      showOsNotification(`${who} · ${roomName}`, preview, { onClick: () => this.focusAndOpenRoom(roomId) });
    } catch { /* best-effort */ }
  }

  /** Bring the app forward and ask the renderer to open a room (notification click). */
  private focusAndOpenRoom(roomId: string): void {
    try {
      const w = this.mainWindow;
      if (!w || w.isDestroyed()) return;
      if (w.isMinimized()) w.restore();
      w.show(); w.focus();
      w.webContents.send('rooms:open', { roomId });
    } catch { /* ignore */ }
  }

  /** Owner-only: remove a member by rotating the room code (engine enforces it). */
  async kick(roomId: string, memberId: string): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('kick', { roomId, memberId }, 8000);
  }

  /** Owner-only: hand the room to another member (engine signs + gossips it). */
  async transferOwner(roomId: string, memberId: string): Promise<RoomState> {
    return this.call<RoomState>('transferOwner', { roomId, memberId }, 8000);
  }

  /** Locally hide/ignore a member on this install (reversible, never broadcast). */
  async setMuted(roomId: string, memberId: string, muted: boolean): Promise<{ ok: boolean }> {
    db.setRoomMute(roomId, memberId, muted);
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'mute', reqId: ++this.reqSeq, roomId, memberId, muted });
    }
    return { ok: true };
  }

  /** Auto-download files peers share into this room (persisted per room).
   *  Turning it back on also pulls everything left unfetched. */
  async setAutoFetch(roomId: string, autoFetch: boolean): Promise<{ ok: boolean }> {
    db.setRoomAutoFetch(roomId, autoFetch);
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'setAutoFetch', reqId: ++this.reqSeq, roomId, autoFetch });
    }
    return { ok: true };
  }

  /** Per-room OS-notification mute (db-only — the engine isn't involved). */
  async setNotifyMuted(roomId: string, muted: boolean): Promise<{ ok: boolean }> {
    db.setRoomNotifyMuted(roomId, muted);
    return { ok: true };
  }

  /** Manual mode: explicitly download one shared file. Returns the fresh state. */
  async fetchFile(roomId: string, fileId: string): Promise<RoomState> {
    return this.call<RoomState>('fetchFile', { roomId, fileId }, 8000);
  }

  /** Per-room speed ceilings in KB/s, 0 = unlimited (persisted + applied live). */
  async setLimits(roomId: string, upKbps: number, downKbps: number): Promise<{ ok: boolean }> {
    const up = Math.max(0, Math.floor(Number(upKbps) || 0));
    const down = Math.max(0, Math.floor(Number(downKbps) || 0));
    db.setRoomLimits(roomId, up, down);
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'setLimits', reqId: ++this.reqSeq, roomId, upKbps: up, downKbps: down });
    }
    return { ok: true };
  }

  /** Watch-together: broadcast a local playback action to the room's peers. */
  broadcastSync(roomId: string, payload: { fileId: string; action: string; position: number; rate?: number; playing?: boolean; emoji?: string }): void {
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'sync', reqId: ++this.reqSeq, roomId, payload });
    }
  }

  /** Host: gossip game-server mirror state to peers. */
  broadcastServerMirror(roomId: string, payload: import('../../shared/gameserver-types').ServerMirrorState): void {
    if (!roomId || !payload) return;
    const body = serializeMirrorBody(payload);
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'srvMirror', reqId: ++this.reqSeq, roomId, at: payload.at, body });
    }
  }

  /** Operator: relay a console command to the host over gossip. */
  publishRemoteCommand(roomId: string, instanceId: string, command: string): void {
    if (!roomId || !instanceId || !command) return;
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'srvCmd', reqId: ++this.reqSeq, roomId, instanceId, command });
    }
  }

  /** Every peer mirror in this room — one per member currently hosting. */
  getServerMirrors(roomId: string): import('../../shared/gameserver-types').ServerMirrorState[] {
    return this.cache.get(roomId)?.srvMirrors ?? [];
  }

  /** Send a chat message to a room (broadcast to peers + recorded locally). */
  async sendChat(roomId: string, text: string, replyTo?: string): Promise<{ ok: boolean }> {
    const body = String(text || '').trim();
    if (!body) return { ok: false };
    const persisted = db.getPersistedRooms().find((r) => r.roomId === roomId);
    if (!persisted) throw new Error('Room not found');
    if (!this.cache.has(roomId)) await this.reactivate(persisted);
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'chat', reqId: ++this.reqSeq, roomId, payload: { text: body, ...(replyTo ? { replyTo: String(replyTo) } : {}) } });
    }
    return { ok: true };
  }

  /** Edit one of OUR own chat messages (engine re-signs + gossips the edit).
   *  Rejects editing others' messages (the engine enforces it, and every peer
   *  re-checks authorship on receive). */
  async editChat(roomId: string, msgId: string, text: string): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('editChat', { roomId, payload: { msgId, text } }, 8000);
  }

  /** Fire-and-forget: tell a room's peers we're composing a chat message.
   *  The engine rate-limits the broadcast, so keystroke-driven calls are fine. */
  typing(roomId: string): void {
    if (!roomId) return;
    if (this.win && !this.win.isDestroyed() && this.ready) {
      this.win.webContents.send('room-cmd', { type: 'typing', reqId: ++this.reqSeq, roomId });
    }
  }

  /** Toggle our emoji reaction on a shared file (whitelisted emoji only;
   *  the engine flips on/off from its current state and gossips the change). */
  async reactFile(roomId: string, fileId: string, emoji: string): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('reactFile', { roomId, fileId, emoji }, 8000);
  }

  /** Toggle our emoji reaction on a chat message (engine gossips the flip). */
  async reactChat(roomId: string, msgId: string, emoji: string): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('reactChat', { roomId, msgId, emoji }, 8000);
  }

  /**
   * VPN kill-switch tripped (VPN dropped): stop every room from seeding,
   * announcing or holding a peer wire, so no room leaks the real IP while
   * unprotected. The flag is set FIRST so any lazy reactivation (open a room,
   * add a file) fails closed instead of quietly rejoining. If the engine window
   * isn't even running there is nothing seeding — just set the flag (and don't
   * spawn the engine merely to suspend it).
   */
  async suspendNetworking(): Promise<void> {
    if (this.networkSuspended) return;
    this.networkSuspended = true;
    log.warn('VPN dropped — suspending all room networking');
    // Tear the LAN session down too (the adapter holds a real interface). resume
    // does NOT auto-restart it — LAN membership is explicit (plan §7).
    getLanManager().onVpnSuspend();
    // Only if the engine window already exists — never spawn it merely to
    // suspend (nothing is seeding if it was never started). ensureWindow (inside
    // call) waits for readiness, so a drop during engine startup still tears down
    // every room that finishes joining.
    if (this.win && !this.win.isDestroyed()) {
      try { await this.call('netSuspend', {}, 8000); } catch (e) { log.warn('netSuspend failed', { err: String(e) }); }
    }
    this.cache.clear();
    this.reevalGlobalPtt(); // no rooms left in voice → the OS key hook must stop
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.webContents.send('rooms:netSuspended', { suspended: true });
  }

  /** VPN restored: lift the freeze and re-join every room from the persisted
   *  state (the same path as startup). */
  async resumeNetworking(): Promise<void> {
    if (!this.networkSuspended) return;
    this.networkSuspended = false;
    log.info('VPN restored — resuming room networking');
    // Lift the ENGINE's gate first (if the window survived the outage) so the
    // re-joins below are allowed through; a fresh window starts un-suspended.
    if (this.win && !this.win.isDestroyed()) {
      try { await this.call('netResume', {}, 8000); } catch (e) { log.warn('netResume failed', { err: String(e) }); }
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.webContents.send('rooms:netSuspended', { suspended: false });
    await this.restoreAll();
  }

  /** Re-join all persisted rooms on startup so swarms reconnect automatically. */
  async restoreAll(): Promise<void> {
    const persisted = db.getPersistedRooms();
    if (!persisted.length) return;
    log.info('Restoring rooms', { count: persisted.length });
    for (const r of persisted) {
      try { await this.reactivate(r); } catch (e) { log.warn('Room restore failed', { roomId: r.roomId, error: String(e) }); }
    }
  }

  destroy(): void {
    this.failAll('Shutting down');
    void getLanManager().shutdown().catch(() => { /* best-effort teardown */ }); // revert any LAN adapter/firewall/route
    if (this.win && !this.win.isDestroyed()) { try { this.win.destroy(); } catch { /* ignore */ } }
    this.win = null; this.ready = false;
    log.info('RoomManager destroyed');
  }
}

let roomManager: RoomManager | null = null;
export function getRoomManager(): RoomManager {
  if (!roomManager) roomManager = new RoomManager();
  return roomManager;
}
