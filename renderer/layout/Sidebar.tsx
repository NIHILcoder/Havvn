/**
 * Sidebar Component — two-pillar navigation.
 *
 * The product has two hearts, and the rail says so: a Downloads | Rooms pillar
 * switch sits right under the brand, and the middle of the rail is CONTEXTUAL
 * to the active pillar — status filters for transfers, the room list + who's
 * online for rooms. Everything else (Search / RSS / Create / Swarm / Settings)
 * lives as utility icons in the footer, still one click (and hotkey) away.
 */

import React, { useState, useEffect } from 'react';
import { Icon, IconName, LogoMark, Wordmark, Identicon } from '../components';
import { useTranslation } from '../utils/i18nContext';
import type { RoomSummary } from '../../shared/types';

export type PageId = 'downloads' | 'settings' | 'create-torrent' | 'search' | 'rss' | 'rooms' | 'swarm';
export type FilterMode = 'all' | 'downloading' | 'completed' | 'paused' | 'error';

/** A friend currently online in one of your rooms (fed from room pushes). */
export interface OnlinePerson {
  memberId: string;
  name: string;
  avatarSeed: string;
  roomName: string;
  roomId?: string;
}

interface FilterItem {
  id: FilterMode;
  label: string;
  icon: IconName;
  colorClass?: string;
}

