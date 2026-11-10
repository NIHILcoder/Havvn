/**
 * Havvn Main App Component
 */

import React, { useState, useEffect, useRef, useCallback, Suspense, lazy } from 'react';
import { HostToaster } from './utils/hostToast';
import { TitleBar, PageId, FilterMode, RoomPresence, VoiceCallInfo, OnlinePerson } from './layout';
import { CompletionPending, RoomSummary, RoomState } from '../shared/types';
// Downloads is the default route — keep it eager. The rest are code-split into
// their own chunks so the initial bundle is smaller and the app (and the startup
// splash) reaches interactive sooner.
import DownloadsPage from './pages/DownloadsPage';
import { DownloadUndoNotice } from './components/DownloadUndoNotice';
import { playNotificationSound } from './utils/notification-sound';
const CreateTorrentPage = lazy(() => import('./pages/CreateTorrentPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const SearchPage = lazy(() => import('./pages/SearchPage'));
const RSSPage = lazy(() => import('./pages/RSSPage'));
const RoomsPage = lazy(() => import('./pages/RoomsPage'));
const SwarmPage = lazy(() => import('./pages/SwarmPage'));
const WatchHistoryPage = lazy(() => import('./pages/WatchHistoryPage'));
import { formatBytes } from './utils/format-helpers';
import { useCommandShortcuts } from './commands/useCommandShortcuts';
import { createAppCommands, type CommandContext, type NavigationTarget } from './commands/appCommands';
import { createNavigationCommands } from './commands/navigationCommands';
import { executeCommand } from './commands/registry';
import { useHostToast } from './utils/hostToast';
// Small shared styles are available before a detached editor copies the head.
import './components/CommandPalette.css';
const CommandPalette = lazy(() => import('./components/CommandPalette'));
const EventCenter = lazy(() => import('./components/EventCenter'));
import { useAppEventSummary } from './state/app-events';
import { downloadViews } from './utils/download-views';
import { restoreThemePrefs } from './utils/theme-prefs';
import { bootApplyActiveTheme } from './utils/theme-library';
import { bootAppearance } from './utils/appearance';
import { bootResourceEffects } from './utils/resource-effects';
import { I18nProvider, useTranslation } from './utils/i18nContext';
import { DeviceConsentHost } from './components/DeviceConsentHost';
import { ConfirmProvider, useConfirm } from './components/ConfirmDialog';
import { ThemeEditorProvider, useThemeEditor } from './components/ThemeEditorContext';
// Lazy: the editor + its preview gallery pull in Rooms/Downloads CSS, so keep
// them out of the initial bundle until the dock is actually opened.
const ThemeEditor = lazy(() => import('./components/ThemeEditor'));
import { CompletionCountdown } from './components/CompletionCountdown';
import { Onboarding } from './components/Onboarding';
import { FirstStepsGuide } from './components/FirstStepsGuide';
import { FIRST_STEPS_OPEN, firstSteps, useFirstSteps } from './utils/first-steps';
import { offerFirstSteps } from './state/first-steps-state';
import { dismissSplash, setSplashStage } from './utils/splash';
import { receiveExternalWatch } from './utils/externalWatch';
import { downloadsModel } from './state/downloads';
import { DownloadSidebar, DownloadStatusBar } from './layout/DownloadIndicators';
import { useWorkingProfiles } from './utils/working-profiles';
import { STORAGE_OPEN_PAGE } from '../shared/storage-overview';
import { useDocumentVisible } from './utils/visible-work';
import { pageLeave } from './state/page-leave';


/** Dismissible warning strip above the page content (VPN / bind / disk guards). */
const AlertBanner: React.FC<{
  onDismiss: () => void;
  dismissLabel: string;
  children: React.ReactNode;
}> = ({ onDismiss, dismissLabel, children }) => (
  <div className="vpn-alert-banner" role="alert">
    <span className="vpn-alert-icon">⚠</span>
    <div className="vpn-alert-text">{children}</div>
    <button className="vpn-alert-close" onClick={onDismiss} aria-label={dismissLabel}>×</button>
  </div>
);

const AppContent: React.FC = () => {
  const { panels } = useWorkingProfiles();
  const [settingsRecovery, setSettingsRecovery] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      const request = window.api.getSettingsTransferStatus?.();
      void request?.then(status => { if (alive && status) setSettingsRecovery(status.recoveryNeeded); }).catch(() => {});
    };
    refresh(); window.addEventListener('havvn:settings-transfer', refresh);
    return () => { alive = false; window.removeEventListener('havvn:settings-transfer', refresh); };
  }, []);
  useEffect(bootAppearance, []);
  useEffect(bootResourceEffects, []);
  useEffect(() => receiveExternalWatch(window.api.externalPlayer), []);
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  // The theme editor is a top-level dock (not a Settings modal) so it stays open
  // beside every page — click Rooms/Downloads and watch them recolor live.
  const { open: themeEditorOpen, closeEditor, initialTab: themeEditorTab } = useThemeEditor();
  // Start page honors the Settings → Interface preference (downloads is the default).
  const [currentPage, setCurrentPageNow] = useState<PageId>(() => {
    try { return localStorage.getItem('startPage') === 'rooms' ? 'rooms' : 'downloads'; }
    catch { return 'downloads'; }
  });
  const pageRef = useRef(currentPage); pageRef.current = currentPage;
  const setCurrentPage = useCallback((page: PageId) => {
    if (pageRef.current !== page) void pageLeave.run(() => setCurrentPageNow(page));
  }, []);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  // Torrent/magnet handed to us by the OS — passed to DownloadsPage to open the add dialog
  const [openTorrentUri, setOpenTorrentUri] = useState<string | null>(null);
  // A havvn://join/<invite> deep link — routes to Rooms and prefills the Join dialog.
  const [pendingJoinInvite, setPendingJoinInvite] = useState<string | null>(null);
  // VPN kill-switch warning banner (set when the guard auto-pauses on VPN drop)
  const [vpnAlert, setVpnAlert] = useState<{ paused: number; rooms?: boolean; publicIP?: string } | null>(null);
  // Engine VPN-bind banner (bound address vanished — sockets dead until VPN returns)
  const [vpnBindAlert, setVpnBindAlert] = useState(false);
  // In-flight on-completion countdown (sleep/shutdown/quit) — cancellable modal
  const [completionPending, setCompletionPending] = useState<CompletionPending | null>(null);
  // Disk-space guard warning banner
  const [diskAlert, setDiskAlert] = useState<{ paused: number; freeBytes: number; thresholdBytes: number } | null>(null);
  // The most-alive room right now — feeds the status-bar presence bridge
  const [roomPresence, setRoomPresence] = useState<RoomPresence | null>(null);
  // The active voice call (at most one room can be in voice) — mirrored from
  // room pushes so the StatusBar can show call controls on every page.
  const [voiceCall, setVoiceCall] = useState<VoiceCallInfo | null>(null);
  // roomId → timestamp of the last watch-together sync with playing=true
  const lastPlayingSync = useRef<Map<string, number>>(new Map());
  // Rooms context for the sidebar's rooms pillar
  const [roomSummaries, setRoomSummaries] = useState<RoomSummary[]>([]);
  const [onlinePeople, setOnlinePeople] = useState<OnlinePerson[]>([]);
  // A room the user asked to open (rail click / status-bar Join) — consumed by RoomsPage
  const [roomFocusId, setRoomFocusId] = useState<string | null>(null);
  // The room currently open on the rooms page — highlights the rail entry
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  // Last full RoomState per room (pushed via onRoomUpdate) — member-level truth
  const roomStates = useRef<Map<string, RoomState>>(new Map());
  // First-run onboarding: shown once, only when the app looks fresh
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showFirstGuide, setShowFirstGuide] = useState(false);
  const firstStepsSnapshot = useFirstSteps();
  const startupIntent = useRef(false);
  const onboardingChecked = useRef(false);

  // Apply theme on mount
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'system';
    const applyTheme = (theme: string) => {
      if (theme === 'system') {
        const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', systemPrefersDark ? 'dark' : 'light');
      } else {
        document.documentElement.setAttribute('data-theme', theme);
      }
    };
    applyTheme(savedTheme);

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (localStorage.getItem('theme') === 'system') {
        applyTheme('system');
        // In system mode a flip changes the active custom theme's variant too.
        bootApplyActiveTheme();
        restoreThemePrefs();
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // Boot-apply persisted interface prefs (UI scale / reduced motion / density).
  // The Interface settings section owns changing them; this only restores them.
  useEffect(() => {
    try {
      const scale = parseInt(localStorage.getItem('uiScale') ?? '', 10);
      if (Number.isFinite(scale) && scale > 0 && scale !== 100) {
        // webFrame zoom (via preload) — scales the viewport too, so the
        // 100vh/100vw shell keeps filling the window at any factor.
        window.api.setZoomFactor?.(scale / 100);
      }
      if (localStorage.getItem('reduceMotion') === '1') {
        document.documentElement.dataset.reduceMotion = 'true';
      }
      if (localStorage.getItem('density') === 'compact') {
        document.documentElement.dataset.density = 'compact';
      }
      // Active custom theme (if any) first, then the accent/font overlays on
      // top — all inline :root props that beat the [data-theme] blocks, restored
      // the same way as the prefs above.
      bootApplyActiveTheme();
      restoreThemePrefs();
    } catch { /* prefs are cosmetic — never block boot */ }
  }, []);

  // One window-wide subscription and coalesced metadata refresh.
  useEffect(() => {
    const openStoragePage = (event: Event) => {
      const page = (event as CustomEvent).detail;
      if (page === 'downloads' || page === 'rooms') setCurrentPage(page);
    };
    window.addEventListener(STORAGE_OPEN_PAGE, openStoragePage);
    return () => window.removeEventListener(STORAGE_OPEN_PAGE, openStoragePage);
  }, []);
  const documentVisible = useDocumentVisible();
  useEffect(() => {
    downloadsModel.setActivity(documentVisible, currentPage === 'downloads' || panels.statusBar);
  }, [documentVisible, currentPage, panels.statusBar]);
  useEffect(() => {
    setSplashStage('downloads');
    const release = downloadsModel.retain();
    void downloadsModel.refresh().finally(dismissSplash).catch(() => {});
    return release;
  }, []);

  // First-run onboarding: only when the user has never seen it AND the app
  // looks fresh (no downloads yet) — existing users upgrading must never get
  // it. The ref guards against a double show (StrictMode re-running effects).
  useEffect(() => {
    if (onboardingChecked.current) return;
    onboardingChecked.current = true;
    void offerFirstSteps(firstSteps, async () => {
      const [, rooms] = await Promise.all([downloadsModel.refresh(), window.api.rooms.list()]);
      return { downloads: downloadsModel.store.getState().downloads, rooms };
    }).then(offer => { if (offer && !startupIntent.current) setShowOnboarding(true); });
  }, []);

  // Listen for opening torrent files/magnet links from OS.
  // Don't add silently — switch to Downloads and hand the URI to DownloadsPage,
  // which opens the same confirmation/file-picker dialog as a manual add.
  useEffect(() => {
    const unsubscribe = window.api.onOpenTorrent((torrentUri) => {
      startupIntent.current = true; setShowOnboarding(false);
      void pageLeave.run(() => { setCurrentPageNow('downloads'); setOpenTorrentUri(torrentUri); });
    });
    // A havvn://join/<invite> deep link → Rooms, prefilled Join dialog (RoomsPage
    // validates + confirms; a deep link is never auto-joined).
    const unsubscribeJoin = window.api.onJoinInvite((invite) => {
      startupIntent.current = true; setShowOnboarding(false);
      void pageLeave.run(() => { setCurrentPageNow('rooms'); setPendingJoinInvite(invite); });
    });

    // Tell main our listeners are attached so it can flush any URI/invite buffered
    // during a cold start (fixes "first double-click only opens the app").
    window.api.notifyReady();

    return () => { unsubscribe(); unsubscribeJoin(); };
  }, []);

  // VPN kill-switch: show a warning banner when the guard auto-pauses torrents
  useEffect(() => {
    const offDropped = window.api.onVpnDropped((info) => setVpnAlert(info));
    const offRestored = window.api.onVpnRestored(() => setVpnAlert(null));
    return () => { offDropped(); offRestored(); };
  }, []);

  // Engine VPN-bind: 'lost' raises the banner; a re-bind or the same address
  // returning clears it (the guard drives the actual engine restart).
  useEffect(() => {
    const off = window.api.onVpnBindStatus((info) => {
      setVpnBindAlert(info.kind === 'lost');
    });
    return () => off();
  }, []);

  // On-completion countdown: live push from main, plus a mount-time pull so a
  // window opened from the notification click finds the in-flight countdown.
  // A push that lands before the pull resolves is fresher — don't clobber it.
  useEffect(() => {
    let pushed = false;
    const off = window.api.onCompletionActionPending((p) => {
      pushed = true;
      setCompletionPending(p);
    });
    void window.api.getCompletionAction()
      .then((s) => { if (!pushed) setCompletionPending(s.pending); })
      .catch(() => { /* older main without the handler */ });
    return () => off();
  }, []);

  // Startup VPN advisory: main sends this when no VPN is detected at boot.
  // Shown as a themed dialog at most once per session; "Don't show again"
  // persists the opt-out in main's config store.
  const vpnWarningShown = useRef(false);
  useEffect(() => {
    const off = window.api.onVpnWarning((info) => {
      if (vpnWarningShown.current) return;
      vpnWarningShown.current = true;
      // "Don't show again" is the CONFIRM action on purpose: confirm() can't
      // tell the cancel button from Escape/X, and an accidental Escape must
      // never permanently silence a security warning — only an explicit click
      // on the primary button persists the opt-out.
      void confirm({
        title: t('app.vpnWarn.title'),
        message: info.publicIP
          ? `${t('app.vpnWarn.body')} ${t('app.vpnWarn.yourIp')} ${info.publicIP}`
          : t('app.vpnWarn.body'),
        confirmLabel: t('app.vpnWarn.dontShowAgain'),
        cancelLabel: t('common.ok'),
        icon: 'alert-triangle',
      }).then((dontShowAgain) => {
        if (dontShowAgain) window.api.vpnWarningDismissed();
      });
    });
    return () => off();
  }, [confirm, t]);

  // Disk-space guard: warning banner when free space is low
  useEffect(() => {
    const offLow = window.api.onDiskLow((info) => setDiskAlert(info));
    const offRecovered = window.api.onDiskRecovered(() => setDiskAlert(null));
    return () => { offLow(); offRecovered(); };
  }, []);

  // Room presence for the status-bar bridge: pick the most-alive room —
  // "watching together" (a playing sync in the last 90s) beats plain online
  // count, and your own membership doesn't count as presence. Recomputed on a
  // slow poll plus every room push, so it stays fresh without busy-polling.
  useEffect(() => {
    let cancelled = false;
    const compute = async () => {
      try {
        const rooms = await window.api.rooms.list();
        if (cancelled) return;
        setRoomSummaries(rooms);
        // Drop cached member states for rooms we're no longer in, so stale
        // "online now" entries can't navigate to a dead room id.
        const liveIds = new Set(rooms.map((r) => r.roomId));
        let pruned = false;
        for (const k of Array.from(roomStates.current.keys())) {
          if (!liveIds.has(k)) { roomStates.current.delete(k); pruned = true; }
        }
        if (pruned) { rebuildPeople(); rebuildVoiceCall(); }
        const now = Date.now();
        let best: RoomPresence | null = null;
        let bestScore = 0;
        for (const r of rooms) {
          const othersOnline = Math.max(0, r.onlineCount - 1);
          const watching = (lastPlayingSync.current.get(r.roomId) ?? 0) > now - 90_000;
          const score = (watching ? 1000 : 0) + othersOnline;
          if (score > bestScore) {
            bestScore = score;
            best = { roomId: r.roomId, name: r.name, othersOnline, watching };
          }
        }
        setRoomPresence(best);
      } catch { /* rooms subsystem unavailable — keep the bar clean */ }
    };
    // Friends online across all rooms (member-level data only arrives in
    // onRoomUpdate pushes — the summary has just a count). Deduped by member.
    const rebuildPeople = () => {
      const seen = new Set<string>();
      const out: OnlinePerson[] = [];
      for (const s of roomStates.current.values()) {
        for (const m of s.members) {
          if (!m.online || m.isSelf || seen.has(m.memberId)) continue;
          seen.add(m.memberId);
          out.push({ memberId: m.memberId, name: m.name, avatarSeed: m.avatarSeed, roomName: s.name, roomId: s.roomId });
        }
      }
      setOnlinePeople(out.slice(0, 6));
    };
    // Mirror the (single) in-voice room's call state for the StatusBar.
    const rebuildVoiceCall = () => {
      let call: VoiceCallInfo | null = null;
      for (const s of roomStates.current.values()) {
        if (s.voice?.inVoice) {
          call = { roomId: s.roomId, name: s.name, muted: s.voice.muted, deafened: s.voice.deafened };
          break;
        }
      }
      setVoiceCall((prev) => {
        if (!call) return prev === null ? prev : null;
        if (prev && prev.roomId === call.roomId && prev.name === call.name && prev.muted === call.muted && prev.deafened === call.deafened) return prev;
        return call;
      });
    };
    void compute();
    const interval = setInterval(compute, 10_000);
    const offUpdate = window.api.onRoomUpdate((state) => {
      roomStates.current.set(state.roomId, state);
      rebuildPeople();
      rebuildVoiceCall();
      void compute();
    });
    const offSync = window.api.onRoomSync((msg) => {
      if (msg.playing) lastPlayingSync.current.set(msg.roomId, Date.now());
      void compute();
    });
    return () => { cancelled = true; clearInterval(interval); offUpdate(); offSync(); };
  }, []);

  // Notification suppression follows the open room; the visible chat owns read receipts.
  useEffect(() => {
    const open = currentPage === 'rooms' ? activeRoomId : null;
    window.api.rooms.setActiveRoom(open).catch(() => { /* ignore */ });
    if (open) window.api.rooms.list().then(setRoomSummaries).catch(() => { /* ignore */ });
  }, [activeRoomId, currentPage]);

  // A room notification was clicked — open that room.
  useEffect(() => {
    const off = window.api.onNotificationSound?.(() => { void playNotificationSound(); });
    return typeof off === 'function' ? off : undefined;
  }, []);
  useEffect(() => window.api.onRoomOpen((roomId) => { if (roomId) openRoom(roomId); }), []);

  const toast = useHostToast();
  const eventSummary = useAppEventSummary();
  const [commandHost, setCommandHost] = useState<Window | null>(null);
  const [downloadTarget, setDownloadTarget] = useState<{ id: string; requestId: number } | null>(null);
  const [settingTarget, setSettingTarget] = useState<{ entry: Extract<NavigationTarget, { kind: 'setting' }>['entry']; requestId: number } | null>(null);
  const [addTorrentRequest, setAddTorrentRequest] = useState(0);
  const [streamRequest, setStreamRequest] = useState<{ id: string; requestId: number } | null>(null);
  const [roomTaskRequest, setRoomTaskRequest] = useState<(Extract<NavigationTarget, { kind: 'room-task' }> & { requestId: number }) | null>(null);
  const [navigationTarget, setNavigationTarget] = useState<NavigationTarget | null>(null);
  const navigationSequence = useRef(0);
  useEffect(() => {
    const open = () => { firstSteps.markSeen(); setShowOnboarding(true); };
    window.addEventListener(FIRST_STEPS_OPEN, open);
    return () => window.removeEventListener(FIRST_STEPS_OPEN, open);
  }, []);
  useEffect(() => {
    if (!navigationTarget || commandHost) return;
    const target = navigationTarget;
    setNavigationTarget(null);
    const applyNavigation = () => {
    const requestId = ++navigationSequence.current;
    // Navigation belongs to the main shell, even when invoked from a detached panel.
    window.focus();
    if (target.kind === 'page') setCurrentPageNow(target.page);
    else if (target.kind === 'first-steps') { firstSteps.markSeen(); setShowOnboarding(true); }
    else if (target.kind === 'watch-download') { setStreamRequest({ id: target.id, requestId }); setCurrentPageNow('downloads'); }
    else if (target.kind === 'room-task') {
      setRoomTaskRequest({ ...target, requestId }); setCurrentPageNow('rooms');
    }
    else if (target.kind === 'download') {
      try { downloadViews.select(null); } catch { /* Opening an object must not depend on writable preferences. */ }
      setFilterMode('all'); setDownloadTarget({ id: target.id, requestId }); setCurrentPageNow('downloads');
    } else if (target.kind === 'setting') {
      setSettingTarget({ entry: target.entry, requestId }); setCurrentPageNow('settings');
    } else if (target.kind === 'room') { setRoomFocusId(target.id); setCurrentPageNow('rooms'); }
    else if (target.kind === 'download-view') {
      try { downloadViews.select(target.id); setCurrentPageNow('downloads'); }
      catch { toast.error(t('views.error.missing')); }
    }
    else { setAddTorrentRequest(requestId); setCurrentPageNow('downloads'); }
    };
    if (target.kind === 'first-steps' || target.kind === 'setting' && pageRef.current === 'settings' || target.kind === 'page' && target.page === pageRef.current) applyNavigation();
    else void pageLeave.run(applyNavigation);
  }, [navigationTarget, commandHost]);
  const commandContext = useRef<CommandContext>(null!);
  commandContext.current = { t, api: window.api, navigate: setNavigationTarget,
    getDownloads: () => downloadsModel.store.getState().downloads,
    getRooms: () => roomSummaries, getVoice: () => voiceCall,
    getViews: () => downloadViews.getSnapshot().catalog.views };
  const getCommandContext = useCallback(() => commandContext.current, []);
  const getNavigationCommands = useCallback(() => createNavigationCommands(getCommandContext()), [getCommandContext]);
  const closeCommands = useCallback(() => setCommandHost(null), []);
  useCommandShortcuts(setCommandHost, id => {
    void executeCommand(id, () => createAppCommands(getCommandContext()), t('commands.missing'))
      .catch(cause => toast.error(cause instanceof Error ? cause.message : t('commands.failed')));
  });

  // Open the rooms page focused on a specific room (rail click / status-bar Join)
  const openRoom = (roomId: string) => {
    const open = () => { setRoomFocusId(roomId); setCurrentPageNow('rooms'); };
    void pageLeave.run(open);
  };

  const renderPage = () => {
    switch (currentPage) {
      case 'events':
        return <EventCenter onNavigate={target => setNavigationTarget(target.kind === 'settings' ? { kind: 'page', page: 'settings' } : target)} />;
      case 'create-torrent':
        return <CreateTorrentPage onNavigateBack={() => setCurrentPage('downloads')} />;
      case 'downloads':
        return <DownloadsPage onOpenEvents={() => setNavigationTarget({ kind: 'page', page: 'events' })} onOpenSetting={entry => setNavigationTarget({ kind: 'setting', entry })} streamRequest={streamRequest} onStreamHandled={() => setStreamRequest(null)} focusRequest={downloadTarget} onFocusHandled={() => setDownloadTarget(null)} addTorrentRequest={addTorrentRequest} onAddTorrentHandled={() => setAddTorrentRequest(0)} filterMode={filterMode} onFilterChange={setFilterMode} openTorrentUri={openTorrentUri} onOpenHandled={() => setOpenTorrentUri(null)} />;
      case 'watch-history':
        return <WatchHistoryPage />;
      case 'settings':
        return <SettingsPage getNavigationCommands={getNavigationCommands} focusRequest={settingTarget} onFocusHandled={() => setSettingTarget(null)} />;
      case 'search':
        return <SearchPage />;
      case 'rss':
        return <RSSPage />;
      case 'rooms':
        return (
          <RoomsPage
            taskRequest={roomTaskRequest} onTaskHandled={() => setRoomTaskRequest(null)}
            focusRoomId={roomFocusId}
            onFocusHandled={() => setRoomFocusId(null)}
            onRoomSelected={setActiveRoomId}
            pendingJoinInvite={pendingJoinInvite}
            onJoinInviteHandled={() => setPendingJoinInvite(null)}
          />
        );
      case 'swarm':
        return <SwarmPage />;
      default:
        return <DownloadsPage onOpenEvents={() => setNavigationTarget({ kind: 'page', page: 'events' })} onOpenSetting={entry => setNavigationTarget({ kind: 'setting', entry })} streamRequest={streamRequest} onStreamHandled={() => setStreamRequest(null)} focusRequest={downloadTarget} onFocusHandled={() => setDownloadTarget(null)} addTorrentRequest={addTorrentRequest} onAddTorrentHandled={() => setAddTorrentRequest(0)} filterMode={filterMode} onFilterChange={setFilterMode} openTorrentUri={openTorrentUri} onOpenHandled={() => setOpenTorrentUri(null)} />;
    }
  };

  return (
    <>
      {/* The app-wide default toaster. No toasterId and no portal target, so it
          renders exactly where it always did and receives exactly the toasts a
          bare `toast()` dispatches; a torn-off dock window mounts its own with
          its frame name as the id (utils/hostToast.tsx). */}
      <HostToaster />
      <DownloadUndoNotice />
      <div className="app-shell">
        <TitleBar onOpenCommands={() => setCommandHost(window)} onOpenEvents={() => setCurrentPage('events')} activeProblems={eventSummary.active} />
        <div className="app-container">
        {panels.sidebar && <DownloadSidebar
          getCommands={getNavigationCommands}
          currentPage={currentPage}
          onNavigate={setCurrentPage}
          filterMode={filterMode}
          onFilterChange={filter => { try { downloadViews.select(null); } catch { /* Quick filters remain available. */ } setFilterMode(filter); }}
          onOpenView={id => setNavigationTarget({ kind: 'download-view', id })}
          rooms={roomSummaries}
          onlinePeople={onlinePeople}
          onOpenRoom={openRoom}
          activeRoomId={currentPage === 'rooms' ? activeRoomId : null}
        />}

        <main className="main-content">
          {settingsRecovery && <AlertBanner onDismiss={() => setSettingsRecovery(false)} dismissLabel={t('app.banner.dismiss')}>
            {t('settings.transfer.recoveryDesc')}{' '}
            <button type="button" onClick={() => setCurrentPage('settings')}>{t('settings.transfer.openSettings')}</button>
          </AlertBanner>}
          {vpnAlert && (
            <AlertBanner onDismiss={() => setVpnAlert(null)} dismissLabel={t('app.banner.dismiss')}>
              <strong>{t('app.banner.vpnLostTitle')}</strong>{' '}
              {vpnAlert.paused > 0
                ? `${vpnAlert.paused} ${t('app.banner.torrentsPausedIp')}`
                : t('app.banner.vpnDown')}
              {vpnAlert.rooms ? ` ${t('app.banner.roomsPaused')}` : ''}
              {vpnAlert.publicIP ? ` ${t('app.banner.currentIp')} ${vpnAlert.publicIP}.` : ''}
              {' '}{t('app.banner.vpnReconnect')}
            </AlertBanner>
          )}
          {vpnBindAlert && (
            <AlertBanner onDismiss={() => setVpnBindAlert(false)} dismissLabel={t('app.banner.dismiss')}>
              {t('privacy.vpnBind.lostBanner')}
            </AlertBanner>
          )}
          {completionPending && (
            <CompletionCountdown
              pending={completionPending}
              onCancel={() => {
                setCompletionPending(null);
                void window.api.setCompletionAction('none');
              }}
            />
          )}
          {diskAlert && (
            <AlertBanner onDismiss={() => setDiskAlert(null)} dismissLabel={t('app.banner.dismiss')}>
              <strong>{t('app.banner.diskLowTitle')}</strong>{' '}
              {`${t('app.banner.diskFree')} ${formatBytes(diskAlert.freeBytes)} / ${formatBytes(diskAlert.thresholdBytes)}.`}
              {diskAlert.paused > 0
                ? ` ${diskAlert.paused} ${t('app.banner.torrentsPausedShort')}`
                : ''}
              {' '}{t('app.banner.diskResume')}
            </AlertBanner>
          )}
          {showFirstGuide && <FirstStepsGuide key={firstStepsSnapshot.data.active} rooms={roomSummaries} navigate={setNavigationTarget}
            onChoose={() => setShowOnboarding(true)} onClose={() => setShowFirstGuide(false)} />}
          <Suspense fallback={<div className="page-loading" />}>
            {renderPage()}
          </Suspense>

          {showOnboarding && (
            <Onboarding
              rooms={roomSummaries}
              onClose={() => setShowOnboarding(false)}
              onSelect={route => { firstSteps.begin(route); setShowOnboarding(false); setShowFirstGuide(true); }}
            />
          )}

          {panels.statusBar && <DownloadStatusBar
            roomPresence={roomPresence}
            roomCount={roomSummaries.length}
            onJoinRoom={() => (roomPresence ? openRoom(roomPresence.roomId) : setCurrentPage('rooms'))}
            voiceCall={voiceCall}
            onOpenVoiceRoom={() => { if (voiceCall) openRoom(voiceCall.roomId); }}
            onVoiceMute={() => { if (voiceCall) void window.api.rooms.voice.mute(voiceCall.roomId, !voiceCall.muted).catch(() => { /* ignore */ }); }}
            onVoiceDeafen={() => { if (voiceCall) void window.api.rooms.voice.deafen(voiceCall.roomId, !voiceCall.deafened).catch(() => { /* ignore */ }); }}
            onVoiceLeave={() => { if (voiceCall) void window.api.rooms.voice.leave(voiceCall.roomId).catch(() => { /* ignore */ }); }}
          />}
        </main>
        </div>
      </div>

      {commandHost && <Suspense fallback={null}><CommandPalette host={commandHost} getContext={getCommandContext} onClose={closeCommands} /></Suspense>}

      {/* Dock the theme editor at the shell level (outside .app-container) so its
          fixed panel composes with the container's push-layout reservation, and
          it survives page navigation while open. */}
      {themeEditorOpen && (
        <Suspense fallback={null}>
          <ThemeEditor onClose={closeEditor} initialTab={themeEditorTab} />
        </Suspense>
      )}
    </>
  );
};

const App: React.FC = () => {
  return (
    <I18nProvider>
      <ConfirmProvider>
        <ThemeEditorProvider>
          <AppContent />
          <DeviceConsentHost />
        </ThemeEditorProvider>
      </ConfirmProvider>
    </I18nProvider>
  );
};

export default App;
