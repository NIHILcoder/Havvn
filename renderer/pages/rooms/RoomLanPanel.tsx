/**
 * RoomLanPanel — the Virtual-LAN rail widget (Phase 1 UI).
 *
 * Anatomy mirrors RoomVoicePanel (RoomsPage.tsx): a compact header (title +
 * BETA pill + settings gear), a Start/Stop action row, and a wrapped grid of
 * per-peer tiles. Each tile carries a connection-status dot (the .room-lan-quality
 * lineage of .room-voice-quality), the peer's monospace virtual IP, and a copy-IP
 * button. Host-only affordances (invite more players, evict a peer) surface only
 * when `lan.isHost`.
 *
 * Extracted as a standalone component (RoomsPage.tsx is already 3800+ lines and
 * every phase that touches it collides). The Integration phase mounts it in the
 * room rail between the voice panel and the people list, and wires the callback
 * props to window.api.rooms.lan.*.
 *
 * Phase 2A adds the "make failures visible and fixable" half: the status dot
 * carries the MEASURED link quality (getStats RTT / loss / relayed-vs-direct) in
 * its tooltip, a peer whose ICE reached the terminal 'failed' state gets an
 * explicit explanation pointing at TURN instead of a silently dead tile, and two
 * self-service actions sit under the control row — a Diagnostics report (portaled
 * modal, copy-paste-able) and a firewall troubleshooter for "I see the peer but
 * the game won't connect".
 *
 * Phase 2B adds the one-hop PEER RELAY surface, which is three separate honesty
 * problems, not one:
 *   1. A peer reached through another player is NOT a direct peer — it costs a
 *      third party's uplink, doubles the latency and the relaying player can read
 *      the traffic. Its tile therefore never shows the green "good" dot (the dot
 *      is hollow + capped at fair/poor), carries a relay glyph and a `via <name>`
 *      caption, and its tooltip says out loud that the numbers were measured to
 *      the RELAY, not end-to-end.
 *   2. The Phase 2A terminal-failure block must stop lying once a relay exists:
 *      peers with a working relayed path move OUT of the red "no direct path →
 *      configure TURN" block into an informational one; only genuinely stranded
 *      peers keep pointing at TURN.
 *   3. Relaying for someone spends THIS install's bandwidth, so it is visible
 *      (a live "Relaying for N" line with the count) and switchable off.
 *
 * Styling uses ONLY theme tokens (no hardcoded radius; --radius-full is reserved
 * for the status dots). The peer picker portals its fixed overlay to the owning
 * document's <body>.
 *
 * REALM: this panel is a dock panel, so it can be torn off into a child window.
 * Anything that reaches for a document or a window therefore resolves the panel's
 * OWN realm instead of the module-scope globals — see copyIp(). The React tree
 * still runs in the main renderer's JS realm no matter where its DOM lives, so
 * `window.api` (every IPC call in this file) stays deliberately absolute: a child
 * window has no preload bridge of its own.
 *
 * TOASTS follow the same rule and for the same reason. `toast` from
 * react-hot-toast is a module singleton that dispatches into the DEFAULT store,
 * which only the main window's <Toaster> subscribes to — so "IP copied", a failed
 * Stop and the firewall result were all drawn in the main window while the user
 * was looking at the torn-off panel on another monitor. `useHostToast()` binds the
 * whole API to this subtree's realm and deliberately SHADOWS the import, so no
 * call site below changed. With no realm above it (the docked case, and every
 * test) it returns the module singleton ITSELF, so the docked panel is unchanged
 * by construction rather than by inspection.
 *
 * The two overlays this panel opens (LanPeerPicker, LanDiagnosticsModal) portal to
 * the OWNING document's <body>, never inside this subtree: a fixed backdrop
 * rendered under an ancestor with `container-type` is trapped by it. This panel
 * sets no `container-type` of its own (see RoomLanPanel.css's header), but the
 * dock zone and `.popout-root` above it both do.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, Icon, Toggle } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostWindow, resolveHostWindow } from '../../utils/hostWindow';
import { useHostToast } from '../../utils/hostToast';
import type { RoomMember } from '../../../shared/types';
import type { RoomLanState, RoomLanParticipant, LanPeerStatus } from '../../../shared/lan-types';
import { LanPeerPicker } from './LanPeerPicker';
import { LanDiagnosticsModal } from './LanDiagnosticsModal';
import type { LanDiagReportView } from './LanDiagnosticsModal';
import './RoomLanPanel.css';

/**
 * How the selected ICE candidate pair got there (from getStats' candidate types).
 * `local` = both host candidates (same physical network), `nat` = at least one
 * server-reflexive hop, `relay` = the path runs through TURN (RTT is inflated and
 * the user deserves to know).
 *
 * A Phase 2B PEER-relayed leg is deliberately NOT a value here: it has no ICE pair
 * at all (no LanPeer, no getStats), so it is carried by `relayVia` instead of being
 * smuggled in as a fifth path kind that nothing could ever measure.
 */
