/**
 * Theme-preview gallery samples.
 *
 * Static, presentational mock-ups of the app's real surfaces — Downloads, Rooms
 * (shared files, chat, members) and Forms — built from the SAME css classes the
 * live components emit, on frozen demo data. They exist so the theme editor can
 * show how a draft recolors Rooms/Downloads without navigating away from the
 * dock. No state, no props, no IPC: they paint purely from the `:root` tokens
 * the editor is live-previewing.
 *
 * Because the classes are the real ones, these stay faithful as long as the
 * source markup doesn't rename them; if a class is renamed, update the matching
 * sample here. The room/toggle/select stylesheets are page/component-scoped
 * (lazy), so we import them here to guarantee the samples are styled even when
 * their page was never visited — the editor itself is lazy-loaded, so this adds
 * nothing to the initial bundle.
 */
import React from 'react';
import Icon from '../Icon';
import '../../pages/DownloadsPage.css';
import '../../pages/RoomsPage.css';
import '../Toggle.css';
import '../Select.css';
import '../Modal.css';
import './theme-preview.css';

/**
 * Identicon stand-in — the real avatars are seed-generated SVGs; here a fixed
 * gradient square keeps the sample self-contained and colorful (identicons are
 * intentionally NOT theme-colored, so demo gradients are faithful in spirit).
 */
const DemoAvatar: React.FC<{
  from: string; to: string; size?: number; ring?: boolean; online?: boolean;
}> = ({ from, to, size = 30, ring = false, online = false }) => (
  <span
    className={`identicon${ring ? ' identicon-ring' : ''}`}
    aria-hidden="true"
    style={{ position: 'relative', width: size, height: size, borderRadius: '28%', background: `linear-gradient(135deg, ${from}, ${to})`, flexShrink: 0, display: 'inline-block' }}
  >
    {online && <span className="identicon-status online" style={{ width: 8, height: 8 }} />}
  </span>
);

/* ── Downloads ──────────────────────────────────────────────────── */
export const DownloadsSample: React.FC = () => (
  <div className="te-gallery-surface">
    <div className="page-header">
      <div className="page-title-block">
        <h1 className="page-title">Downloads</h1>
        <div className="page-subtitle">3 active · 5.4 MB/s</div>
      </div>
      <div className="page-actions">
        <div className="view-mode-toggle">
          <button type="button" className="btn btn-primary btn-sm btn-icon-only" title="Compact"><Icon name="list" size={16} /></button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon-only" title="Detailed"><Icon name="grid" size={16} /></button>
        </div>
        <button type="button" className="btn btn-ghost btn-sm btn-icon-only" title="Pause all"><Icon name="pause" size={16} /></button>
        <button type="button" className="btn btn-primary btn-sm add-torrent-btn"><Icon name="plus" size={16} /><span className="btn-text">Add</span></button>
      </div>
    </div>

    <div className="downloads-list downloads-list-compact te-gallery-list">
      {/* downloading */}
      <div className="download-item download-item-compact download-st-downloading">
        <div className="trow-main">
          <span className="trow-tile tile-package"><Icon name="package" size={17} /></span>
          <div className="trow-name">
            <div className="trow-title truncate">Ubuntu 24.04.1 LTS Desktop (amd64)</div>
            <div className="trow-sub"><span>3.2 GB</span><span className="trow-sub-pct">62%</span><span className="trow-sub-cat">linux</span></div>
          </div>
          <div className="trow-prog">
            <div className="trow-prog-labels"><span className="trow-pct">62.0%</span><span className="trow-prog-hint">8m 40s</span></div>
            <div className="progress-wrapper" style={{ position: 'relative' }}>
              <div className="progress-bar" style={{ height: '6px' }}><div className="progress-bar-fill" style={{ width: '62%' }} /></div>
            </div>
          </div>
          <div className="trow-rate"><span className="trow-rate-main rate-down">↓ 5.4 MB/s</span><span className="trow-rate-sub">48 peers · 112 seeds</span></div>
          <div className="trow-status"><span className="badge badge-downloading status-badge"><span>Downloading</span></span></div>
        </div>
        <div className="trow-actions">
          <button type="button" className="btn btn-ghost btn-sm"><Icon name="share-2" size={13} />Share</button>
          <button type="button" className="btn btn-ghost btn-sm">Pause</button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon-only"><Icon name="more-horizontal" size={14} /></button>
        </div>
      </div>

      {/* seeding */}
      <div className="download-item download-item-compact download-st-seeding selected">
        <div className="trow-main">
          <span className="trow-tile tile-film"><Icon name="film" size={17} /></span>
          <div className="trow-name">
            <div className="trow-title truncate">Big Buck Bunny (2008) 4K HDR</div>
            <div className="trow-sub"><span>8.7 GB</span><span className="trow-sub-pct">100%</span><span className="trow-sub-cat">movies</span></div>
          </div>
          <div className="trow-prog">
            <div className="trow-prog-labels"><span className="trow-pct">100%</span><span className="trow-prog-hint">2.14×</span></div>
            <div className="progress-wrapper" style={{ position: 'relative' }}>
              <div className="progress-bar" style={{ height: '6px' }}><div className="progress-bar-fill success" style={{ width: '100%' }} /></div>
            </div>
          </div>
          <div className="trow-rate"><span className="trow-rate-main rate-up">↑ 820 KB/s</span><span className="trow-rate-sub">23 peers</span></div>
          <div className="trow-status"><span className="badge badge-seeding status-badge"><span>Seeding</span></span></div>
        </div>
        <div className="trow-actions">
          <button type="button" className="btn btn-ghost btn-sm btn-icon-only download-watch-btn"><Icon name="play" size={14} /></button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon-only"><Icon name="folder" size={14} /></button>
        </div>
      </div>

      {/* error */}
      <div className="download-item download-item-compact download-st-error">
        <div className="trow-main">
          <span className="trow-tile tile-package"><Icon name="package" size={17} /></span>
          <div className="trow-name">
            <div className="trow-title truncate">Debian 12.5.0 amd64 netinst</div>
            <div className="trow-sub"><span>3.7 GB</span><span className="trow-sub-pct">18%</span><span className="error-text truncate">Tracker announce failed</span></div>
          </div>
          <div className="trow-prog">
            <div className="trow-prog-labels"><span className="trow-pct">18.0%</span><span className="trow-prog-hint">error</span></div>
            <div className="progress-wrapper" style={{ position: 'relative' }}>
              <div className="progress-bar" style={{ height: '6px' }}><div className="progress-bar-fill error" style={{ width: '18%' }} /></div>
            </div>
          </div>
          <div className="trow-rate"><span className="trow-rate-sub">—</span></div>
          <div className="trow-status"><span className="badge badge-error status-badge"><span>Error</span></span></div>
        </div>
        <div className="trow-actions">
          <button type="button" className="btn btn-ghost btn-sm">Retry</button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon-only"><Icon name="more-horizontal" size={14} /></button>
        </div>
      </div>
    </div>
  </div>
);

