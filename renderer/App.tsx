/**
 * TorrentHunt Main App Component
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Toaster } from 'react-hot-toast';
import { Sidebar, StatusBar, PageId, FilterMode } from './layout';
import { DownloadStats, Download } from '../shared/types';
import CatalogPage from './pages/CatalogPage';
import CreateTorrentPage from './pages/CreateTorrentPage';
import DownloadsPage from './pages/DownloadsPage';
import SettingsPage from './pages/SettingsPage';

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<PageId>('downloads');
  const [stats, setStats] = useState<DownloadStats[]>([]);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');

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

  // Global hotkeys handler
  useEffect(() => {
    // Load hotkeys from localStorage
    const loadHotkeys = () => {
      try {
        const saved = localStorage.getItem('hotkeys');
        return saved ? JSON.parse(saved) : null;
      } catch {
        return null;
      }
    };

    const savedHotkeys = loadHotkeys();

    // Default hotkeys (using event.code for keyboard layout independence)
    const defaultHotkeysMap = {
      'open-downloads': ['Ctrl', 'KeyD'],
      'open-catalog': ['Ctrl', 'KeyK'],
      'open-settings': ['Ctrl', 'Comma'],
      'add-torrent': ['Ctrl', 'KeyO'],
      'create-torrent': ['Ctrl', 'KeyN'],
    };

    // Merge with saved hotkeys
    const hotkeysMap = savedHotkeys || defaultHotkeysMap;

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
            case 'open-catalog':
              setCurrentPage('catalog');
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
      case 'catalog':
        return <CatalogPage />;
      case 'create-torrent':
        return <CreateTorrentPage onNavigateBack={() => setCurrentPage('downloads')} />;
      case 'downloads':
        return <DownloadsPage filterMode={filterMode} onFilterChange={setFilterMode} />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <DownloadsPage filterMode={filterMode} onFilterChange={setFilterMode} />;
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

export default App;