interface UtilItem {
  id: PageId;
  label: string;
  icon: IconName;
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
  rooms?: RoomSummary[];
  onlinePeople?: OnlinePerson[];
  /** Navigate to the rooms page focused on a specific room. */
  onOpenRoom?: (roomId: string) => void;
  /** The room currently open on the rooms page (highlighted in the rail). */
  activeRoomId?: string | null;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentPage,
  onNavigate,
  filterMode,
  onFilterChange,
  downloadCounts,
  activeDownloads = 0,
  rooms = [],
  onlinePeople = [],
  onOpenRoom,
  activeRoomId = null,
}) => {
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    window.api.getAppVersion().then(setAppVersion).catch(() => {});
  }, []);

  // The pillar is DERIVED, not stored: the rooms page is the rooms pillar,
  // everything else (downloads + utilities) shows the transfers context.
  const pillar: 'transfers' | 'rooms' = currentPage === 'rooms' ? 'rooms' : 'transfers';

  const filterItems: FilterItem[] = [
    { id: 'all', label: t('filter.all'), icon: 'list' },
    { id: 'downloading', label: t('filter.downloading'), icon: 'download', colorClass: 'downloading' },
    { id: 'completed', label: t('filter.completed'), icon: 'check-circle', colorClass: 'completed' },
    { id: 'paused', label: t('filter.paused'), icon: 'pause', colorClass: 'paused' },
    { id: 'error', label: t('filter.error'), icon: 'alert-triangle', colorClass: 'error' },
  ];

  const utilItems: UtilItem[] = [
    { id: 'search', label: t('nav.search'), icon: 'search' },
    { id: 'rss', label: 'RSS', icon: 'rss' },
    { id: 'create-torrent', label: t('nav.create'), icon: 'file-plus' },
    { id: 'swarm', label: t('nav.swarm'), icon: 'globe' },
    { id: 'settings', label: t('nav.settings'), icon: 'settings' },
  ];

  const totalOnline = onlinePeople.length;

  return (
    <aside className="sidebar">
      {/* Header */}
      <div className="sidebar-header">
        <div className="sidebar-logo" aria-hidden="true">
          <LogoMark size={32} />
        </div>
        <span className="sidebar-title"><Wordmark /></span>
      </div>

      {/* Pillar switch */}
      <div className="pillar-switch" role="tablist" aria-label={t('nav.mainSections')}>
        <button
          className={`pillar-btn ${pillar === 'transfers' ? 'on' : ''}`}
          role="tab"
          aria-selected={pillar === 'transfers'}
          onClick={() => onNavigate('downloads')}
        >
          <Icon name="download" size={18} />
          <span className="pillar-label">{t('nav.downloads')}</span>
          {activeDownloads > 0 && <span className="pillar-count">{activeDownloads}</span>}
        </button>
        <button
          className={`pillar-btn ${pillar === 'rooms' ? 'on' : ''}`}
          role="tab"
          aria-selected={pillar === 'rooms'}
          onClick={() => onNavigate('rooms')}
        >
          <Icon name="users" size={18} />
          <span className="pillar-label">{t('nav.rooms')}</span>
          {totalOnline > 0 && <span className="pillar-count">{totalOnline}</span>}
        </button>
      </div>

      {/* Contextual middle */}
      <nav className="sidebar-nav">
        {pillar === 'transfers' ? (
          <div className="nav-section">
            <div className="nav-section-title">{t('nav.menu')}</div>
            {filterItems.map((filter) => (
              <button
                key={filter.id}
                className={`nav-subitem ${currentPage === 'downloads' && filterMode === filter.id ? 'active' : ''} ${filter.colorClass || ''}`}
                onClick={() => { onNavigate('downloads'); onFilterChange(filter.id); }}
              >
                <span className="nav-subitem-icon">
                  <Icon name={filter.icon} size={14} />
                </span>
                <span>{filter.label}</span>
                <span className={`nav-subitem-badge ${filter.colorClass || ''}`}>
                  {downloadCounts[filter.id] || 0}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="nav-section">
            <div className="nav-section-title">{t('rooms.title')}</div>
            {rooms.length === 0 ? (
              <div className="rooms-ctx-empty">
                <p>{t('rooms.emptyDesc')}</p>
              </div>
            ) : (
              rooms.map((room) => (
                <button
                  key={room.roomId}
                  className={`room-nav-item ${activeRoomId === room.roomId ? 'active' : ''}`}
                  onClick={() => (onOpenRoom ? onOpenRoom(room.roomId) : onNavigate('rooms'))}
                >
                  <span className="room-nav-ic" aria-hidden="true">
                    {room.name.trim().slice(0, 2).toUpperCase() || '?'}
                  </span>
                  <span className="room-nav-text">
                    <span className="room-nav-name">{room.name}</span>
                    <span className="room-nav-sub">
                      {room.onlineCount > 1
                        ? `${room.onlineCount - 1} ${t('rooms.rail.online')} · ${room.fileCount} ${t('rooms.rail.files')}`
                        : `${room.memberCount} ${t('rooms.rail.members')} · ${room.fileCount} ${t('rooms.rail.files')}`}
                    </span>
                  </span>
                  {room.onlineCount > 1 && <span className="room-nav-live" />}
                </button>
              ))
            )}

            {onlinePeople.length > 0 && (
              <>
                <div className="nav-section-title online-now-title">{t('rooms.rail.onlineNow')}</div>
                {onlinePeople.map((p) => (
                  <button
                    key={p.memberId}
                    className="room-nav-item person"
                    onClick={() => (p.roomId && onOpenRoom ? onOpenRoom(p.roomId) : onNavigate('rooms'))}
                  >
                    <Identicon seed={p.avatarSeed} size={26} online />
                    <span className="room-nav-text">
                      <span className="room-nav-name">{p.name}</span>
                      <span className="room-nav-sub">{p.roomName}</span>
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </nav>

      {/* Footer: utilities + version */}
      <div className="sidebar-footer">
        <div className="sidebar-utils" role="navigation" aria-label={t('nav.utilities')}>
          {utilItems.map((util) => (
            <button
              key={util.id}
              className={`sidebar-util-btn ${currentPage === util.id ? 'active' : ''}`}
              onClick={() => onNavigate(util.id)}
              title={util.label}
              aria-label={util.label}
            >
              <Icon name={util.icon} size={17} />
            </button>
          ))}
        </div>
        <div className="sidebar-version">
          Havvn{appVersion ? ` v${appVersion}` : ''}
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
