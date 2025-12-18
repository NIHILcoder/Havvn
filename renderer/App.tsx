/**
 * TorrentHunt Main App Component
 */

import React, { useState, useEffect } from 'react';
import { Sidebar, StatusBar, PageId } from './layout';
import { DownloadStats } from '../shared/types';
import CatalogPage from './pages/CatalogPage';
import DownloadsPage from './pages/DownloadsPage';
import SettingsPage from './pages/SettingsPage';

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<PageId>('downloads');
  const [stats, setStats] = useState<DownloadStats[]>([]);

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

  // Subscribe to stats for status bar
  useEffect(() => {
    const unsubscribe = window.api.onDownloadStats((newStats) => {
      setStats(newStats);
    });
    return () => unsubscribe();
  }, []);

  // Calculate aggregate stats
  const activeDownloads = stats.filter(s => s.status === 'downloading').length;
  const totalDownSpeed = stats.reduce((sum, s) => sum + s.downSpeedBps, 0);
  const totalUpSpeed = stats.reduce((sum, s) => sum + s.upSpeedBps, 0);
  const totalPeers = stats.reduce((sum, s) => sum + s.peers, 0);

  const renderPage = () => {
    switch (currentPage) {
      case 'catalog':
        return <CatalogPage />;
      case 'downloads':
        return <DownloadsPage />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <DownloadsPage />;
    }
  };

  return (
    <div className="app-container">
      <Sidebar
        currentPage={currentPage}
        onNavigate={setCurrentPage}
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
  );
};

export default App;
