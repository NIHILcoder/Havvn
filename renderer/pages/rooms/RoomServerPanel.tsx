/**
 * RoomServerPanel — the room's game servers: create one, run it, watch its
 * console, edit its settings.
 *
 * THE ONE THING THIS PANEL MUST GET RIGHT is never showing a spinner where an
 * explanation belongs. A game server fails in ways the user can actually fix —
 * the port is taken, the memory limit is too low, the LAN session is not up so
 * nobody else can reach it — and each of those has a specific sentence here
 * instead of a generic "failed". That is the same lesson RoomLanPanel learned:
 * a dead tile with no reason is worse than no tile.
 *
 * ADDRESS HONESTY: a running server with no virtual-LAN session is reachable on
 * the host's machine and nowhere else. The panel says exactly that rather than
 * showing a blank address field and letting the user conclude it is broken.
 *
 * LAYOUT. Two things carry the panel: the status card at the top (state, version,
 * address-to-copy, population) and ONE primary button under it. Everything else —
 * restart, open folder, delete — is a ghost affordance in a row below, with delete
 * pushed to the far end. The earlier version gave Start, Restart, Open folder and
 * Delete server the same visual weight in one wrapping row, which made the
 * destructive action a neighbour of the one people press constantly.
 *
 * REALM: this is a dock panel, so it can be torn off into a child window.
 * Anything reaching for a document or a window resolves the panel's OWN realm
 * (see useHostWindow / useHostToast in RoomLanPanel's header for why the module
 * singletons are wrong here). `window.api` stays absolute: a child window has no
 * preload bridge of its own, and the React tree runs in the main renderer either
 * way.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DropdownMenu, Icon, Select, Toggle } from '../../components';
import type { DropdownMenuItem, IconName } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostWindow, resolveHostWindow } from '../../utils/hostWindow';
import { useHostToast } from '../../utils/hostToast';
import type {
  ConfigField, ConsoleLine, GameVersionRef, ImportCandidate, ImportScanResult,
  RoomServerInstance, RoomServerState,
} from '../../../shared/types';
import { IMPORT_JAVA_MAJORS } from '../../../shared/gameserver-types';
import { GamePicker } from './GamePicker';
import { ServerConsole } from './ServerConsole';
import { ServerConfigForm } from './ServerConfigForm';
import { ServerConfigField } from './ServerConfigField';
import { ServerContentPanel } from './ServerContentPanel';
import { ServerSchedulePanel } from './ServerSchedulePanel';
import { ServerAccessPanel } from './ServerAccessPanel';
import { ServerBackupPanel } from './ServerBackupPanel';
import { ServerPlayersPanel } from './ServerPlayersPanel';
import { useServerError, useServerErrorParts } from './serverErrors';
import './RoomServerPanel.css';

/** Flavours the create form offers as a filter. Order is the order a person
 *  scanning "what kind of Minecraft server" expects — Paper first (most common
 *  for friends), then the mod loaders, then plain vanilla. */
const MC_FLAVOURS = ['paper', 'fabric', 'neoforge', 'forge', 'vanilla'] as const;

interface RoomServerPanelProps {
  roomId: string;
  /**
   * The dock's move affordance. This panel is a `soloHost`, so a docked zone
   * holding only it hides the tab strip and the header below hosts the handle
   * instead — otherwise a solo Servers column would offer no way to move the
   * panel at all (the zone body is a drop target, never a drag source).
   */
  soloHandle?: React.ReactNode;
}

export type Tab = 'overview' | 'console' | 'content' | 'schedule' | 'access' | 'backup' | 'players' | 'settings';

const EMPTY_STATE: RoomServerState = { available: true, modules: [], instances: [] };

/**
 * Which tabs an instance actually has.
 *
 * A remote instance is a mirror: there is no local directory to configure, no
 * schedule to arm, nobody here to grant. Only Minecraft has player lists.
 */
export function visibleTabsFor(instance: Pick<RoomServerInstance, 'remote' | 'moduleId'>): Tab[] {
  if (instance.remote === true) return ['overview', 'console'];
  const tabs: Tab[] = ['overview', 'console', 'content', 'schedule', 'access', 'backup'];
  if (instance.moduleId === 'minecraft') tabs.push('players');
  tabs.push('settings');
  return tabs;
}

/**
 * The tab to show, given the one the user last picked.
 *
 * Selection lives above `tab`, so switching instances keeps it — and a tab the
 * new instance does not have left the strip with nothing active and the body
 * blank, because every panel is gated on the same conditions that built the
 * list. Overview is the one tab that always exists.
 */
export function resolveTab(tab: Tab, tabs: Tab[]): Tab {
  return tabs.includes(tab) ? tab : 'overview';
}

/** Status → the dot's modifier class. Installing and starting share the "busy"
 *  treatment because both are "wait, something is happening". */
function statusTone(status: RoomServerInstance['status']): string {
  if (status === 'running') return 'good';
  if (status === 'installing' || status === 'starting' || status === 'stopping') return 'busy';
  if (status === 'crashed') return 'bad';
  return 'idle';
}