/* ── Rooms · shared files ───────────────────────────────────────── */
export const RoomsSample: React.FC = () => (
  <div className="te-gallery-surface room-section">
    <div className="room-section-title-row">
      <div className="room-section-title">Shared files · 2</div>
      <div className="room-section-title-actions">
        <button type="button" className="room-newfolder-btn"><Icon name="plus" size={13} /> New folder</button>
      </div>
    </div>

    <div className="room-folder-list">
      <div className="room-folder-section">
        <div className="room-folder-header">
          <span className="room-folder-label">
            <span className="room-folder-ic" style={{ color: '#e8792b' }}><Icon name="folder" size={14} /></span>
            <span className="room-folder-title">Movies</span>
            <span className="room-folder-count">2</span>
          </span>
          <span className="room-folder-acts">
            <button className="room-folder-act" title="Add here"><Icon name="file-plus" size={13} /></button>
            <button className="room-folder-act" title="Rename"><Icon name="edit-2" size={13} /></button>
            <button className="room-folder-act danger" title="Delete"><Icon name="trash" size={13} /></button>
          </span>
        </div>

        <div className="room-files">
          {/* seeding video */}
          <div className="room-file">
            <div className="room-file-owner" title="Added by Ivy"><DemoAvatar from="#e8792b" to="#a855f7" /></div>
            <div className="room-file-main">
              <div className="room-file-name">Interstellar.2014.2160p.HDR.mkv</div>
              <div className="room-file-sub">
                <span>8.4 GB</span>
                <span className="room-file-dot">·</span>
                <span className="room-file-have"><Icon name="users" size={12} /> 4/5</span>
                <span className="room-file-reacts">
                  <button type="button" className="room-file-react active mine" aria-pressed="true">🔥<span className="room-file-react-n">2</span></button>
                  <button type="button" className="room-file-react">👍</button>
                  <button type="button" className="room-file-react">❤️</button>
                </span>
              </div>
            </div>
            <button className="room-file-open room-file-watch" title="Watch in room"><Icon name="play" size={14} /> Watch</button>
            <button className="room-file-open" title="Open file"><Icon name="external-link" size={14} /> Open</button>
            <button className="room-file-del" title="Remove"><Icon name="trash" size={14} /></button>
            <div className="room-file-status"><span className="room-status seeding" title="On this device"><Icon name="check-circle" size={16} /></span></div>
          </div>

          {/* mid-download archive */}
          <div className="room-file">
            <div className="room-file-owner" title="Added by Diego"><DemoAvatar from="#22c55e" to="#3b82f6" /></div>
            <div className="room-file-main">
              <div className="room-file-name">Project-Assets-v3.zip</div>
              <div className="room-file-sub">
                <span>1.2 GB</span>
                <span className="room-file-dot">·</span>
                <span className="room-file-have"><Icon name="users" size={12} /> 2/5</span>
                <span className="room-file-dot">·</span>
                <span className="room-file-speed">3.4 MB/s</span>
              </div>
              <div className="room-file-progress"><div className="room-file-progress-bar" style={{ width: '62%' }} /></div>
            </div>
            <div className="room-file-move-wrap"><button className="room-file-open" title="Move to folder"><Icon name="folder" size={14} /></button></div>
            <button className="room-file-del" title="Remove"><Icon name="trash" size={14} /></button>
            <div className="room-file-status"><span className="room-status downloading">62%</span></div>
          </div>
        </div>
      </div>
    </div>

    <div className="room-files-actions">
      <button className="btn btn-ghost btn-sm room-add-files"><Icon name="download" size={14} /> From Transfers</button>
      <button className="btn btn-ghost btn-sm room-add-files"><Icon name="file-plus" size={14} /> Add files</button>
      <div className="room-limits" title="Per-room speed limits">
        <Icon name="gauge" size={13} />
        <label className="room-limit">↑<input type="number" min={0} placeholder="∞" defaultValue="" />KB/s</label>
        <label className="room-limit">↓<input type="number" min={0} placeholder="∞" defaultValue="2048" />KB/s</label>
      </div>
    </div>
  </div>
);