export type LanPathKind = 'local' | 'nat' | 'relay' | 'unknown';

/** Why ICE never produced a working pair — the honest terminal-failure taxonomy. */
export type LanIceFailReason = 'no-udp' | 'symmetric-nat' | 'needs-turn' | 'peer-unreachable' | 'unknown';

/**
 * Phase 2A per-peer measurements, declared structurally so the panel type-checks
 * before the transport phase lands them on RoomLanParticipant. Once shared/
 * carries these fields the intersection below stays valid — integration deletes
 * nothing and only re-points the import if it wants a single source.
 *
 * UNITS (integration must match these or the tooltip lies):
 *   rttMs   — milliseconds, already ×1000 from candidate-pair.currentRoundTripTime
 *   lossPct — PERCENT 0..100 (not a 0..1 fraction), windowed, not lifetime
 *   dropPct — PERCENT 0..100, OUR local backpressure drops (send-HWM + token bucket)
 */
export interface LanPeerLinkView {
  rttMs?: number;
  lossPct?: number;
  dropPct?: number;
  path?: LanPathKind;
  /** Latched by the transport: this peer has stopped being retried. */
  terminal?: boolean;
  failReason?: LanIceFailReason;
  // ── Phase 2B: one-hop peer relay ────────────────────────────────────────────
  /**
   * memberId of the player forwarding our frames to this peer. PRESENT ⇒ there is
   * NO direct leg and the traffic rides a third party's uplink. Absent is the
   * normal case and must render exactly as Phase 2A did.
   */
  relayVia?: string;
  /**
   * Round-trip through the relay, ms — the only end-to-end number a relayed pair
   * has (getStats cannot see past the relay). Absent until probed; the tile then
   * falls back to `rttMs`, which is OUR leg to the RELAY and is labelled as such.
   */
  relayRttMs?: number;
}

/**
 * Session-level relay facts (Phase 2B), declared structurally for the same reason
 * as LanPeerLinkView: the panel type-checks before the transport lands them on
 * RoomLanState, and stays valid afterwards (the intersection below keeps both
 * declarations compatible — identical optional shapes).
 */
export interface LanRelayStateView {
  /** THIS install is willing to forward for others. ABSENT ⇒ true (opt-out). */
  relayEnabled?: boolean;
  /**
   * memberIds we actually forwarded for in the recent window (~10s, damped by the
   * transport so the readout does not strobe while two ends converge on a relay).
   * ABSENT / empty ⇒ we are not spending anything on anyone right now.
   */
  relayFor?: string[];
}

/** A participant as this panel renders it. */
export type LanParticipantView = RoomLanParticipant & LanPeerLinkView;

/** The session as this panel renders it. */
export type LanStateView = RoomLanState & LanRelayStateView;

/** Result of the firewall troubleshooter (main picks the .exe, the helper adds the rule). */
export interface LanAllowAppResult {
  ok: boolean;
  /** The user dismissed the native picker — not an error, say nothing. */
  canceled?: boolean;
  /** Absolute path of the executable the rule was created for. */
  exe?: string;
  /** DisplayName of the created rule (removed on teardown by the orphan sweep). */
  rule?: string;
  /** Human-readable failure (validator rejection, PowerShell error). */
  error?: string;
}

