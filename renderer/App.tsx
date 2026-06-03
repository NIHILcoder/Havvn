/**
 * TorrentHunt Main App Component
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Toaster } from 'react-hot-toast';
import { Sidebar, StatusBar, PageId, FilterMode } from './layout';
import { DownloadStats, Download } from '../shared/types';
import CreateTorrentPage from './pages/CreateTorrentPage';
import DownloadsPage from './pages/DownloadsPage';
import SettingsPage from './pages/SettingsPage';
import SearchPage from './pages/SearchPage';
import RSSPage from './pages/RSSPage';
import { formatBytes } from './utils/format-helpers';
import { I18nProvider } from './utils/i18nContext';


const AppContent: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<PageId>('downloads');
  const [stats, setStats] = useState<DownloadStats[]>([]);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  // Torrent/magnet handed to us by the OS — passed to DownloadsPage to open the add dialog
  const [openTorrentUri, setOpenTorrentUri] = useState<string | null>(null);
  // VPN kill-switch warning banner (set when the guard auto-pauses on VPN drop)
  const [vpnAlert, setVpnAlert] = useState<{ paused: number; publicIP?: string } | null>(null);
  // Disk-space guard warning banner
  const [diskAlert, setDiskAlert] = useState<{ paused: number; freeBytes: number; thresholdBytes: number } | null>(null);

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

  // Load downloads for counts
  useEffect(() => {
    const loadDownloads = async () => {
      try {
        const list = await window.api.getDownloads();
        setDownloads(list.filter(d => d.status !== 'removed'));
      } catch (error) {
        console.error('Failed to load downloads:', error);
      }
    };
    loadDownloads();

    // Refresh periodically
    const interval = setInterval(loadDownloads, 5000);
    return () => clearInterval(interval);
  }, []);

  // Subscribe to stats for status bar
  useEffect(() => {
    const unsubscribe = window.api.onDownloadStats((newStats) => {
      setStats(newStats);

      // Update download statuses from stats
      setDownloads(prev => prev.map(d => {
        const stat = newStats.find(s => s.id === d.id);
        if (stat) {
          return { ...d, status: stat.status };
        }
        return d;
      }));
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

  // Disk-space guard: warning banner when free space is low
  useEffect(() => {
    const offLow = window.api.onDiskLow((info) => setDiskAlert(info));
    const offRecovered = window.api.onDiskRecovered(() => setDiskAlert(null));
    return () => { offLow(); offRecovered(); };
  }, []);

  // Global navigation shortcuts (fixed, layout-independent via event.code)
  useEffect(() => {
    const hotkeysMap: Record<string, string[]> = {
      'open-downloads': ['Ctrl', 'KeyD'],
      'open-settings': ['Ctrl', 'Comma'],
      'add-torrent': ['Ctrl', 'KeyO'],
      'create-torrent': ['Ctrl', 'KeyN'],
    };

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
      for (const [action, hotkeyKeys] of Object.entries(hotkeysMap)) {
        const hotkeyString = (hotkeyKeys as string[]).join('+');
        if (keyString === hotkeyString) {
          e.preventDefault();

          // Execute action
          switch (action) {
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
          }
          break;
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  // Calculate download counts for sidebar
  const downloadCounts = useMemo(() => ({
    all: downloads.length,
    downloading: downloads.filter(d => ['downloading', 'queued'].includes(d.status)).length,
    completed: downloads.filter(d => ['completed', 'seeding'].includes(d.status)).length,
    paused: downloads.filter(d => d.status === 'paused').length,
    error: downloads.filter(d => d.status === 'error').length,
  }), [downloads]);

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
      default:
        return <DownloadsPage filterMode={filterMode} onFilterChange={setFilterMode} openTorrentUri={openTorrentUri} onOpenHandled={() => setOpenTorrentUri(null)} />;
    }
  };

  return (
    <>
      <Toaster
        position="top-right"
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
        />

        <main className="main-content">
          {vpnAlert && (
            <div className="vpn-alert-banner" role="alert">
              <span className="vpn-alert-icon">⚠</span>
              <div className="vpn-alert-text">
                <strong>VPN connection lost — torrents paused.</strong>{' '}
                {vpnAlert.paused > 0
                  ? `${vpnAlert.paused} torrent${vpnAlert.paused === 1 ? '' : 's'} were paused to protect your IP.`
                  : 'Your VPN appears to be down.'}
                {vpnAlert.publicIP ? ` Current public IP: ${vpnAlert.publicIP}.` : ''}
                {' '}Reconnect your VPN, then resume downloads manually.
              </div>
              <button className="vpn-alert-close" onClick={() => setVpnAlert(null)} aria-label="Dismiss">×</button>
            </div>
          )}
          {diskAlert && (
            <div className="vpn-alert-banner" role="alert">
              <span className="vpn-alert-icon">⚠</span>
              <div className="vpn-alert-text">
                <strong>Low disk space — torrents paused.</strong>{' '}
                {`Only ${formatBytes(diskAlert.freeBytes)} free (threshold ${formatBytes(diskAlert.thresholdBytes)}).`}
                {diskAlert.paused > 0
                  ? ` ${diskAlert.paused} torrent${diskAlert.paused === 1 ? '' : 's'} paused.`
                  : ''}
                {' '}Free up space, then resume downloads manually.
              </div>
              <button className="vpn-alert-close" onClick={() => setDiskAlert(null)} aria-label="Dismiss">×</button>
            </div>
          )}
          {renderPage()}

          <StatusBar
            activeDownloads={activeDownloads}
            totalDownSpeed={totalDownSpeed}
            totalUpSpeed={totalUpSpeed}
            connectedPeers={totalPeers}
          />
        </main>
      </div>
    </>
  );
};

const App: React.FC = () => {
  return (
    <I18nProvider>
      <AppContent />
    </I18nProvider>
  );
};

export default App;
