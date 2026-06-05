/**
 * Sidebar Component
 * 
 * Main navigation sidebar with expandable Downloads submenu for filters.
 */

import React, { useState, useEffect } from 'react';
import { Icon, IconName } from '../components';
import { useTranslation } from '../utils/i18nContext';

export type PageId = 'downloads' | 'settings' | 'create-torrent' | 'search' | 'rss' | 'rooms';
export type FilterMode = 'all' | 'downloading' | 'completed' | 'paused' | 'error';

interface NavItem {
  id: PageId;
  label: string;
  icon: IconName;
  hasSubmenu?: boolean;
}

interface FilterItem {
  id: FilterMode;
  label: string;
  icon: IconName;
  colorClass?: string;
}

interface DownloadCounts {
  all: number;
  downloading: number;
  completed: number;
  paused: number;
  error: number;
}

interface SidebarProps {
  currentPage: PageId;
  onNavigate: (page: PageId) => void;
  filterMode: FilterMode;
  onFilterChange: (filter: FilterMode) => void;
  downloadCounts: DownloadCounts;
  activeDownloads?: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentPage,
  onNavigate,
  filterMode,
  onFilterChange,
  downloadCounts,
  activeDownloads = 0,
}) => {
  const { t } = useTranslation();
  const [isDownloadsExpanded, setIsDownloadsExpanded] = useState(currentPage === 'downloads');
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    window.api.getAppVersion().then(setAppVersion).catch(() => {});
  }, []);

  const navItems: NavItem[] = [
    { id: 'downloads', label: t('nav.downloads'), icon: 'download', hasSubmenu: true },
    { id: 'search', label: 'Search', icon: 'search' },
    { id: 'rss', label: 'RSS Feeds', icon: 'rss' },
    { id: 'rooms', label: t('nav.rooms'), icon: 'users' },
    { id: 'settings', label: t('nav.settings'), icon: 'settings' },
  ];

  const filterItems: FilterItem[] = [
    { id: 'all', label: t('filter.all'), icon: 'list' },
    { id: 'downloading', label: t('filter.downloading'), icon: 'download', colorClass: 'downloading' },
    { id: 'completed', label: t('filter.completed'), icon: 'check-circle', colorClass: 'completed' },
    { id: 'paused', label: t('filter.paused'), icon: 'pause', colorClass: 'paused' },
    { id: 'error', label: t('filter.error'), icon: 'alert-triangle', colorClass: 'error' },
  ];

  const handleNavClick = (item: NavItem) => {
    if (item.id === 'downloads') {
      setIsDownloadsExpanded(!isDownloadsExpanded);
      onNavigate('downloads');
    } else {
      onNavigate(item.id);
    }
  };

  const getFilterCount = (filter: FilterMode): number => {
    return downloadCounts[filter] || 0;
  };

  return (
    <aside className="sidebar">
      {/* Header */}
      <div className="sidebar-header">
        <div className="sidebar-logo" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {/* Static tray */}
            <path className="logo-tray" d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            {/* Animated download arrow (gently bobs down) */}
            <g className="logo-arrow">
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </g>
          </svg>
        </div>
        <span className="sidebar-title">TorrentHunt</span>
      </div>

      {/* Navigation */}
      <nav className="sidebar-nav">
        <div className="nav-section">
          <div className="nav-section-title">{t('nav.menu')}</div>
          {navItems.map((item) => (
            <React.Fragment key={item.id}>
              <button
                className={`nav-item ${currentPage === item.id ? 'active' : ''} ${item.hasSubmenu ? 'has-submenu' : ''}`}
                onClick={() => handleNavClick(item)}
              >
                <span className="nav-item-icon">
                  <Icon name={item.icon} size={18} />
                </span>
                <span>{item.label}</span>
                {item.id === 'downloads' && activeDownloads > 0 && (
                  <span className="nav-item-badge">{activeDownloads}</span>
                )}
                {item.hasSubmenu && (
                  <span className={`nav-item-chevron ${isDownloadsExpanded ? 'expanded' : ''}`}>
                    <Icon name="chevron-down" size={14} />
                  </span>
                )}
              </button>

              {/* Downloads Submenu */}
              {item.id === 'downloads' && currentPage === 'downloads' && (
                <div className={`nav-submenu ${isDownloadsExpanded ? 'expanded' : ''}`}>
                  {filterItems.map((filter) => (
                    <button
                      key={filter.id}
                      className={`nav-subitem ${filterMode === filter.id ? 'active' : ''} ${filter.colorClass || ''}`}
                      onClick={() => onFilterChange(filter.id)}
                    >
                      <span className="nav-subitem-icon">
                        <Icon name={filter.icon} size={14} />
                      </span>
                      <span>{filter.label}</span>
                      <span className={`nav-subitem-badge ${filter.colorClass || ''}`}>
                        {getFilterCount(filter.id)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      </nav>

      {/* Footer with Create Torrent */}
      <div className="sidebar-footer">
        {/* Create Torrent Action */}
        <div className="sidebar-actions">
          <button 
            className={`sidebar-action-btn create-torrent-btn ${currentPage === 'create-torrent' ? 'active' : ''}`}
            onClick={() => onNavigate('create-torrent')}
            title="Create Torrent"
          >
            <span className="sidebar-action-icon">
              <Icon name="file-plus" size={20} />
            </span>
            <span className="sidebar-action-text">{t('nav.create')}</span>
            <span className="sidebar-action-arrow">
              <Icon name="arrow-right" size={14} />
            </span>
          </button>
        </div>
        
        <div className="sidebar-version">
          TorrentHunt{appVersion ? ` v${appVersion}` : ''}
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