export interface RoomLanPanelProps {
  /** The room's LAN session as this install sees it (RoomState.lan). */
  lan: LanStateView;
  /** Full room roster — the picker selects admit targets from here. */
  members: RoomMember[];
  /** This install's memberId (to split self from peers). */
  selfId?: string;
  /** Host path: start a session and admit the picked members (one UAC). */
  onStart: (memberIds: string[]) => void | Promise<void>;
  /** Stop / leave the session. */
  onStop: () => void | Promise<void>;
  /** Non-host: join a session we've been admitted to. */
  onAccept?: () => void | Promise<void>;
  /** Host: admit one more member into a live session. */
  onInvite?: (memberIds: string[]) => void | Promise<void>;
  /** Host: evict a member from the session. */
  onEvict?: (memberId: string) => void | Promise<void>;
  /** Open a LAN settings surface (optional; no-op until a settings modal exists). */
  onOpenSettings?: () => void;
  /**
   * Run the connectivity check pass and return an already-EVALUATED report
   * (integration wires window.api.rooms.lan.diagnostics → the pure evaluator).
   * Absent → the Diagnostics action is not rendered.
   */
  onDiagnostics?: () => Promise<LanDiagReportView>;
  /**
   * Firewall troubleshooter: opens a native .exe picker in MAIN and asks the
   * already-elevated helper for a scoped inbound allow-rule. The renderer never
   * fabricates the path. Absent → the action is not rendered.
   */
  onAllowApp?: () => Promise<LanAllowAppResult>;
  /**
   * Jump to Settings → Connection (TURN relay) from the terminal-failure notice.
   * Absent → the notice still explains the fix in words, just without a shortcut.
   */
  onOpenTurnSettings?: () => void;
  /**
   * Phase 2B opt-out: stop / resume forwarding OTHER players' LAN traffic through
   * this install. Renderer-side only — integration points this at the settings
   * write + the room-cmd that tells the engine. Absent → the toggle is not
   * rendered (the live "Relaying for N" readout still is, if it is happening).
   */
  onSetRelayEnabled?: (enabled: boolean) => void | Promise<void>;
}

/**
 * Map the LanPeer connection state to the shared quality-dot class vocabulary.
 * Partial on purpose: the transport may widen LanPeerStatus (Phase 2B floated a
 * 'relayed' member) and a missing key must fall back, never break the build.
 */
const STATUS_CLASS: Partial<Record<LanPeerStatus, string>> = {
  connected: 'q-good',
  connecting: 'q-fair',
  reconnecting: 'q-poor reconnecting',
  failed: 'q-poor',
};

/** Terminal-failure reason → the i18n key that explains it in one sentence. */
const FAIL_REASON_KEY = {
  'no-udp': 'rooms.lan.failNoUdp',
  'symmetric-nat': 'rooms.lan.failSymmetric',
  'needs-turn': 'rooms.lan.failNeedsTurn',
  'peer-unreachable': 'rooms.lan.failUnreachable',
  unknown: 'rooms.lan.failUnknown',
} as const;

/** Selected-pair provenance → the tooltip word for it. */
const PATH_KEY = {
  local: 'rooms.lan.pathLocal',
  nat: 'rooms.lan.pathDirect',
  relay: 'rooms.lan.pathRelayed',
  unknown: 'rooms.lan.pathUnknown',
} as const;

/** Percent with one decimal below 10 (0.4% reads better than 0%), integer above. */
const pct = (v: number) => (v < 10 ? Math.round(v * 10) / 10 : Math.round(v)).toString();

/** Last path segment of a Windows or POSIX path — for the firewall success toast. */
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

