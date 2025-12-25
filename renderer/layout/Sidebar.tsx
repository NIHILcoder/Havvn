/**
 * Sidebar Component
 * 
 * Main navigation sidebar with expandable Downloads submenu for filters.
 */

import React, { useState } from 'react';
import { Icon, IconName } from '../components';

export type PageId = 'downloads' | 'catalog' | 'settings';
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

const navItems: NavItem[] = [
  { id: 'downloads', label: 'Downloads', icon: 'download', hasSubmenu: true },
  { id: 'catalog', label: 'Catalog', icon: 'book-open' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

const filterItems: FilterItem[] = [
  { id: 'all', label: 'All', icon: 'list' },
  { id: 'downloading', label: 'Downloading', icon: 'download', colorClass: 'downloading' },
  { id: 'completed', label: 'Completed', icon: 'check-circle', colorClass: 'completed' },
  { id: 'paused', label: 'Paused', icon: 'pause', colorClass: 'paused' },
  { id: 'error', label: 'Error', icon: 'alert-triangle', colorClass: 'error' },
];

export const Sidebar: React.FC<SidebarProps> = ({
  currentPage,
  onNavigate,
  filterMode,
  onFilterChange,
  downloadCounts,
  activeDownloads = 0,
}) => {
  const [isDownloadsExpanded, setIsDownloadsExpanded] = useState(currentPage === 'downloads');

  const handleNavClick = (item: NavItem) => {
    if (item.id === 'downloads') {
      setIsDownloadsExpanded(!isDownloadsExpanded);
      if (currentPage !== 'downloads') {
        onNavigate('downloads');
      }
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
        <div className="sidebar-logo">🔍</div>
        <span className="sidebar-title">TorrentHunt</span>
      </div>

      {/* Navigation */}
      <nav className="sidebar-nav">
        <div className="nav-section">
          <div className="nav-section-title">Menu</div>
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

      {/* Footer */}
      <div className="sidebar-footer">
        <div style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-text-tertiary)',
          textAlign: 'center'
        }}>
          TorrentHunt v1.0.0
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
