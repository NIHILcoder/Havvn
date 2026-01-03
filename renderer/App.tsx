/**
 * TorrentHunt Main App Component
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Sidebar, StatusBar, PageId, FilterMode } from './layout';
import { DownloadStats, Download } from '../shared/types';
import CatalogPage from './pages/CatalogPage';
import CreateTorrentPage from './pages/CreateTorrentPage';
import DownloadsPage from './pages/DownloadsPage';
import SettingsPage from './pages/SettingsPage';

// Extended page type to include create-torrent
type ExtendedPageId = PageId | 'create-torrent';

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<ExtendedPageId>('downloads');
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

  // Determine sidebar page (don't highlight create-torrent in nav)
  const sidebarPage: PageId = currentPage === 'create-torrent' ? 'downloads' : currentPage;

  return (
    <div className="app-container">
      <Sidebar
        currentPage={sidebarPage}
        onNavigate={(page) => setCurrentPage(page)}
        filterMode={filterMode}
        onFilterChange={setFilterMode}
        downloadCounts={downloadCounts}
        activeDownloads={activeDownloads}
        onCreateTorrent={() => setCurrentPage('create-torrent')}
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
  );
};

export default App;
