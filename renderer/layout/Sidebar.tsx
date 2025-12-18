/**
 * Sidebar Component
 * 
 * Main navigation sidebar for the application.
 */

import React from 'react';
import { Icon, IconName } from '../components';

export type PageId = 'downloads' | 'catalog' | 'settings';

interface NavItem {
  id: PageId;
  label: string;
  icon: IconName;
  badge?: number;
}

interface SidebarProps {
  currentPage: PageId;
  onNavigate: (page: PageId) => void;
  activeDownloads?: number;
}

const navItems: NavItem[] = [
  { id: 'downloads', label: 'Downloads', icon: 'download' },
  { id: 'catalog', label: 'Catalog', icon: 'book-open' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export const Sidebar: React.FC<SidebarProps> = ({
  currentPage,
  onNavigate,
  activeDownloads = 0,
}) => {
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
            <button
              key={item.id}
              className={`nav-item ${currentPage === item.id ? 'active' : ''}`}
              onClick={() => onNavigate(item.id)}
            >
              <span className="nav-item-icon">
                <Icon name={item.icon} size={18} />
              </span>
              <span>{item.label}</span>
              {item.id === 'downloads' && activeDownloads > 0 && (
                <span className="nav-item-badge">{activeDownloads}</span>
              )}
            </button>
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