/* ── Rooms · chat + members ─────────────────────────────────────── */
export const ChatSample: React.FC = () => (
  <div className="te-gallery-surface room-chat">
    <div className="room-chat-log">
      <div className="room-chat-msg">
        <DemoAvatar from="#e8792b" to="#b45309" size={28} />
        <div className="room-chat-bubble-wrap">
          <span className="room-chat-author">Mara</span>
          <span className="room-chat-bubble">Grabbing the last file now — almost done seeding.</span>
          <span className="room-chat-time">09:41</span>
        </div>
      </div>
      <div className="room-chat-msg mine">
        <div className="room-chat-bubble-wrap">
          <span className="room-chat-bubble">Nice — I'll leave my client open overnight.</span>
          <span className="room-chat-time">09:42</span>
        </div>
      </div>
    </div>

    <div className="room-chat-compose">
      <input className="rooms-input" placeholder="Message the room…" defaultValue="" />
      <button type="button" className="btn btn-primary btn-sm"><Icon name="send" size={14} /> Send</button>
    </div>

    <div className="room-members">
      <div className="room-member" title="Direct">
        <DemoAvatar from="#22c55e" to="#15803d" online />
        <span className="room-member-name">Mara</span>
        <span className="room-member-have">3/4</span>
        <button type="button" className="room-member-mute" title="Mute"><Icon name="eye-off" size={13} /></button>
        <button type="button" className="room-member-kick" title="Remove"><Icon name="x-circle" size={13} /></button>
      </div>
      <div className="room-member" title="You">
        <DemoAvatar from="#3b82f6" to="#1e40af" ring online />
        <span className="room-member-name"><Icon name="star" size={11} className="room-member-owner" />You</span>
        <span className="room-member-have">4/4</span>
      </div>
    </div>
  </div>
);

/* ── Forms ──────────────────────────────────────────────────────── */
export const FormsSample: React.FC = () => (
  <div className="te-gallery-surface te-gallery-forms">
    <div className="form-group">
      <label className="label">Room name</label>
      <input className="input" type="text" defaultValue="Movie Night" placeholder="Enter a name" />
      <span className="help-text">Shown to everyone who joins the room.</span>
    </div>

    <div className="te-gallery-toggles">
      <div className="toggle-container">
        <div className="toggle-switch medium active" role="switch" aria-checked="true" aria-label="Seed after download"><span className="toggle-slider" /></div>
        <span className="toggle-label">Seed after download</span>
      </div>
      <div className="toggle-container">
        <div className="toggle-switch medium" role="switch" aria-checked="false" aria-label="Start paused"><span className="toggle-slider" /></div>
        <span className="toggle-label">Start paused</span>
      </div>
    </div>

    <div className="custom-select-container">
      <div className="custom-select-trigger" role="button" aria-haspopup="listbox" aria-expanded="false">
        <div className="custom-select-value"><span>Download folder</span></div>
        <div className="custom-select-icon"><Icon name="chevron-down" size={16} /></div>
      </div>
    </div>

    <div className="te-gallery-btnrow">
      <button className="btn btn-primary" type="button">Save</button>
      <button className="btn btn-secondary" type="button">Cancel</button>
      <button className="btn btn-ghost" type="button">Skip</button>
      <button className="btn btn-danger" type="button">Delete</button>
    </div>

    <div className="um-card um-sm te-gallery-modalcard">
      <div className="um-head">
        <h2 className="um-title">Delete room?</h2>
        <button className="um-x" type="button" aria-label="Close"><Icon name="x" size={18} /></button>
      </div>
      <div className="um-body um-body-plain">
        <p>This removes the room and disconnects everyone sharing files in it. This cannot be undone.</p>
      </div>
      <div className="um-foot">
        <button className="btn btn-secondary" type="button">Cancel</button>
        <button className="btn btn-primary" type="button">Delete room</button>
      </div>
    </div>
  </div>
);
