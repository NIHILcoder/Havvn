/**
 * Havvn Main App Component
 */

import React, { useState, useEffect, useMemo, useRef, Suspense, lazy } from 'react';
import { Toaster } from 'react-hot-toast';
import { Sidebar, StatusBar, PageId, FilterMode, RoomPresence, OnlinePerson } from './layout';
import { DownloadStats, Download, RoomSummary, RoomState } from '../shared/types';
// Downloads is the default route — keep it eager. The rest are code-split into
// their own chunks so the initial bundle is smaller and the app (and the startup
// splash) reaches interactive sooner.
import DownloadsPage from './pages/DownloadsPage';
const CreateTorrentPage = lazy(() => import('./pages/CreateTorrentPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const SearchPage = lazy(() => import('./pages/SearchPage'));
const RSSPage = lazy(() => import('./pages/RSSPage'));
const RoomsPage = lazy(() => import('./pages/RoomsPage'));
const SwarmPage = lazy(() => import('./pages/SwarmPage'));
import { formatBytes } from './utils/format-helpers';
import { loadHotkeys, subscribeHotkeys } from './utils/hotkeys';
import { I18nProvider, useTranslation } from './utils/i18nContext';
import { ConfirmProvider, useConfirm } from './components/ConfirmDialog';
import { Onboarding } from './components/Onboarding';
import { dismissSplash } from './utils/splash';


const AppContent: React.FC = () => {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  // Start page honors the Settings → Interface preference (downloads is the default).
  const [currentPage, setCurrentPage] = useState<PageId>(() => {
    try { return localStorage.getItem('startPage') === 'rooms' ? 'rooms' : 'downloads'; }
    catch { return 'downloads'; }
  });
  const [stats, setStats] = useState<DownloadStats[]>([]);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  // Torrent/magnet handed to us by the OS — passed to DownloadsPage to open the add dialog
  const [openTorrentUri, setOpenTorrentUri] = useState<string | null>(null);
  // VPN kill-switch warning banner (set when the guard auto-pauses on VPN drop)
  const [vpnAlert, setVpnAlert] = useState<{ paused: number; publicIP?: string } | null>(null);
  // Disk-space guard warning banner
  const [diskAlert, setDiskAlert] = useState<{ paused: number; freeBytes: number; thresholdBytes: number } | null>(null);
  // The most-alive room right now — feeds the status-bar presence bridge
  const [roomPresence, setRoomPresence] = useState<RoomPresence | null>(null);
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
    } catch { /* prefs are cosmetic — never block boot */ }
  }, []);

  // Load downloads for counts
  useEffect(() => {
    const loadDownloads = async () => {
      try {
        const list = await window.api.getDownloads();
        setDownloads(list.filter(d => d.status !== 'removed'));
      } catch (error) {
        console.error('Failed to load downloads:', error);
      } finally {
        // Initial data is in (or failed) — fade out the startup splash. Idempotent
        // and runs even on error, so the splash can never trap the user.
        dismissSplash();
      }
    };
    loadDownloads();

    // Refresh periodically
    const interval = setInterval(loadDownloads, 5000);
    return () => clearInterval(interval);
  }, []);

  // First-run onboarding: only when the user has never seen it AND the app
  // looks fresh (no downloads yet) — existing users upgrading must never get
  // it. The ref guards against a double show (StrictMode re-running effects).
  useEffect(() => {
    if (onboardingChecked.current) return;
    onboardingChecked.current = true;
    try {
      if (localStorage.getItem('onboarded') === '1') return;
    } catch { return; /* storage unavailable — can't persist dismissal, don't nag */ }
    (async () => {
      try {
        const list = await window.api.getDownloads();
        if (Array.isArray(list) && list.length === 0) setShowOnboarding(true);
      } catch { /* engine unavailable — can't tell it's fresh, stay quiet */ }
    })();
  }, []);

  // Subscribe to stats for status bar
  useEffect(() => {
    const unsubscribe = window.api.onDownloadStats((newStats) => {
      setStats(newStats);

      // Update download statuses from stats — but ONLY when a status actually
      // flips. Live progress/speed are read from the stats Map by the rows, so
      // rebuilding every download object every tick just churns GC and defeats
      // memoization. Returning the same array reference makes React bail out.
      setDownloads(prev => {
        let changed = false;
        const next = prev.map(d => {
          const stat = newStats.find(s => s.id === d.id);
          if (stat && stat.status !== d.status) { changed = true; return { ...d, status: stat.status }; }
          return d;
        });
        return changed ? next : prev;
      });
    });
    return () => unsubscribe();
  }, []);

  // Listen for opening torrent files/magnet links from OS.
  // Don't add silently — switch to Downloads and hand the URI to DownloadsPage,
  // which opens the same confirmation/file-picker dialog as a manual add.
  useEffect(() => {
    const unsubscribe = window.api.onOpenTorrent((torrentUri) => {
      setCurrentPage('downloads');
      setOpenTorrentUri(torrentUri);
    });

    // Tell main our listener is attached so it can flush any URI buffered
    // during a cold start (fixes "first double-click only opens the app").
    window.api.notifyReady();

    return () => unsubscribe();
  }, []);

  // VPN kill-switch: show a warning banner when the guard auto-pauses torrents
  useEffect(() => {
    const offDropped = window.api.onVpnDropped((info) => setVpnAlert(info));
    const offRestored = window.api.onVpnRestored(() => setVpnAlert(null));
    return () => { offDropped(); offRestored(); };
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
        if (pruned) rebuildPeople();
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
    void compute();
    const interval = setInterval(compute, 10_000);
    const offUpdate = window.api.onRoomUpdate((state) => {
      roomStates.current.set(state.roomId, state);
      rebuildPeople();
      void compute();
    });
    const offSync = window.api.onRoomSync((msg) => {
      if (msg.playing) lastPlayingSync.current.set(msg.roomId, Date.now());
      void compute();
    });
    return () => { cancelled = true; clearInterval(interval); offUpdate(); offSync(); };
  }, []);

  // Global shortcuts — user-editable in Settings → Hotkeys, layout-independent
  // via event.code. Bindings live in utils/hotkeys.ts; edits apply live.
  useEffect(() => {
    const hotkeysRef = { current: loadHotkeys() };
    const unsubscribe = subscribeHotkeys(() => {
      hotkeysRef.current = loadHotkeys();
    });

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Don't trigger hotkeys when typing in input fields
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      // Build current key combination using event.code for layout independence
      const keys: string[] = [];
      if (e.ctrlKey) keys.push('Ctrl');
      if (e.shiftKey) keys.push('Shift');
      if (e.altKey) keys.push('Alt');
      if (e.metaKey) keys.push('Meta');

      // Use event.code for physical key position
      const code = e.code;
      if (code && !['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(code)) {
        keys.push(code);
      }

      // Match hotkey
      const keyString = keys.join('+');
      for (const hotkey of hotkeysRef.current) {
        if (hotkey.keys.length === 0 || keyString !== hotkey.keys.join('+')) continue;
        e.preventDefault();

        // Execute action — every id in defaultHotkeys must be handled here
        switch (hotkey.id) {
          case 'open-downloads':
            setCurrentPage('downloads');
            break;
          case 'open-settings':
            setCurrentPage('settings');
            break;
          case 'create-torrent':
            setCurrentPage('create-torrent');
            break;
          case 'add-torrent':
            // Navigate to downloads page where add torrent button is
            setCurrentPage('downloads');
            break;
          case 'pause-all':
            void window.api.pauseAll().catch(() => { /* engine unavailable */ });
            break;
          case 'resume-all':
            void window.api.resumeAll().catch(() => { /* engine unavailable */ });
            break;
        }
        break;
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
      unsubscribe();
    };
  }, []);

  // Calculate download counts for sidebar
  const downloadCounts = useMemo(() => ({
    all: downloads.length,
    downloading: downloads.filter(d => ['downloading', 'queued'].includes(d.status)).length,
    completed: downloads.filter(d => ['completed', 'seeding'].includes(d.status)).length,
    paused: downloads.filter(d => d.status === 'paused').length,
    error: downloads.filter(d => d.status === 'error').length,
  }), [downloads]);

  // Open the rooms page focused on a specific room (rail click / status-bar Join)
  const openRoom = (roomId: string) => {
    setRoomFocusId(roomId);
    setCurrentPage('rooms');
  };

  // Calculate aggregate stats
  const activeDownloads = stats.filter(s => s.status === 'downloading').length;
  const totalDownSpeed = stats.reduce((sum, s) => sum + s.downSpeedBps, 0);
  const totalUpSpeed = stats.reduce((sum, s) => sum + s.upSpeedBps, 0);
  const totalPeers = stats.reduce((sum, s) => sum + s.peers, 0);

  const renderPage = () => {
    switch (currentPage) {
      case 'create-torrent':
        return <CreateTorrentPage onNavigateBack={() => setCurrentPage('downloads')} />;
      case 'downloads':
        return <DownloadsPage filterMode={filterMode} onFilterChange={setFilterMode} openTorrentUri={openTorrentUri} onOpenHandled={() => setOpenTorrentUri(null)} />;
      case 'settings':
        return <SettingsPage />;
      case 'search':
        return <SearchPage />;
      case 'rss':
        return <RSSPage />;
      case 'rooms':
        return (
          <RoomsPage
            focusRoomId={roomFocusId}
            onFocusHandled={() => setRoomFocusId(null)}
            onRoomSelected={setActiveRoomId}
          />
        );
      case 'swarm':
        return <SwarmPage />;
      default:
        return <DownloadsPage filterMode={filterMode} onFilterChange={setFilterMode} openTorrentUri={openTorrentUri} onOpenHandled={() => setOpenTorrentUri(null)} />;
    }
  };

  return (
    <>
      <Toaster
        position="bottom-right"
        toastOptions={{
          duration: 4000,
          style: {
            background: 'var(--color-bg-secondary)',
            color: 'var(--color-text-primary)',
            border: '1px solid var(--color-border)',
          },
        }}
      />
      <div className="app-container">
        <Sidebar
          currentPage={currentPage}
          onNavigate={setCurrentPage}
          filterMode={filterMode}
          onFilterChange={setFilterMode}
          downloadCounts={downloadCounts}
          activeDownloads={activeDownloads}
          rooms={roomSummaries}
          onlinePeople={onlinePeople}
          onOpenRoom={openRoom}
          activeRoomId={currentPage === 'rooms' ? activeRoomId : null}
        />

        <main className="main-content">
          {vpnAlert && (
            <div className="vpn-alert-banner" role="alert">
              <span className="vpn-alert-icon">⚠</span>
              <div className="vpn-alert-text">
                <strong>{t('app.banner.vpnLostTitle')}</strong>{' '}
                {vpnAlert.paused > 0
                  ? `${vpnAlert.paused} ${t('app.banner.torrentsPausedIp')}`
                  : t('app.banner.vpnDown')}
                {vpnAlert.publicIP ? ` ${t('app.banner.currentIp')} ${vpnAlert.publicIP}.` : ''}
                {' '}{t('app.banner.vpnReconnect')}
              </div>
              <button className="vpn-alert-close" onClick={() => setVpnAlert(null)} aria-label={t('app.banner.dismiss')}>×</button>
            </div>
          )}
          {diskAlert && (
            <div className="vpn-alert-banner" role="alert">
              <span className="vpn-alert-icon">⚠</span>
              <div className="vpn-alert-text">
                <strong>{t('app.banner.diskLowTitle')}</strong>{' '}
                {`${t('app.banner.diskFree')} ${formatBytes(diskAlert.freeBytes)} / ${formatBytes(diskAlert.thresholdBytes)}.`}
                {diskAlert.paused > 0
                  ? ` ${diskAlert.paused} ${t('app.banner.torrentsPausedShort')}`
                  : ''}
                {' '}{t('app.banner.diskResume')}
              </div>
              <button className="vpn-alert-close" onClick={() => setDiskAlert(null)} aria-label={t('app.banner.dismiss')}>×</button>
            </div>
          )}
          <Suspense fallback={<div className="page-loading" />}>
            {renderPage()}
          </Suspense>

          {showOnboarding && (
            <Onboarding
              onClose={() => setShowOnboarding(false)}
              onCreateRoom={() => { setShowOnboarding(false); setCurrentPage('rooms'); }}
            />
          )}

          <StatusBar
            activeDownloads={activeDownloads}
            totalDownSpeed={totalDownSpeed}
            totalUpSpeed={totalUpSpeed}
            connectedPeers={totalPeers}
            roomPresence={roomPresence}
            onJoinRoom={() => (roomPresence ? openRoom(roomPresence.roomId) : setCurrentPage('rooms'))}
          />
        </main>
      </div>
    </>
  );
};

const App: React.FC = () => {
  return (
    <I18nProvider>
      <ConfirmProvider>
        <AppContent />
      </ConfirmProvider>
    </I18nProvider>
  );
};

export default App;