function formatUptime(since: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export const RoomServerPanel: React.FC<RoomServerPanelProps> = ({ roomId, soloHandle }) => {
  const { t } = useTranslation();
  const toast = useHostToast();
  const host = useHostWindow();
  const errorText = useServerError();
  const rootRef = useRef<HTMLDivElement | null>(null);

  const [state, setState] = useState<RoomServerState>(EMPTY_STATE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  /** Creating is now two steps: the picker names the game, then the form fills
   *  it in. `creatingModule` IS the second step — holding the chosen module here
   *  rather than inside the form keeps "which game" out of the form's state, so
   *  it cannot silently fall back to modules[0] when the picker is bypassed. */
  const [gamePickerOpen, setGamePickerOpen] = useState(false);
  const [creatingModule, setCreatingModule] = useState<string | null>(null);

  // ── state sync ─────────────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true;
    void window.api.rooms.servers.state(roomId).then((s) => { if (alive) setState(s); }).catch(() => { /* room gone */ });
    const off = window.api.rooms.servers.onUpdate((payload) => {
      if (payload.roomId === roomId) setState(payload.state);
    });
    const offAlert = window.api.onServerAlert?.((payload) => {
      if (payload.roomId !== roomId) return;
      const key = `rooms.server.alert.${payload.kind}` as const;
      const msg = t(key as never).replace('{name}', payload.name);
      toast.error(payload.detail ? `${msg}: ${payload.detail}` : msg);
    });
    return () => { alive = false; off(); offAlert?.(); };
  }, [roomId, t, toast]);

  const instances = state.instances;
  const selected = useMemo(
    () => instances.find((i) => i.instanceId === selectedId) ?? instances[0] ?? null,
    [instances, selectedId],
  );

  const moduleName = useMemo(
    () => state.modules.find((m) => m.id === selected?.moduleId)?.displayName,
    [selected?.moduleId, state.modules],
  );

  // Follow the list when the selection disappears (deleted elsewhere, or the
  // very first instance arriving) so the panel is never pointed at nothing.
  useEffect(() => {
    if (selected && selected.instanceId !== selectedId) setSelectedId(selected.instanceId);
    if (!selected && selectedId) setSelectedId(null);
  }, [selected, selectedId]);

  // A running server's uptime must tick without a state push.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!selected || selected.status !== 'running') return undefined;
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [selected]);

  // ── actions ────────────────────────────────────────────────────────────────

  const run = useCallback(async (
    action: () => Promise<{ ok: boolean; reason?: string }>,
  ): Promise<void> => {
    try {
      const res = await action();
      // `reason` arrives as a BARE code here — it came back as a value rather than
      // being thrown through IPC, so there is no message to carry a prefix.
      if (!res.ok && res.reason) toast.error(errorText(res.reason));
    } catch (err) {
      toast.error(errorText(err));
    }
  }, [errorText, toast]);

  const copyAddress = useCallback((address: string) => {
    // The clipboard of the window this panel is REALLY in. A detached panel
    // writing through the main window's navigator rejects with "Document is not
    // focused" — that document is unfocused precisely because the child has
    // focus — so the copy silently failed and no toast ever appeared.
    const win = resolveHostWindow(rootRef.current, host).window;
    win.navigator.clipboard?.writeText(address)
      .then(() => toast.success(t('rooms.server.copied')))
      .catch(() => { /* clipboard blocked — the address is still on screen */ });
  }, [host, t, toast]);

  // ── render ─────────────────────────────────────────────────────────────────

  if (creatingModule) {
    return (
      <div className="room-server-panel" ref={rootRef}>
        <CreateServerForm
          roomId={roomId}
          moduleId={creatingModule}
          modules={state.modules}
          soloHandle={soloHandle}
          onDone={(id) => { setCreatingModule(null); if (id) { setSelectedId(id); setTab('console'); } }}
        />
      </div>
    );
  }

  return (
    <div className="room-server-panel" ref={rootRef}>
      <div className="room-server-head">
        <span className="room-server-head-title">
          <span className="room-section-title">{t('rooms.server.title')}</span>
          <span className="room-server-beta">{t('rooms.server.beta')}</span>
          {instances.length > 1 && <span className="room-server-count">{instances.length}</span>}
        </span>
        <span className="room-server-head-actions">
          {soloHandle}
          <button
            type="button"
            className="room-server-new"
            title={t('rooms.server.create')}
            onClick={() => setGamePickerOpen(true)}
          >
            <Icon name="plus" size={13} />
            {t('rooms.server.create')}
          </button>
        </span>
      </div>

      {instances.length === 0 ? (
        <div className="room-server-empty">
          <span className="room-server-empty-mark"><Icon name="server" size={22} /></span>
          <p className="room-server-empty-title">{t('rooms.server.empty')}</p>
          <p className="room-server-empty-hint">{t('rooms.server.emptyHint')}</p>
          {/* The CTA belongs here too: the header pill is easy to miss on a panel
              whose whole body says "there is nothing yet". */}
          <button type="button" className="room-server-primary" onClick={() => setGamePickerOpen(true)}>
            <Icon name="plus" size={14} />
            {t('rooms.server.create')}
          </button>
        </div>
      ) : (
        <>
          {instances.length > 1 && (
            <div className="room-server-rail" role="tablist">
              {instances.map((i) => (
                <button
                  key={i.instanceId}
                  type="button"
                  role="tab"
                  aria-selected={i.instanceId === selected?.instanceId}
                  className={`room-server-rail-item${i.instanceId === selected?.instanceId ? ' is-active' : ''}`}
                  title={i.name}
                  onClick={() => setSelectedId(i.instanceId)}
                >
                  <span className={`room-server-dot is-${statusTone(i.status)}`} />
                  <span className="room-server-rail-name">{i.name}</span>
                </button>
              ))}
            </div>
          )}

          {selected && (
            <ServerDetail
              roomId={roomId}
              instance={selected}
              tab={tab}
              onTab={setTab}
              onRun={run}
              onCopyAddress={copyAddress}
              {...(moduleName ? { moduleName } : {})}
            />
          )}
        </>
      )}

      {gamePickerOpen && (
        <GamePicker
          modules={state.modules}
          onClose={() => setGamePickerOpen(false)}
          onPick={(id) => { setGamePickerOpen(false); setCreatingModule(id); }}
        />
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────

interface ServerDetailProps {
  roomId: string;
  instance: RoomServerInstance;
  tab: Tab;
  onTab: (t: Tab) => void;
  onRun: (action: () => Promise<{ ok: boolean; reason?: string }>) => Promise<void>;
  onCopyAddress: (address: string) => void;
  /** The module's own display name, for the card chip. Absent if the module that
   *  created this instance is no longer registered. */
  moduleName?: string;
}

const TAB_ICONS: Record<Tab, IconName> = {
  overview: 'list',
  console: 'monitor',
  content: 'package',
  schedule: 'clock',
  access: 'users',
  backup: 'archive',
  players: 'users',
  settings: 'sliders',
};

const ServerDetail: React.FC<ServerDetailProps> = ({ roomId, instance, tab, onTab, onRun, onCopyAddress, moduleName }) => {
  const { t } = useTranslation();
  const toast = useHostToast();
  const errorParts = useServerErrorParts();
  const errorText = useCallback((err: unknown): string => errorParts(err).text, [errorParts]);
  const api = window.api.rooms.servers;
  const { instanceId, status } = instance;

  const live = status === 'running' || status === 'starting' || status === 'stopping';
  const busy = status === 'installing' || status === 'starting' || status === 'stopping';
  const tone = statusTone(status);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);

  /**
   * Update state, kept local to the selected server.
   *
   * 'idle' → nothing asked yet, 'checking' → in flight, a string → that build is
   * available, 'current' → checked and already newest. Deliberately not persisted
   * or pushed with the instance state: an offer the user ignored should expire
   * with the panel rather than sit there going stale.
   */
  const [update, setUpdate] = useState<'idle' | 'checking' | 'current' | { label: string }>('idle');
  useEffect(() => { setUpdate('idle'); }, [instanceId]);

  const checkUpdate = useCallback(async (): Promise<void> => {
    setUpdate('checking');
    try {
      const res = await api.checkUpdate(instanceId);
      setUpdate(res.available ? { label: res.available } : 'current');
    } catch (err) {
      setUpdate('idle');
      toast.error(errorText(err));
    }
  }, [api, errorText, instanceId, toast]);

  // Offered only where it can succeed: an imported tree has no publisher to ask,
  // and a button whose only outcome is an error message is worse than no button.
  const isRemote = instance.remote === true;
  const canUpdate = !isRemote && instance.updatable && !busy && !live && instance.failReason !== 'install-failed';
  const canConsole = instance.role === 'host' || instance.role === 'operator';
  const [sysJava, setSysJava] = useState<{ available: boolean; version?: string; major?: number } | null>(null);
  useEffect(() => {
    if (isRemote) return;
    void api.systemJava().then(setSysJava).catch(() => { /* ignore */ });
  }, [api, isRemote, instanceId]);
  // Shown while it is ON even if Java has since gone: hiding the row on
  // availability alone left the setting stuck on with no control to undo it, and
  // a server that would not start.
  const usingSystemJava = instance.useSystemJava === true;
  const showSystemJava = !isRemote && (sysJava?.available === true || usingSystemJava);
  const systemJavaMissing = usingSystemJava && sysJava !== null && !sysJava.available;

  /** Restart is a RUNNING-server action. On a stopped one it duplicated the
   *  full-width Start above it — and was not even disabled. A mirror is somebody
   *  else's process, so it is not ours to bounce either. */
  const showRestart = live && !isRemote;

  /**
   * The ⋯ menu: everything that is neither the primary action nor the one people
   * press between edits. Built as a list so the trigger can be dropped entirely
   * when nothing qualifies — a remote mirror has no folder to open, no publisher
   * to ask and no files to delete, and an empty menu is worse than no menu.
   */
  const moreItems = useMemo<DropdownMenuItem[]>(() => {
    const items: DropdownMenuItem[] = [];
    if (canUpdate && update === 'idle') {
      items.push({
        key: 'update',
        icon: <Icon name="download" size={14} />,
        label: t('rooms.server.checkUpdate'),
        onSelect: () => void checkUpdate(),
      });
    }
    if (!isRemote) {
      items.push({
        key: 'folder',
        icon: <Icon name="folder-open" size={14} />,
        label: t('rooms.server.openFolder'),
        onSelect: () => void api.openFolder(instanceId),
      });
      items.push({
        key: 'delete',
        danger: true,
        icon: <Icon name="trash" size={14} />,
        label: t('rooms.server.delete'),
        // Kept in the list while the server runs, and answered instead of being
        // silently absent: the reason it cannot happen yet is the useful part, and
        // it is the same sentence the old disabled button carried in its tooltip.
        onSelect: () => {
          if (live || busy) { toast.error(t('rooms.server.deleteStopFirst')); return; }
          setConfirmDelete(true);
        },
      });
    }
    return items;
  }, [api, busy, canUpdate, checkUpdate, instanceId, isRemote, live, t, toast, update]);

  const visibleTabs = useMemo(
    () => visibleTabsFor({ remote: instance.remote, moduleId: instance.moduleId }),
    [instance.remote, instance.moduleId],
  );

  useEffect(() => {
    const next = resolveTab(tab, visibleTabs);
    if (next !== tab) onTab(next);
  }, [visibleTabs, tab, onTab]);

  /**
   * The line under the failure sentence.
   *
   * Two different things arrive here. A refusal the core made on purpose ("not
   * enough disk space") comes back as a code and must be read as prose in the
   * user's language. A genuine upstream fault — a 404 from a mirror, a truncated
   * download — is a technical string and stays monospaced, because that is the
   * form in which it is useful.
   */
  const failDetail = instance.failDetail ? errorParts(instance.failDetail) : null;

  // What a person would paste into the game. `address` is the virtual-LAN one
  // everybody can reach; the loopback fallback is still worth offering, because
  // testing the server yourself is the first thing anyone does.
  const address = instance.address ?? (instance.port ? `127.0.0.1:${instance.port}` : null);
  const shareable = Boolean(instance.address);

  return (
    <div className="room-server-detail">
      <div className={`room-server-card is-${tone}`}>
        <div className="room-server-card-top">
          <span className="room-server-name" title={instance.name}>{instance.name}</span>
          <span className={`room-server-state is-${tone}`}>
            <span className={`room-server-dot is-${tone}`} />
            {t(`rooms.server.status.${status}` as never)}
            {status === 'running' && (
              <span className="room-server-state-since">{formatUptime(instance.since)}</span>
            )}
          </span>
        </div>

        <div className="room-server-chips">
          {moduleName && <span className="room-server-chip"><Icon name="package" size={10} />{moduleName}</span>}
          <span className="room-server-chip">{instance.version}</span>
        </div>

        {status === 'installing' && (
          <div className="room-server-install">
            <div className="room-server-progress">
              <div className="room-server-progress-fill" style={{ width: `${instance.installPct ?? 0}%` }} />
            </div>
            <span className="room-server-install-pct">{instance.installPct ?? 0}%</span>
            <button type="button" className="room-server-link" onClick={() => void api.cancelInstall(instanceId)}>
              {t('rooms.server.cancelInstall')}
            </button>
          </div>
        )}

        {address && (
          <button
            type="button"
            className="room-server-addr"
            title={t('rooms.server.copyAddress')}
            onClick={() => onCopyAddress(address)}
          >
            <span className="room-server-addr-text">{address}</span>
            <Icon name="copy" size={12} />
          </button>
        )}

        {/*
          Address honesty. A running server with no virtual-LAN session is
          reachable on this machine and nowhere else, and a stopped one is
          reachable nowhere at all — both say so instead of leaving the user to
          conclude the address is broken.
        */}
        {address && !shareable && (
          <p className="room-server-addr-note">
            <Icon name="info" size={11} />
            {live ? t('rooms.server.noAddress') : t('rooms.server.addrOffline')}
          </p>
        )}

        {instance.players && (
          <div className="room-server-players">
            <Icon name="users" size={12} />
            <span className="room-server-players-count">
              {instance.players.online} / {instance.players.max}
            </span>
            {instance.players.names?.length ? (
              <span className="room-server-players-names">{instance.players.names.join(', ')}</span>
            ) : null}
          </div>
        )}
      </div>

      {/*
        A failure gets a SENTENCE, not a status code. Every reason maps to a
        specific explanation, and failDetail carries the actual log line or exit
        code underneath — so "it broke" is never the whole message.
      */}
      {instance.failReason && (
        <div className="room-server-failure" role="alert">
          <Icon name="alert-triangle" size={14} />
          <div className="room-server-failure-body">
            <span>{t(`rooms.server.fail.${instance.failReason}` as never)}</span>
            {failDetail && (failDetail.code
              ? <span className="room-server-failure-why">{failDetail.text}</span>
              : <code className="room-server-failure-detail">{failDetail.text}</code>
            )}
            {instance.restarts ? (
              <span className="room-server-failure-restarts">
                {t('rooms.server.restartsSpent').replace('{n}', String(instance.restarts))}
              </span>
            ) : null}
          </div>
          <div className="room-server-failure-acts">
            {/*
              A failed install used to be a dead end: the only ways out were
              Dismiss and Delete, even though the core has always been able to run
              the plan again. Most install failures are a flaky mirror or a
              momentarily-offline vendor, which is to say the fix really is "try
              again" — so it needs to be a button and not a rebuild from scratch.
            */}
            {instance.failReason === 'install-failed' && (
              <button
                type="button"
                className="room-server-link is-strong"
                disabled={busy}
                onClick={() => void onRun(async () => {
                  await api.reinstall(instanceId);
                  return { ok: true };
                })}
              >
                <Icon name="refresh-cw" size={12} />
                {t('rooms.server.retryInstall')}
              </button>
            )}
            <button type="button" className="room-server-link" onClick={() => void api.clearFailure(instanceId)}>
              {t('rooms.server.dismiss')}
            </button>
          </div>
        </div>
      )}

      {/* ONE primary action, full width. Start and Stop are the reason the panel
          is open; Restart / folder / delete are not, and used to shout as loudly. */}
      {live ? (
        <button
          type="button"
          className="room-server-primary is-stop"
          disabled={status === 'stopping' || isRemote}
          onClick={() => void onRun(() => api.stop(instanceId))}
        >
          <Icon name="pause" size={13} />
          {t('rooms.server.stop')}
        </button>
      ) : (
        <button
          type="button"
          className="room-server-primary"
          disabled={busy || isRemote}
          onClick={() => void onRun(() => api.start(instanceId))}
        >
          <Icon name="play" size={13} />
          {t('rooms.server.start')}
        </button>
      )}

      {/*
        The pinned build, and whether the publisher has moved on.
        A server was pinned to whatever build existed on the day it was created and
        stayed there for good — reinstall faithfully re-downloaded the same one. The
        check is manual on purpose: swapping the jar under a world is not something
        to do on a timer, and the world is the part nobody can re-download.
      */}
      {/* The RESULT only. The trigger moved into the ⋯ menu below, because checking
          for a build is the rarest thing on this panel and it was taking a whole
          row at the same visual weight as Restart. What is left here is transient
          status, which belongs in the layout rather than behind a menu. */}
      {canUpdate && update !== 'idle' && (
        <div className="room-server-update">
          {update === 'checking' && <span className="room-server-update-note">{t('rooms.server.checkingUpdate')}</span>}
          {update === 'current' && (
            <span className="room-server-update-note is-good">
              <Icon name="check" size={12} />
              {t('rooms.server.upToDate')}
            </span>
          )}
          {typeof update === 'object' && (
            <>
              <span className="room-server-update-note">
                {t('rooms.server.updateFound').replace('{v}', update.label)}
              </span>
              <button
                type="button"
                className="room-server-link is-strong"
                onClick={() => void onRun(async () => {
                  await api.applyUpdate(instanceId);
                  setUpdate('idle');
                  return { ok: true };
                })}
              >
                {t('rooms.server.updateApply')}
              </button>
            </>
          )}
        </div>
      )}

      {/*
        ONE row under the primary: the action people press between edits, and a ⋯ for
        the rest. Before this there were three rows of identically-weighted ghost
        buttons — Check for update alone on one, then Restart / Open folder / Delete
        on another — so five controls arrived with no hierarchy, and Delete was a
        sibling of Open folder with nothing but whitespace between them.

        Restart appears only while the server RUNS. On a stopped one it did the same
        thing as the full-width Start directly above it, and it was not even disabled.
      */}
      {(showRestart || moreItems.length > 0) && (
        <div className="room-server-tools">
          {showRestart && (
            <button type="button" className="room-server-tool" disabled={busy} onClick={() => void onRun(() => api.restart(instanceId))}>
              <Icon name="refresh-cw" size={12} />
              {t('rooms.server.restart')}
            </button>
          )}
          {moreItems.length > 0 && (
            <DropdownMenu
              // The dock zone sets container-type, which makes it the containing
              // block for fixed descendants — an in-place menu would be trapped in
              // the panel's box. Portalling is load-bearing here, not cosmetic.
              portal
              menuClassName="dropdown-menu dropdown-menu-right"
              items={moreItems}
              renderTrigger={({ open, toggle }) => (
                <button
                  type="button"
                  className={`room-server-tool is-more${open ? ' is-open' : ''}`}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  title={t('rooms.server.more')}
                  aria-label={t('rooms.server.more')}
                  onClick={toggle}
                >
                  <Icon name="more-horizontal" size={14} />
                </button>
              )}
            />
          )}
        </div>
      )}

      {confirmDelete && (
        <div className="room-server-danger" role="alertdialog" aria-label={t('rooms.server.delete')}>
          <span className="room-server-danger-title">
            {t('rooms.server.deleteConfirm').replace('{name}', instance.name)}
          </span>
          <p className="room-server-danger-hint">{t('rooms.server.deleteHint')}</p>
          <label className="room-server-check">
            <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
            <span>{t('rooms.server.deleteFiles')}</span>
          </label>
          <div className="room-server-danger-actions">
            <button
              type="button"
              className="room-server-btn is-danger"
              onClick={() => {
                setConfirmDelete(false);
                void api.remove(instanceId, deleteFiles).catch((err: unknown) => toast.error(errorText(err)));
              }}
            >
              <Icon name="trash" size={12} />
              {t('rooms.server.delete')}
            </button>
            <button type="button" className="room-server-btn" onClick={() => setConfirmDelete(false)}>
              {t('rooms.server.cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="room-server-viewtabs" role="tablist">
        {visibleTabs.map((id) => {
          const label = t(`rooms.server.${id}` as never);
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`room-server-viewtab${tab === id ? ' is-active' : ''}`}
              // A tooltip because the labels are uppercase with HUD tracking, which
              // is the kind of styling people re-read. No aria-label: the visible
              // text already names the button, and a duplicate one is only another
              // string to let drift.
              title={label}
              onClick={() => onTab(id)}
            >
              <Icon name={TAB_ICONS[id]} size={11} />
              <span className="room-server-viewtab-label">{label}</span>
            </button>
          );
        })}
      </div>

      <div className="room-server-view">
        {tab === 'overview' && (
          <div className="room-server-overview">
            <div className="room-server-facts">
              {isRemote && (
                <div className="room-server-fact">
                  <span className="room-server-fact-key">{t('rooms.server.host')}</span>
                  <span className="room-server-fact-val">{t('rooms.server.remoteHosted')}</span>
                </div>
              )}
              {moduleName && (
                <div className="room-server-fact">
                  <span className="room-server-fact-key">{t('rooms.server.game')}</span>
                  <span className="room-server-fact-val">{moduleName}</span>
                </div>
              )}
              <div className="room-server-fact">
                <span className="room-server-fact-key">{t('rooms.server.version')}</span>
                <span className="room-server-fact-val">{instance.version}</span>
              </div>
              {instance.port !== undefined && (
                <div className="room-server-fact">
                  <span className="room-server-fact-key">{t('rooms.server.port')}</span>
                  <span className="room-server-fact-val is-mono">{instance.port}</span>
                </div>
              )}
              {instance.players && (
                <div className="room-server-fact">
                  <span className="room-server-fact-key">{t('rooms.server.players')}</span>
                  <span className="room-server-fact-val">
                    {instance.players.online} / {instance.players.max}
                    {instance.players.names?.length ? ` · ${instance.players.names.join(', ')}` : ''}
                  </span>
                </div>
              )}
              {status === 'running' && (
                <div className="room-server-fact">
                  <span className="room-server-fact-key">{t('rooms.server.uptime')}</span>
                  <span className="room-server-fact-val is-mono">{formatUptime(instance.since)}</span>
                </div>
              )}
              {instance.scheduleEnabled && (instance.scheduleRules ?? 0) > 0 && (
                <div className="room-server-fact">
                  <span className="room-server-fact-key">{t('rooms.server.schedule')}</span>
                  <span className="room-server-fact-val">
                    {t('rooms.server.schedule.overview').replace('{n}', String(instance.scheduleRules))}
                  </span>
                </div>
              )}
              {(instance.operators?.length ?? 0) > 0 && (
                <div className="room-server-fact">
                  <span className="room-server-fact-key">{t('rooms.server.access')}</span>
                  <span className="room-server-fact-val">
                    {t('rooms.server.access.overview').replace('{n}', String(instance.operators!.length))}
                  </span>
                </div>
              )}
            </div>

            {!isRemote && (
              <div className="room-server-setting">
                <span className="room-server-setting-text">
                  <span className="room-server-setting-title">{t('rooms.server.autoRestart')}</span>
                  <span className="room-server-setting-hint">{t('rooms.server.autoRestartHint')}</span>
                </span>
                <Toggle
                  checked={instance.autoRestart}
                  ariaLabel={t('rooms.server.autoRestart')}
                  onChange={(checked) => void api.setAutoRestart(instanceId, checked)}
                />
              </div>
            )}
            {showSystemJava && (
              <div className="room-server-setting">
                <span className="room-server-setting-text">
                  <span className="room-server-setting-title">{t('rooms.server.systemJava')}</span>
                  <span className={`room-server-setting-hint${systemJavaMissing ? ' is-warn' : ''}`}>
                    {systemJavaMissing
                      ? t('rooms.server.systemJavaMissing')
                      : t('rooms.server.systemJavaHint').replace('{v}', sysJava?.version ?? '')}
                  </span>
                </span>
                <Toggle
                  checked={usingSystemJava}
                  ariaLabel={t('rooms.server.systemJava')}
                  onChange={(checked) => void api.setUseSystemJava(instanceId, checked)}
                />
              </div>
            )}
            {!isRemote && (
              <div className="room-server-setting">
                <span className="room-server-setting-text">
                  <span className="room-server-setting-title">{t('rooms.server.contentAutoSync')}</span>
                  <span className="room-server-setting-hint">{t('rooms.server.contentAutoSyncHint')}</span>
                </span>
                <Toggle
                  checked={instance.contentAutoSync === true}
                  ariaLabel={t('rooms.server.contentAutoSync')}
                  onChange={(checked) => void api.setContentAutoSync(instanceId, checked)}
                />
              </div>
            )}
          </div>
        )}

        {tab === 'console' && (
          <ServerConsole
            instanceId={instanceId}
            roomId={roomId}
            canSend={status === 'running' && canConsole}
            remote={isRemote}
          />
        )}
        {tab === 'content' && !isRemote && (
          <ServerContentPanel roomId={roomId} instanceId={instanceId} locked={live} />
        )}
        {tab === 'schedule' && !isRemote && <ServerSchedulePanel instanceId={instanceId} />}
        {tab === 'access' && !isRemote && <ServerAccessPanel roomId={roomId} instanceId={instanceId} />}
        {tab === 'backup' && !isRemote && <ServerBackupPanel instanceId={instanceId} locked={live} />}
        {tab === 'players' && !isRemote && instance.moduleId === 'minecraft' && (
          <ServerPlayersPanel instanceId={instanceId} />
        )}
        {tab === 'settings' && !isRemote && <ServerConfigForm instanceId={instanceId} locked={live} />}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────

interface CreateServerFormProps {
  /** The game, already chosen in GamePicker. Passed in rather than picked here:
   *  the form has no game field any more, so a default would be a silent one. */
  moduleId: string;
  roomId: string;
  modules: RoomServerState['modules'];
  onDone: (instanceId: string | null) => void;
  /** Carried through so a solo Servers column stays movable mid-create. */
  soloHandle?: React.ReactNode;
}

type CreateMode = 'catalog' | 'import';

const CreateServerForm: React.FC<CreateServerFormProps> = ({ roomId, moduleId, modules, onDone, soloHandle }) => {
  const { t } = useTranslation();
  const toast = useHostToast();
  const errorText = useServerError();
  const api = window.api.rooms.servers;

  /** The chosen game's display name for the header — absent only if the module
   *  disappeared between the picker and here. */
  const gameName = useMemo(() => modules.find((m) => m.id === moduleId)?.displayName, [modules, moduleId]);
  const [mode, setMode] = useState<CreateMode>('catalog');
  const [versions, setVersions] = useState<GameVersionRef[] | null>(null);
  const [flavour, setFlavour] = useState<string>('paper');
  /** '' means "newest family", which is what the form opens on. */
  const [family, setFamily] = useState<string>('');
  const [refId, setRefId] = useState('');
  const [name, setName] = useState('');
  const [gate, setGate] = useState<{ id: string; labelKey: string; url: string; accepted: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The settings asked before the first boot, and their values.
   *
   * Both come from the main process: the schema because only the module knows what
   * it can be asked, and the values because the port is pre-filled with one the
   * core has confirmed is free. A default baked in here is exactly what used to
   * give every server in a room the same port.
   */
  const [setupSchema, setSetupSchema] = useState<ConfigField[]>([]);
  const [setup, setSetup] = useState<Record<string, string>>({});

  // Import staging state — discarded when the form unmounts or the user cancels.
  const [scan, setScan] = useState<ImportScanResult | null>(null);
  const [candidateId, setCandidateId] = useState('');
  const [javaMajor, setJavaMajor] = useState<number>(21);
  const [picking, setPicking] = useState(false);

  const canImport = modules.find((m) => m.id === moduleId)?.caps.import === true;

  useEffect(() => {
    if (!moduleId) return undefined;
    let alive = true;
    setVersions(null);
    setError(null);
    void api.legalGate(moduleId).then((g) => { if (alive) setGate(g); }).catch(() => { if (alive) setGate(null); });
    void api.versions(moduleId)
      .then((list) => {
        if (!alive) return;
        setVersions(list);
        const flavours = new Set(list.map((v) => v.flavour));
        const nextFlavour = flavours.has(flavour)
          ? flavour
          : (MC_FLAVOURS.find((f) => flavours.has(f)) ?? list[0]?.flavour ?? '');
        setFlavour(nextFlavour);
        const filtered = list.filter((v) => v.flavour === nextFlavour);
        setRefId(filtered.find((v) => v.stable)?.id ?? filtered[0]?.id ?? list[0]?.id ?? '');
      })
      .catch((err: unknown) => { if (alive) setError(errorText(err)); });
    // Fetched alongside the catalog rather than on submit: the port shown has to be
    // the one that will be used, and asking for it at submit time would mean the
    // number in the field was never the number that mattered.
    void api.createForm(roomId, moduleId)
      .then((form) => {
        if (!alive) return;
        setSetupSchema(form.schema);
        setSetup(form.values);
      })
      .catch(() => { if (alive) { setSetupSchema([]); setSetup({}); } });
    return () => { alive = false; };
    // flavour intentionally omitted: this effect seeds flavour from the catalog,
    // and re-running it on every flavour click would wipe the user's choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, errorText, moduleId, roomId]);

  // Drop staged bytes if the dialog closes without committing.
  useEffect(() => () => {
    if (scan?.stagingId) void api.discardImport(scan.stagingId).catch(() => { /* ignore */ });
  }, [api, scan?.stagingId]);

  /**
   * Families offered for the chosen flavour, newest first.
   *
   * The catalog now reaches back far enough to cover the versions old modpacks
   * target, which is only usable as two steps: the flat list it replaced was capped
   * at 25 entries and stopped at 1.19.3, so 1.16.5 and 1.12.2 were unreachable.
   */
  const families = useMemo(() => {
    if (!versions) return [];
    const seen: string[] = [];
    for (const v of versions) {
      if (v.flavour !== flavour) continue;
      const fam = v.family ?? v.version;
      if (!seen.includes(fam)) seen.push(fam);
    }
    return seen;
  }, [flavour, versions]);

  const filteredVersions = useMemo(() => {
    if (!versions) return [];
    const fam = family || families[0];
    return versions.filter((v) => v.flavour === flavour && (v.family ?? v.version) === fam);
  }, [families, family, flavour, versions]);

  const availableFlavours = useMemo(() => {
    if (!versions) return [...MC_FLAVOURS];
    const present = new Set(versions.map((v) => v.flavour));
    return MC_FLAVOURS.filter((f) => present.has(f));
  }, [versions]);

  // Switching flavour can land on a family that flavour does not have (NeoForge
  // starts at 1.20 where vanilla goes back to 1.10), so the family follows.
  useEffect(() => {
    if (families.length && !families.includes(family)) setFamily(families[0]);
  }, [families, family]);

  useEffect(() => {
    if (!filteredVersions.length) return;
    if (!filteredVersions.some((v) => v.id === refId)) {
      setRefId(filteredVersions.find((v) => v.stable)?.id ?? filteredVersions[0].id);
    }
  }, [filteredVersions, refId]);

  const needsLegal = gate !== null && !gate.accepted;
  const selectedCandidate: ImportCandidate | null =
    scan?.candidates.find((c) => c.id === candidateId) ?? scan?.candidates[0] ?? null;

  const clearScan = useCallback(() => {
    if (scan?.stagingId) void api.discardImport(scan.stagingId).catch(() => { /* ignore */ });
    setScan(null);
    setCandidateId('');
  }, [api, scan?.stagingId]);

  const pickImport = useCallback(async () => {
    if (!moduleId || needsLegal) return;
    setPicking(true);
    setError(null);
    try {
      const res = await api.pickImport(moduleId);
      if (res.cancelled) return;
      if ('error' in res && res.error) {
        setError(t(`rooms.server.import.fail.${res.error}` as never));
        return;
      }
      if (!('stagingId' in res) || !res.stagingId) return;
      if (scan?.stagingId && scan.stagingId !== res.stagingId) {
        void api.discardImport(scan.stagingId).catch(() => { /* ignore */ });
      }
      if (res.candidates.length === 0) {
        void api.discardImport(res.stagingId).catch(() => { /* ignore */ });
        setScan(null);
        setError(t('rooms.server.import.fail.nothing-recognised'));
        return;
      }
      setScan(res);
      setCandidateId(res.candidates[0].id);
      setJavaMajor(res.candidates[0].javaMajor ?? 21);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPicking(false);
    }
  }, [api, errorText, moduleId, needsLegal, scan?.stagingId, t]);

  const submit = useCallback(async () => {
    if (!moduleId) return;
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'import') {
        if (!scan || !selectedCandidate) return;
        const res = await api.createImported(
          roomId, moduleId, scan.stagingId, selectedCandidate.id,
          name.trim() || undefined,
          selectedCandidate.javaMajor ? undefined : javaMajor,
        );
        // Ownership of staging transferred — do not discard on unmount.
        setScan(null);
        onDone(res.instanceId);
      } else {
        if (!refId) return;
        const res = await api.create(roomId, moduleId, refId, name.trim() || undefined, setup);
        onDone(res.instanceId);
      }
    } catch (err) {
      const message = errorText(err);
      setError(message);
      toast.error(message);
      setSubmitting(false);
    }
  }, [api, errorText, javaMajor, mode, moduleId, name, onDone, refId, roomId, scan, selectedCandidate, setup, toast]);

  const canSubmit = mode === 'catalog'
    ? Boolean(refId) && !needsLegal && !submitting
    : Boolean(scan && selectedCandidate) && !needsLegal && !submitting;

  const formatBytes = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  return (
    <div className="room-server-create">
      <div className="room-server-head">
        <span className="room-server-head-title">
          <span className="room-section-title">{t('rooms.server.create')}</span>
          {/* Which game, now that the form no longer asks: the answer was given a
              window ago, and without it this screen is unlabelled. */}
          {gameName && <span className="room-server-count">{gameName}</span>}
        </span>
        <span className="room-server-head-actions">
          {soloHandle}
          <button
            type="button"
            className="room-server-new"
            title={t('rooms.server.cancel')}
            onClick={() => { clearScan(); onDone(null); }}
          >
            <Icon name="x" size={13} />
            {t('rooms.server.cancel')}
          </button>
        </span>
      </div>

      {/* Fields scroll; the submit button does not — see the footer below. */}
      <div className="room-server-create-scroll">
        {canImport && (
          <div className="room-server-mode" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'catalog'}
              className={`room-server-mode-tab${mode === 'catalog' ? ' is-active' : ''}`}
              onClick={() => { clearScan(); setMode('catalog'); }}
            >
              {t('rooms.server.source.catalog')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'import'}
              className={`room-server-mode-tab${mode === 'import' ? ' is-active' : ''}`}
              onClick={() => setMode('import')}
            >
              {t('rooms.server.source.import')}
            </button>
          </div>
        )}

        {mode === 'catalog' && (
          <>
            <p className="room-server-hint">{t('rooms.server.source.catalogHint')}</p>

            <label className="room-server-field">
              <span className="room-server-label">{t('rooms.server.flavour')}</span>
              <Select
                value={flavour}
                disabled={!versions}
                options={availableFlavours.map((f) => ({
                  value: f,
                  label: t(`rooms.server.flavour.${f}` as never),
                }))}
                onChange={setFlavour}
              />
            </label>

            {/* Family first, then the version inside it. Two short lists instead of
                one long one, which is what lets the catalog offer 1.12 at all. */}
            <div className="room-server-row">
              <label className="room-server-field">
                <span className="room-server-label">{t('rooms.server.family')}</span>
                <Select
                  value={family || families[0] || ''}
                  disabled={!versions || families.length === 0}
                  options={families.map((f) => ({ value: f, label: f }))}
                  onChange={setFamily}
                  placeholder={versions ? t('rooms.server.versionEmpty') : t('rooms.server.versionLoading')}
                />
              </label>

              <label className="room-server-field">
                <span className="room-server-label">{t('rooms.server.version')}</span>
                <Select
                  value={refId}
                  disabled={!versions || filteredVersions.length === 0}
                  options={filteredVersions.map((v) => ({ value: v.id, label: v.label }))}
                  onChange={setRefId}
                  placeholder={versions ? t('rooms.server.versionEmpty') : t('rooms.server.versionLoading')}
                />
              </label>
            </div>
          </>
        )}

        {mode === 'import' && (
          <div className="room-server-import">
            <p className="room-server-hint">{t('rooms.server.source.importHint')}</p>

            {scan && selectedCandidate ? (
              <div className="room-server-picked">
                <Icon name="check" size={14} />
                <span className="room-server-picked-meta">
                  {t('rooms.server.import.summary')
                    .replace('{files}', String(scan.fileCount))
                    .replace('{size}', formatBytes(scan.bytes))}
                </span>
                <button type="button" className="room-server-link" onClick={clearScan}>
                  {t('rooms.server.import.replace')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="room-server-pick"
                disabled={needsLegal || picking}
                onClick={() => void pickImport()}
              >
                <Icon name="upload" size={18} />
                {picking ? t('rooms.server.import.scanning') : t('rooms.server.import.pick')}
              </button>
            )}

            {scan && selectedCandidate && (
              <>
                <label className="room-server-field">
                  <span className="room-server-label">{t('rooms.server.import.candidate')}</span>
                  <Select
                    value={selectedCandidate.id}
                    options={scan.candidates.map((c) => ({ value: c.id, label: c.label }))}
                    onChange={(id) => {
                      setCandidateId(id);
                      const c = scan.candidates.find((x) => x.id === id);
                      if (c?.javaMajor) setJavaMajor(c.javaMajor);
                    }}
                  />
                </label>

                {!selectedCandidate.javaMajor && (
                  <label className="room-server-field">
                    <span className="room-server-label">{t('rooms.server.import.java')}</span>
                    <Select
                      value={String(javaMajor)}
                      options={IMPORT_JAVA_MAJORS.map((j) => ({
                        value: String(j),
                        label: t('rooms.server.import.javaOption').replace('{n}', String(j)),
                      }))}
                      onChange={(v) => setJavaMajor(Number(v))}
                    />
                    <p className="server-config-help">{t('rooms.server.import.javaHelp')}</p>
                  </label>
                )}
              </>
            )}
          </div>
        )}

        <label className="room-server-field">
          <span className="room-server-label">{t('rooms.server.name')}</span>
          <input
            type="text"
            value={name}
            maxLength={60}
            placeholder={t('rooms.server.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {/*
          Settings that are annoying to change later, asked once, here.
          Everything written into the config file is seeded from these — which is
          what the install plan always intended and never received, so the first
          boot used defaults and the user's next act was to stop the server they had
          just started. Only shown for the catalog path: an imported tree brings its
          own config, and overwriting it would reset a world someone has been
          running for a year.
        */}
        {mode === 'catalog' && setupSchema.length > 0 && (
          <div className="room-server-setup">
            <span className="room-server-setup-title">{t('rooms.server.setup')}</span>
            <div className="room-server-row">
              {setupSchema.map((field) => (
                <ServerConfigField
                  key={field.key}
                  field={field}
                  value={setup[field.key] ?? ''}
                  idPrefix="new-server"
                  onChange={(v) => setSetup((prev) => ({ ...prev, [field.key]: v }))}
                />
              ))}
            </div>
            {/* The port is not a suggestion the user has to verify — the core bound
                a socket to check it. Saying so stops it looking like a guess. */}
            <p className="room-server-hint">{t('rooms.server.setupPortHint')}</p>
          </div>
        )}

        {/*
          The licence gate. It is shown BEFORE anything downloads and is never
          pre-ticked: accepting a publisher's terms on the user's behalf is not
          something an installer gets to do quietly.
        */}
        {needsLegal && gate && (
          <div className="room-server-legal">
            <span className="room-server-legal-title">
              <Icon name="alert-triangle" size={12} />
              {t('rooms.server.legalTitle')}
            </span>
            <p>{t('rooms.server.legalBody')}</p>
            <p className="room-server-legal-name">{t(gate.labelKey as never)}</p>
            <div className="room-server-legal-actions">
              <button
                type="button"
                className="room-server-btn"
                onClick={() => void api.acceptLegal(moduleId).then(() => setGate({ ...gate, accepted: true }))}
              >
                <Icon name="check" size={12} />
                {t('rooms.server.legalAccept')}
              </button>
              <a href={gate.url} target="_blank" rel="noreferrer noopener" className="room-server-link">
                {t('rooms.server.legalRead')}
              </a>
            </div>
          </div>
        )}

        {error && (
          <div className="room-server-failure" role="alert">
            <Icon name="alert-triangle" size={14} />
            <span className="room-server-failure-body">{error}</span>
          </div>
        )}
      </div>

      <div className="room-server-create-foot">
        <button
          type="button"
          className="room-server-primary"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {submitting ? t('rooms.server.creating') : <><Icon name="download" size={13} />{t('rooms.server.createAction')}</>}
        </button>
      </div>
    </div>
  );
};

export type { ConfigField, ConsoleLine };