export const RoomLanPanel: React.FC<RoomLanPanelProps> = ({
  lan, members, selfId, onStart, onStop, onAccept, onInvite, onEvict, onOpenSettings,
  onDiagnostics, onAllowApp, onOpenTurnSettings, onSetRelayEnabled,
}) => {
  const { t } = useTranslation();
  const host = useHostWindow();
  // Shadows the module singleton on purpose (see the TOAST note in the header):
  // every `toast.*` call below now lands in the window this panel is displayed in.
  const toast = useHostToast();
  // The panel root, used only to resolve which window this DOM actually lives in.
  // An element's ownerDocument outranks the context: it stays right even when the
  // panel is portalled into a realm its React-tree provider knows nothing about.
  const rootRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [pickerMode, setPickerMode] = useState<null | 'start' | 'invite'>(null);
  const [diagOpen, setDiagOpen] = useState(false);
  /**
   * memberId → latched failure reason.
   *
   * The transport reaps and immediately REBUILDS a failed peer, so an untreated
   * `status === 'failed'` is overwritten by a fresh 'connecting' within a tick and
   * the honest terminal message would strobe. We latch the first failure and clear
   * it only on a real 'connected' (or when the session ends / changes identity).
   */
  const [failLatch, setFailLatch] = useState<Record<string, LanIceFailReason>>({});
  const sessionRef = useRef<string | undefined>(lan.sessionId);

  const memberOf = (id: string) => members.find((m) => m.memberId === id);
  const nameOf = (id: string) => (id === selfId ? t('rooms.you') : (memberOf(id)?.name || '?'));
  const seedOf = (id: string) => memberOf(id)?.avatarSeed || id;
  const fail = (e: unknown) => toast.error(String(e instanceof Error ? e.message : e));
  const wrap = (fn: () => void | Promise<unknown>) => async () => {
    setBusy(true);
    try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const copyIp = (vip: string) => {
    if (!vip) return;
    // Clipboard of the window the panel is really in. A detached panel writing
    // through the MAIN window's navigator rejects with "Document is not focused"
    // (that document is unfocused precisely because the child has focus), so the
    // copy silently failed and the toast never appeared.
    const win = resolveHostWindow(rootRef.current, host).window;
    win.navigator.clipboard?.writeText(vip)
      .then(() => toast.success(t('rooms.lan.copied')))
      .catch(() => { /* clipboard blocked — silent, the IP is still shown */ });
  };

  // Peers are every admitted participant except ourselves; self reads off selfVip.
  // Self is hardcoded 'connected' upstream and has no RTCPeerConnection, so it
  // never carries measurements — the filter keeps quality off the self tile.
  const peers = lan.participants.filter((p) => p.memberId !== selfId) as LanParticipantView[];
  const admittedIds = lan.participants.map((p) => p.memberId);

  // ── Terminal-failure latch ────────────────────────────────────────────────
  // Set on the first 'failed'/terminal sighting, cleared on a real 'connected',
  // dropped wholesale when the session stops or a different session takes over.
  useEffect(() => {
    if (!lan.active || lan.sessionId !== sessionRef.current) {
      sessionRef.current = lan.sessionId;
      setFailLatch((prev) => (Object.keys(prev).length ? {} : prev));
      if (!lan.active) return;
    }
    setFailLatch((prev) => {
      const next = { ...prev };
      let changed = false;
      const present = new Set<string>();
      for (const p of lan.participants as LanParticipantView[]) {
        if (p.memberId === selfId) continue;
        present.add(p.memberId);
        // Latch ONLY on the transport's terminal verdict. A bare status==='failed'
        // is a transient ICE hiccup that room-lan.ts still has rebuild budget for
        // (LAN_MAX_PEER_REBUILDS); latching it here would declare a recoverable leg
        // permanently dead and defeat the retry the transport was built around.
        const failed = p.terminal === true;
        if (failed && !(p.memberId in next)) { next[p.memberId] = p.failReason || 'unknown'; changed = true; }
        else if (p.status === 'connected' && p.memberId in next) { delete next[p.memberId]; changed = true; }
      }
      // Evicted / departed members must not keep a stale failure line alive.
      for (const id of Object.keys(next)) if (!present.has(id)) { delete next[id]; changed = true; }
      return changed ? next : prev;
    });
  }, [lan.active, lan.sessionId, lan.participants, selfId]);

  // ── Phase 2B: relayed peers vs genuinely stranded ones ────────────────────
  // A relayed peer is STILL terminal (the direct leg really is dead, and the
  // transport keeps that latch), so it is in `failLatch` too — but it is PLAYABLE.
  // Splitting here is what stops the Phase 2A red block from claiming a working
  // session is broken.
  /** Peers reached through another player right now (narrowed: relayVia is set). */
  const relayedPeers = peers.filter(
    (p): p is LanParticipantView & { relayVia: string } => !!p.relayVia,
  );
  /** Peers whose direct path is (latched) dead AND that no relay is carrying. */
  const failedPeers = peers.filter((p) => p.memberId in failLatch && !p.relayVia);
  const failReason: LanIceFailReason = failedPeers.length
    ? (failLatch[failedPeers[0].memberId] || 'unknown')
    : 'unknown';

  // ── Phase 2B: are WE forwarding for anyone? ───────────────────────────────
  // Absent setting ⇒ ON (opt-out, per the plan): a build that predates the flag
  // must not read as "relaying is off" when it is in fact relaying.
  const relayEnabled = lan.relayEnabled !== false;
  const relayForIds = lan.relayFor || [];
  const relayCount = relayForIds.length;
  /** Who we forward for, for the readout's tooltip — never shown as a bare list. */
  const relayForNames = relayForIds.map((id) => nameOf(id)).join(', ');

  // ── Per-peer dot + tooltip ────────────────────────────────────────────────
  /**
   * Measured quality wins on a connected link; the raw status is the fallback.
   *
   * A RELAYED leg is capped: never green. Two hops through a stranger's uplink is
   * materially worse than a direct link even when every measured number looks
   * fine, and the numbers we do have only describe our leg to the relay — so the
   * dot goes amber (or red if even that leg is poor) and gets the hollow
   * `.relayed` treatment so it reads as "indirect" without hovering.
   */
  const dotClass = (p: LanParticipantView) => {
    if (p.relayVia) return `q-${p.quality === 'poor' ? 'poor' : 'fair'} relayed`;
    if (p.memberId in failLatch) return 'q-poor';
    if (p.status === 'connected' && p.quality) return `q-${p.quality}`;
    return STATUS_CLASS[p.status] || 'q-fair';
  };

  /** "Connected · RTT 42 ms · loss 0.4% · relayed" — the honest numbers behind the dot. */
  const dotTitle = (p: LanParticipantView) => {
    const via = p.relayVia;
    const head = via ? t('rooms.lan.statusRelayed')
      : p.memberId in failLatch ? t('rooms.lan.statusFailed')
        : p.status === 'connected' ? t('rooms.lan.statusConnected')
          : p.status === 'connecting' ? t('rooms.lan.statusConnecting')
            : p.status === 'reconnecting' ? t('rooms.lan.statusReconnecting')
              : t('rooms.lan.statusFailed');
    const parts = [head];
    if (via) parts.push(t('rooms.lan.viaPeer').replace('{n}', nameOf(via)));
    // A relayed pair has TWO different round trips and conflating them would be
    // exactly the flattering dishonesty Phase 2A was built to avoid: prefer the
    // end-to-end probe when the transport measured one, otherwise fall back to our
    // leg to the relay — which the closing note then names as such.
    const relayRtt = via && typeof p.relayRttMs === 'number' && p.relayRttMs > 0 ? p.relayRttMs : undefined;
    if (relayRtt !== undefined) {
      parts.push(t('rooms.lan.relayRtt').replace('{n}', String(Math.round(relayRtt))));
    } else if (typeof p.rttMs === 'number' && p.rttMs > 0) {
      parts.push(t('rooms.lan.qRtt').replace('{n}', String(Math.round(p.rttMs))));
    }
    if (typeof p.lossPct === 'number') parts.push(t('rooms.lan.qLoss').replace('{n}', pct(p.lossPct)));
    // Our own backpressure drops — display-only, never a threshold input, and only
    // worth a line when they are actually happening.
    if (typeof p.dropPct === 'number' && p.dropPct >= 0.1) {
      parts.push(t('rooms.lan.qDrop').replace('{n}', pct(p.dropPct)));
    }
    // On a relayed leg getStats can only see as far as the relay — say so instead
    // of letting a good-looking number pass for an end-to-end measurement.
    if (via) parts.push(t('rooms.lan.relayQualityNote').replace('{n}', nameOf(via)));
    else if (p.path) parts.push(t(PATH_KEY[p.path] || PATH_KEY.unknown));
    return parts.join(' · ');
  };

  // ── Firewall troubleshooter ("I see the peer but the game won't connect") ──
  const allowApp = wrap(async () => {
    if (!onAllowApp) return;
    const r = await onAllowApp();
    if (!r || r.canceled) return; // the user dismissed the picker — say nothing
    if (r.ok) toast.success(t('rooms.lan.fwAdded').replace('{n}', r.exe ? baseName(r.exe) : ''));
    else toast.error(r.error || t('rooms.lan.fwFailed'));
  });

  // Phase 2B opt-out. Fire-and-forget through `wrap` so a rejected IPC surfaces as
  // a toast instead of an unhandled rejection; the switch renders off the state we
  // are given, never a local optimistic copy.
  const toggleRelay = (on: boolean) => {
    if (!onSetRelayEnabled) return;
    void wrap(() => onSetRelayEnabled(on))();
  };

  // Stable identity so the modal's mount pass doesn't re-fire on every render.
  const runDiagnostics = useCallback(
    () => (onDiagnostics ? onDiagnostics() : Promise.reject(new Error('unavailable'))),
    [onDiagnostics],
  );

  // Start is offerable only when the driver is present, no other room holds the
  // single beta session, and the kill-switch isn't down.
  const startBlockedReason = !lan.available
    ? t('rooms.lan.unavailable')
    : lan.suspended
      ? t('rooms.lan.suspended')
      : lan.blocked
        ? t('rooms.lan.busyElsewhere')
        : null;
  const canStart = !startBlockedReason && !busy;

  return (
    <div className="room-lan" ref={rootRef}>
      <div className="room-lan-head">
        <span className="room-lan-title">
          <Icon name="network" size={13} /> {t('rooms.lan.title')}
          <span className="stg-pill stg-pill-accent room-lan-beta">{t('rooms.lan.beta')}</span>
        </span>
        {onOpenSettings && (
          <button className="room-lan-gear" onClick={onOpenSettings} title={t('rooms.lan.settings')} type="button">
            <Icon name="settings" size={14} />
          </button>
        )}
      </div>

      {lan.active ? (
        <>
          <div className="room-lan-self">
            <span className="room-lan-self-label">{t('rooms.lan.yourIp')}</span>
            <button
              className="room-lan-ip"
              onClick={() => copyIp(lan.selfVip || '')}
              title={t('rooms.lan.copyIp')}
              type="button"
              disabled={!lan.selfVip}
            >
              <span className="room-lan-ip-text">{lan.selfVip || t('rooms.lan.connecting')}</span>
              <Icon name="copy" size={12} />
            </button>
          </div>
          <div className="room-lan-ctl">
            {lan.isHost && onInvite && (
              <button
                className="room-lan-btn"
                onClick={() => setPickerMode('invite')}
                disabled={busy}
                title={t('rooms.lan.pickPeers')}
                type="button"
              >
                <Icon name="plus" size={15} />
              </button>
            )}
            <button
              className="room-lan-btn stop"
              onClick={wrap(onStop)}
              disabled={busy}
              title={t('rooms.lan.stop')}
              type="button"
            >
              <Icon name="power" size={15} /> {t('rooms.lan.stop')}
            </button>
          </div>

          {/* Self-service row: the two things that actually unstick a session. */}
          {(onDiagnostics || onAllowApp) && (
            <div className="room-lan-tools">
              {onAllowApp && (
                <button
                  className="room-lan-tool"
                  onClick={allowApp}
                  disabled={busy}
                  title={t('rooms.lan.fwHint')}
                  type="button"
                >
                  <Icon name="shield" size={12} /> {t('rooms.lan.fwAction')}
                </button>
              )}
              {onDiagnostics && (
                <button
                  className="room-lan-tool"
                  onClick={() => setDiagOpen(true)}
                  title={t('rooms.lan.diagHint')}
                  type="button"
                >
                  <Icon name="activity" size={12} /> {t('rooms.lan.diagAction')}
                </button>
              )}
            </div>
          )}

          {/* Phase 2B: peers with no direct leg that ARE reachable through another
              player. This is deliberately NOT the red block — the pair can play.
              It is still a notice rather than silence, because relaying has two
              costs the user cannot see: the extra hop (latency) and the fact that
              the forwarding player terminates encryption and can read the frames. */}
          {relayedPeers.length > 0 && (
            <div className="room-lan-note">
              <span className="room-lan-note-head">
                <Icon name="share-2" size={13} />
                {t('rooms.lan.relayedTitle')}
              </span>
              {relayedPeers.map((p) => (
                <span className="room-lan-note-line" key={p.memberId}>
                  <span className="room-lan-note-who">{nameOf(p.memberId)}</span>
                  <span className="room-lan-note-via">
                    {t('rooms.lan.viaPeer').replace('{n}', nameOf(p.relayVia))}
                  </span>
                </span>
              ))}
              <span className="room-lan-note-body">{t('rooms.lan.relayedHint')}</span>
              <span className="room-lan-note-body">{t('rooms.lan.relayedPrivacy')}</span>
            </div>
          )}

          {/* Honest terminal failure: ICE found no working path to these peers AND
              no relay is carrying them. Peers that a relay DID rescue were filtered
              out above — leaving them here would render a working link as broken
              and send the user off to configure a TURN server they do not need.
              A red dot alone reads as "still trying" — it never is. */}
          {failedPeers.length > 0 && (
            <div className="room-lan-fail">
              <span className="room-lan-fail-head">
                <Icon name="alert-triangle" size={13} />
                {t('rooms.lan.failTitle').replace('{n}', failedPeers.map((p) => nameOf(p.memberId)).join(', '))}
              </span>
              <span className="room-lan-fail-body">{t(FAIL_REASON_KEY[failReason] || FAIL_REASON_KEY.unknown)}</span>
              {/* iceServers are frozen at session start, so a TURN entry added now
                  only applies to the NEXT session — say so rather than let the user
                  stare at an unchanged red dot. */}
              <span className="room-lan-fail-body">{t('rooms.lan.failTurnHint')}</span>
              {onOpenTurnSettings && (
                <button className="room-lan-link" onClick={onOpenTurnSettings} type="button">
                  {t('rooms.lan.failOpenSettings')}
                </button>
              )}
            </div>
          )}

          {/* Phase 2B visibility + opt-out: forwarding for someone else spends THIS
              install's uplink, so it can never be silent. The live line carries the
              count (and names in its tooltip); the switch stops it mid-session. */}
          {(onSetRelayEnabled || relayCount > 0) && (
            <div className={`room-lan-relay${relayCount > 0 ? ' live' : ''}`}>
              <div className="room-lan-relay-row">
                <span className="room-lan-relay-label">
                  <Icon name="share-2" size={12} /> {t('rooms.lan.relayToggle')}
                </span>
                {onSetRelayEnabled && (
                  <Toggle
                    size="small"
                    checked={relayEnabled}
                    onChange={toggleRelay}
                    disabled={busy}
                    ariaLabel={t('rooms.lan.relayToggle')}
                  />
                )}
              </div>
              <span className="room-lan-relay-desc">{t('rooms.lan.relayToggleDesc')}</span>
              {/* The count wins over the switch: while frames are still in flight
                  after a flip, "off" would be the wrong thing to claim. */}
              {relayCount > 0 ? (
                <span className="room-lan-relay-live" title={relayForNames || undefined}>
                  <span className="room-lan-relay-dot" />
                  {t('rooms.lan.relaying').replace('{n}', String(relayCount))}
                </span>
              ) : (
                <span className="room-lan-relay-desc">
                  {relayEnabled ? t('rooms.lan.relayNone') : t('rooms.lan.relayOff')}
                </span>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          {startBlockedReason && <div className="room-lan-notice">{startBlockedReason}</div>}
          {lan.selfAdmitted && lan.sessionId && onAccept ? (
            // The host has ADMITTED us to a session we haven't joined → Accept it
            // (joiner path). Decided by session STATE, not by the callback's presence
            // — the panel always receives onAccept, so keying off it made this button
            // always call lanAccept and the Start path was unreachable.
            <button className="room-lan-join" onClick={wrap(onAccept)} disabled={busy} type="button">
              <Icon name="network" size={14} /> {t('rooms.lan.accept')}
            </button>
          ) : (
            // No incoming invite → Start our OWN session (host path opens the picker
            // → onStart → lanStart, which broadcasts genesis + admits).
            <button
              className="room-lan-join"
              onClick={() => setPickerMode('start')}
              disabled={!canStart}
              title={startBlockedReason || undefined}
              type="button"
            >
              <Icon name="network" size={14} /> {t('rooms.lan.start')}
            </button>
          )}
          {/* Diagnostics is useful precisely when Start is greyed out — it is the
              surface that names the missing driver / kill-switch / busy session. */}
          {onDiagnostics && (
            <div className="room-lan-tools">
              <button
                className="room-lan-tool"
                onClick={() => setDiagOpen(true)}
                title={t('rooms.lan.diagHint')}
                type="button"
              >
                <Icon name="activity" size={12} /> {t('rooms.lan.diagAction')}
              </button>
            </div>
          )}
        </>
      )}

      {peers.length > 0 && (
        <div className="room-lan-people">
          {peers.map((p: LanParticipantView) => (
            <div
              key={p.memberId}
              className={`room-lan-person${p.relayVia ? ' relayed' : p.memberId in failLatch ? ' failed' : ''}`}
              title={nameOf(p.memberId)}
            >
              <span className="room-lan-ring">
                <Avatar seed={seedOf(p.memberId)} img={memberOf(p.memberId)?.avatarImg} size={30} />
                <span className={`room-lan-quality ${dotClass(p)}`} title={dotTitle(p)} />
                {/* Relay glyph: the tile must read "not direct" WITHOUT a hover. */}
                {p.relayVia && (
                  <span
                    className="room-lan-relay-badge"
                    title={t('rooms.lan.viaPeer').replace('{n}', nameOf(p.relayVia))}
                  >
                    <Icon name="share-2" size={9} />
                  </span>
                )}
                {lan.isHost && onEvict && (
                  <button
                    className="room-lan-evict"
                    onClick={wrap(() => onEvict(p.memberId))}
                    disabled={busy}
                    title={t('rooms.lan.evict')}
                    type="button"
                  >
                    <Icon name="x" size={10} />
                  </button>
                )}
              </span>
              <span
                className="room-lan-pname"
                style={memberOf(p.memberId)?.color ? { color: memberOf(p.memberId)?.color } : undefined}
              >
                {nameOf(p.memberId)}
              </span>
              <button
                className="room-lan-pip"
                onClick={() => copyIp(p.vip)}
                title={t('rooms.lan.copyIp')}
                type="button"
                disabled={!p.vip}
              >
                {p.vip || '···'}
              </button>
              {/* "via <name>" caption — the one fact the dot cannot carry. */}
              {p.relayVia && (
                <span
                  className="room-lan-via"
                  title={t('rooms.lan.relayQualityNote').replace('{n}', nameOf(p.relayVia))}
                >
                  {t('rooms.lan.viaPeer').replace('{n}', nameOf(p.relayVia))}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {pickerMode && (
        <LanPeerPicker
          members={members}
          selfId={selfId}
          excludeIds={pickerMode === 'invite' ? admittedIds : []}
          title={pickerMode === 'invite' ? t('rooms.lan.pickPeers') : t('rooms.lan.confirm')}
          onClose={() => setPickerMode(null)}
          onPick={(ids) => {
            const mode = pickerMode;
            setPickerMode(null);
            void wrap(() => (mode === 'invite' && onInvite ? onInvite(ids) : onStart(ids)))();
          }}
        />
      )}

      {diagOpen && onDiagnostics && (
        <LanDiagnosticsModal run={runDiagnostics} onClose={() => setDiagOpen(false)} />
      )}
    </div>
  );
};

export default RoomLanPanel;
