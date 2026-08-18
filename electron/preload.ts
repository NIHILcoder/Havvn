import { contextBridge, ipcRenderer, IpcRendererEvent, webFrame } from 'electron';

// webUtils was added in Electron 30; the bundled type defs for older versions
// don't declare it, so access it defensively without a typed named import.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { webUtils } = require('electron') as { webUtils?: { getPathForFile(file: File): string } };
import {
  AddDownloadRequest,
  Download,
  DownloadStats,
  AppSettings,
  Category,
  SchedulerConfig,
  IpcApi,
  CreateTorrentRequest,
  CreateTorrentResult,
  CreateTorrentProgress,
  PrivacyConfig,
  VpnBindEvent,
  CompletionAction,
  CompletionActionState,
  CompletionPending,
  ShareInfo,
  RoomProfile,
  RoomState,
  RoomSummary,
  VoiceSettings,
  VoiceDeviceInfo,
  ScreenSourceInfo,
  LanDiagReport,
  LanRoomPrefs,
  SearchProgress,
} from '../shared/types';
import type {
  ConfigField,
  ConsoleLine,
  GameVersionRef,
  RoomServerState,
  ServerContentState,
  ServerScheduleState,
  ServerScheduleRule,
  ServerAccessState,
} from '../shared/gameserver-types';

const api: IpcApi = {
  // Downloads
  addDownload: (request: AddDownloadRequest): Promise<Download> => {
    return ipcRenderer.invoke('downloads:add', request);
  },

  pauseDownload: (id: string): Promise<void> => {
    return ipcRenderer.invoke('downloads:pause', id);
  },

  resumeDownload: (id: string): Promise<void> => {
    return ipcRenderer.invoke('downloads:resume', id);
  },

  removeDownload: (id: string, deleteFiles: boolean): Promise<void> => {
    return ipcRenderer.invoke('downloads:remove', id, deleteFiles);
  },

  stopSeeding: (id: string): Promise<void> => {
    return ipcRenderer.invoke('downloads:stopSeeding', id);
  },

  retryDownload: (id: string): Promise<void> => {
    return ipcRenderer.invoke('downloads:retry', id);
  },

  recheckDownload: (id: string): Promise<void> => {
    return ipcRenderer.invoke('downloads:recheck', id);
  },

  getDownloads: (): Promise<Download[]> => {
    return ipcRenderer.invoke('downloads:getAll');
  },

  getTorrentFiles: (id: string): Promise<any[]> => {
    return ipcRenderer.invoke('downloads:getFiles', id);
  },

  getStreamUrl: (id: string, fileIndex: number, opts?: { transcode?: boolean; audioTrack?: number }): Promise<{ url: string; name: string; kind: 'video' | 'audio' | 'other'; transcoded: boolean }> => {
    return ipcRenderer.invoke('downloads:getStreamUrl', id, fileIndex, opts);
  },

  stopStream: (id: string, fileIndex?: number): Promise<void> => {
    return ipcRenderer.invoke('downloads:stopStream', id, fileIndex);
  },

  shareStart: (downloadId: string): Promise<ShareInfo> => {
    return ipcRenderer.invoke('share:start', downloadId);
  },
  shareStop: (downloadId: string): Promise<{ ok: boolean }> => {
    return ipcRenderer.invoke('share:stop', downloadId);
  },
  shareGet: (downloadId: string): Promise<(ShareInfo & { peers: number }) | null> => {
    return ipcRenderer.invoke('share:get', downloadId);
  },
  shareList: (): Promise<ShareInfo[]> => {
    return ipcRenderer.invoke('share:list');
  },

  getTorrentInfo: (params: { torrentPath?: string; magnetUri?: string }): Promise<any> => {
    return ipcRenderer.invoke('downloads:getTorrentInfo', params);
  },

  setDownloadCategory: (id: string, category: string | null): Promise<void> => {
    return ipcRenderer.invoke('downloads:setCategory', id, category);
  },

  getAppStats: () => {
    return ipcRenderer.invoke('stats:getAppStats');
  },

  // Settings
  getSettings: (): Promise<AppSettings> => {
    return ipcRenderer.invoke('settings:get');
  },

  updateSettings: (settings: Partial<AppSettings>): Promise<AppSettings> => {
    return ipcRenderer.invoke('settings:update', settings);
  },

  // Categories
  getCategories: (): Promise<Category[]> => {
    return ipcRenderer.invoke('categories:get');
  },

  addCategory: (category: Omit<Category, 'id'>): Promise<Category> => {
    return ipcRenderer.invoke('categories:add', category);
  },

  updateCategory: (id: string, updates: Partial<Category>): Promise<Category> => {
    return ipcRenderer.invoke('categories:update', id, updates);
  },

  deleteCategory: (id: string): Promise<void> => {
    return ipcRenderer.invoke('categories:delete', id);
  },

  // Scheduler
  getScheduler: (): Promise<SchedulerConfig> => {
    return ipcRenderer.invoke('scheduler:get');
  },

  updateScheduler: (config: Partial<SchedulerConfig>): Promise<SchedulerConfig> => {
    return ipcRenderer.invoke('scheduler:update', config);
  },

  // File dialogs
  selectDirectory: (): Promise<string | null> => {
    return ipcRenderer.invoke('dialog:selectDirectory');
  },

  selectTorrentFile: (): Promise<{ path: string; content: string } | null> => {
    return ipcRenderer.invoke('dialog:selectTorrentFile');
  },

  selectFilesForTorrent: (): Promise<string[] | null> => {
    return ipcRenderer.invoke('dialog:selectFilesForTorrent');
  },

  selectFolderForTorrent: (): Promise<string | null> => {
    return ipcRenderer.invoke('dialog:selectFolderForTorrent');
  },

  selectSaveTorrentPath: (defaultName: string): Promise<string | null> => {
    return ipcRenderer.invoke('dialog:selectSaveTorrentPath', defaultName);
  },

  // File system operations
  getPathInfo: (path: string): Promise<{
    isDirectory: boolean;
    size: number;
    fileCount: number;
    name: string;
  }> => {
    return ipcRenderer.invoke('fs:getPathInfo', path);
  },

  getFileTree: (sourcePaths: string[]) => {
    return ipcRenderer.invoke('fs:getFileTree', sourcePaths);
  },

  // Shell operations
  openPath: (path: string): Promise<void> => {
    return ipcRenderer.invoke('shell:openPath', path);
  },

  showItemInFolder: (path: string): Promise<void> => {
    return ipcRenderer.invoke('shell:showItemInFolder', path);
  },

  // Cache management
  clearCache: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('cache:clear');
  },

  // Create torrent
  createTorrent: (request: CreateTorrentRequest): Promise<CreateTorrentResult> => {
    return ipcRenderer.invoke('torrent:create', request);
  },

  getDefaultTrackers: (): Promise<string[][]> => {
    return ipcRenderer.invoke('torrent:getDefaultTrackers');
  },

  // Stats subscription
  onDownloadStats: (callback: (stats: DownloadStats[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, stats: DownloadStats[]) => {
      callback(stats);
    };

    ipcRenderer.on('downloads:stats', handler);

    return () => {
      ipcRenderer.removeListener('downloads:stats', handler);
    };
  },

  onCreateTorrentProgress: (callback: (progress: CreateTorrentProgress) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, progress: CreateTorrentProgress) => {
      callback(progress);
    };

    ipcRenderer.on('torrent:createProgress', handler);

    return () => {
      ipcRenderer.removeListener('torrent:createProgress', handler);
    };
  },

  // Privacy & Security
  getPrivacyConfig: () => {
    return ipcRenderer.invoke('privacy:getConfig');
  },

  updatePrivacyConfig: (updates: Partial<PrivacyConfig>) => {
    return ipcRenderer.invoke('privacy:updateConfig', updates);
  },

  getVpnBindStatus: () => {
    return ipcRenderer.invoke('privacy:getVpnBindStatus');
  },

  checkVPN: () => {
    return ipcRenderer.invoke('privacy:checkVPN');
  },

  getIpInfo: () => {
    return ipcRenderer.invoke('privacy:getIpInfo');
  },

  getNetworkHealth: () => {
    return ipcRenderer.invoke('network:getHealth');
  },

  getRunningTransport: () => {
    return ipcRenderer.invoke('network:getRunningTransport');
  },

  getDohTemplates: () => {
    return ipcRenderer.invoke('doh:getTemplates');
  },
  addDohTemplate: (name: string, url: string) => {
    return ipcRenderer.invoke('doh:addTemplate', name, url);
  },
  deleteDohTemplate: (id: string) => {
    return ipcRenderer.invoke('doh:deleteTemplate', id);
  },
  testDohResolver: (url: string) => {
    return ipcRenderer.invoke('doh:test', url);
  },

  getCurrentNetwork: () => {
    return ipcRenderer.invoke('netprofiles:current');
  },
  getNetworkProfiles: () => {
    return ipcRenderer.invoke('netprofiles:list');
  },
  saveNetworkProfile: (profile: import('../shared/types').NetworkProfile) => {
    return ipcRenderer.invoke('netprofiles:save', profile);
  },
  deleteNetworkProfile: (id: string) => {
    return ipcRenderer.invoke('netprofiles:delete', id);
  },
  onNetworkProfile: (callback: (payload: { current: import('../shared/types').NetworkInfo; activeId: string | null }) => void) => {
    const listener = (_e: unknown, payload: { current: import('../shared/types').NetworkInfo; activeId: string | null }) => callback(payload);
    ipcRenderer.on('network:profileChanged', listener);
    return () => ipcRenderer.removeListener('network:profileChanged', listener);
  },

  isEncryptionAvailable: () => {
    return ipcRenderer.invoke('privacy:isEncryptionAvailable');
  },

  clearAllData: () => {
    return ipcRenderer.invoke('privacy:clearAllData');
  },

  openLogsFolder: () => {
    return ipcRenderer.invoke('privacy:openLogsFolder');
  },

  clearLogs: () => {
    return ipcRenderer.invoke('privacy:clearLogs');
  },

  getPortForwardStatus: () => {
    return ipcRenderer.invoke('network:getPortForwardStatus');
  },

  // Dialog API
  dialog: {
    showOpenDialog: (options: {
      properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<{ canceled: boolean; filePaths: string[] }> => {
      return ipcRenderer.invoke('dialog:showOpenDialog', options);
    },

    showSaveDialog: (options: {
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<{ canceled: boolean; filePath?: string }> => {
      return ipcRenderer.invoke('dialog:showSaveDialog', options);
    },
  },

  // System settings
  setAutoLaunch: (enabled: boolean): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('app:setAutoLaunch', enabled);
  },

  getAutoLaunch: (): Promise<boolean> => {
    return ipcRenderer.invoke('app:getAutoLaunch');
  },

  setCloseToTray: (enabled: boolean): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('app:setCloseToTray', enabled);
  },

  setMinimizeToTray: (enabled: boolean): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('app:setMinimizeToTray', enabled);
  },

  // Auto-update
  checkForUpdates: (): Promise<{ ok: boolean; reason?: string }> => {
    return ipcRenderer.invoke('app:checkForUpdates');
  },

  quitAndInstallUpdate: (): Promise<{ ok: boolean }> => {
    return ipcRenderer.invoke('app:quitAndInstall');
  },

  onUpdateStatus: (callback: (status: { kind: string; [k: string]: unknown }) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, status: { kind: string }) => callback(status);
    ipcRenderer.on('app:updateStatus', handler);
    return () => { ipcRenderer.removeListener('app:updateStatus', handler); };
  },

  // On-completion action (one-shot: nothing / sleep / shutdown / quit)
  getCompletionAction: (): Promise<CompletionActionState> => {
    return ipcRenderer.invoke('app:getCompletionAction');
  },

  setCompletionAction: (action: CompletionAction): Promise<{ ok: boolean }> => {
    return ipcRenderer.invoke('app:setCompletionAction', action);
  },

  onCompletionActionChanged: (callback: (action: CompletionAction) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, action: CompletionAction) => callback(action);
    ipcRenderer.on('app:completionActionChanged', handler);
    return () => { ipcRenderer.removeListener('app:completionActionChanged', handler); };
  },

  onCompletionActionPending: (callback: (pending: CompletionPending | null) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, pending: CompletionPending | null) => callback(pending);
    ipcRenderer.on('app:completionActionPending', handler);
    return () => { ipcRenderer.removeListener('app:completionActionPending', handler); };
  },

  // App version (from package.json via Electron)
  getAppVersion: (): Promise<string> => {
    return ipcRenderer.invoke('app:getVersion');
  },

  // Relaunch the app (engine switch "restart now")
  relaunchApp: (): Promise<{ ok: boolean }> => {
    return ipcRenderer.invoke('app:relaunch');
  },

  // The engine this session booted with (vs. the configured one)
  getRunningEngine: (): Promise<'native' | 'webtorrent'> => {
    return ipcRenderer.invoke('app:getRunningEngine');
  },

  // Default client
  isDefaultClient: (): Promise<boolean> => {
    return ipcRenderer.invoke('app:isDefaultClient');
  },

  setDefaultClient: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('app:setDefaultClient');
  },

  // Settings export/import
  exportSettings: (): Promise<{ success: boolean; path?: string }> => {
    return ipcRenderer.invoke('settings:export');
  },

  importSettings: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('settings:import');
  },

  // App events
  onOpenTorrent: (callback: (torrentUri: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, uri: string) => { callback(uri); };
    ipcRenderer.on('app:openTorrent', handler);
    return () => { ipcRenderer.removeListener('app:openTorrent', handler); };
  },

  // A havvn://join/<invite> deep link — the renderer opens the Join dialog
  // PREFILLED with the invite (never auto-joins; the user confirms).
  onJoinInvite: (callback: (invite: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, invite: string) => { callback(invite); };
    ipcRenderer.on('app:joinInvite', handler);
    return () => { ipcRenderer.removeListener('app:joinInvite', handler); };
  },

  notifyReady: (): void => {
    ipcRenderer.send('app:rendererReady');
  },

  // Frameless-window controls for the custom HUD title bar.
  win: {
    minimize: (): void => ipcRenderer.send('win:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('win:toggleMaximize'),
    close: (): void => ipcRenderer.send('win:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('win:isMaximized'),
    onMaximizeChange: (callback: (max: boolean) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, max: boolean) => { callback(max); };
      ipcRenderer.on('win:maximizeChanged', handler);
      return () => { ipcRenderer.removeListener('win:maximizeChanged', handler); };
    },
    /**
     * A dock pop-out was CLOSED. Main is the only place that can see this
     * reliably: a window destroyed by the OS, by close-to-tray, or before its
     * renderer ever ran never gets to report its own death, and its panels would
     * be stranded in a window zone that no longer exists.
     */
    onPopoutClosed: (callback: (frameName: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, p: { frameName: string }) => { callback(p?.frameName ?? ''); };
      ipcRenderer.on('win:popoutClosed', handler);
      return () => { ipcRenderer.removeListener('win:popoutClosed', handler); };
    },
    /** A pop-out was REFUSED (pool exhausted / policy), with the reason, so the UI
     *  can say why instead of appearing to do nothing. */
    onPopoutDenied: (callback: (info: { frameName: string; reason: string }) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, p: { frameName: string; url: string; reason: string }) => {
        callback({ frameName: p?.frameName ?? '', reason: p?.reason ?? '' });
      };
      ipcRenderer.on('win:popoutDenied', handler);
      return () => { ipcRenderer.removeListener('win:popoutDenied', handler); };
    },

    /**
     * The same three controls, for a FRAMELESS dock pop-out — addressed BY FRAME
     * NAME, never by sender.
     *
     * A pop-out is an about:blank child the room window portals DOM into, so its
     * title bar's IPC leaves the MAIN renderer: `event.sender` is always the room
     * window and a sender-derived lookup in main would minimise the wrong window.
     * The frame name is already this window's identity everywhere else (allowlist,
     * saved bounds, toasterId, the popoutClosed payload).
     */
    popoutMinimize: (frameName: string): void => ipcRenderer.send('win:popoutMinimize', frameName),
    popoutToggleMaximize: (frameName: string): void => ipcRenderer.send('win:popoutToggleMaximize', frameName),
    popoutIsMaximized: (frameName: string): Promise<boolean> => ipcRenderer.invoke('win:popoutIsMaximized', frameName),
    /** A pop-out's maximise state flipped (button, double-click, or an OS gesture). */
    onPopoutMaximizeChange: (callback: (info: { frameName: string; maximized: boolean }) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, p: { frameName: string; maximized: boolean }) => {
        callback({ frameName: p?.frameName ?? '', maximized: !!p?.maximized });
      };
      ipcRenderer.on('win:popoutMaximizeChanged', handler);
      return () => { ipcRenderer.removeListener('win:popoutMaximizeChanged', handler); };
    },
    /**
     * Is the pointer inside one of this app's windows right now?
     *
     * The dock's drag-out tear-off asks this before committing: a tab released over
     * the room's head bar, a splitter, another dock window or a pop-out is not a
     * tear-off. The renderer cannot answer it — a drag event's screenX/screenY are
     * CSS px under a user-settable `webFrame` zoom, so they are not DIP, and a
     * renderer can only enumerate windows it opened itself.
     */
    pointerOverApp: (): Promise<boolean> => ipcRenderer.invoke('win:pointerOverApp'),
  },

  // Mirror the renderer's UI language to main so the tray, native dialogs, and
  // OS notifications localize too (renderer owns the setting via localStorage).
  setLanguage: (lang: string): void => {
    ipcRenderer.send('app:setLanguage', lang);
  },

  // UI scale. webFrame zoom scales the page INCLUDING the viewport, so
  // 100vh/100vw layouts keep filling the window — unlike CSS zoom, which
  // multiplies vh/vw sizes and clips (>100%) or leaves dead bands (<100%).
  setZoomFactor: (factor: number): void => {
    const f = Number(factor);
    if (Number.isFinite(f) && f >= 0.5 && f <= 2) webFrame.setZoomFactor(f);
  },

  // Resolve the absolute filesystem path of a dropped/selected File.
  // Electron >=30 exposes webUtils.getPathForFile; older versions still carry the
  // legacy File.path. Use whichever exists so drag & drop works across versions.
  getPathForFile: (file: File): string => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch {
      /* fall through to legacy File.path */
    }
    return (file as unknown as { path?: string }).path || '';
  },

  pauseAll: (): Promise<{ paused: number }> => {
    return ipcRenderer.invoke('downloads:pauseAll');
  },

  resumeAll: (): Promise<{ resumed: number }> => {
    return ipcRenderer.invoke('downloads:resumeAll');
  },

  setAltSpeed: (enabled: boolean): Promise<{ altSpeedEnabled: boolean }> => {
    return ipcRenderer.invoke('speed:setAlt', enabled);
  },

  getAltSpeed: (): Promise<{ altSpeedEnabled: boolean }> => {
    return ipcRenderer.invoke('speed:getAlt');
  },

  webRemote: {
    getInfo: () => ipcRenderer.invoke('webRemote:getInfo'),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('webRemote:setEnabled', enabled),
    regenToken: () => ipcRenderer.invoke('webRemote:regenToken'),
  },

  onVpnDropped: (callback: (info: { paused: number; rooms?: boolean; publicIP?: string }) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, info: { paused: number; rooms?: boolean; publicIP?: string }) => callback(info);
    ipcRenderer.on('app:vpnDropped', handler);
    return () => { ipcRenderer.removeListener('app:vpnDropped', handler); };
  },

  onVpnRestored: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('app:vpnRestored', handler);
    return () => { ipcRenderer.removeListener('app:vpnRestored', handler); };
  },

  // Engine VPN-bind lifecycle (lost / rebound / restored) from the guard
  onVpnBindStatus: (callback: (info: VpnBindEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, info: VpnBindEvent) => callback(info);
    ipcRenderer.on('app:vpnBindStatus', handler);
    return () => { ipcRenderer.removeListener('app:vpnBindStatus', handler); };
  },

  // Startup "VPN not detected" advisory (main → renderer, at most once per boot)
  onVpnWarning: (callback: (info: { publicIP?: string }) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, info: { publicIP?: string }) => callback(info);
    ipcRenderer.on('app:vpnWarning', handler);
    return () => { ipcRenderer.removeListener('app:vpnWarning', handler); };
  },

  // "Don't show again" on the startup VPN warning — persisted in main's config
  vpnWarningDismissed: (): void => {
    ipcRenderer.send('app:vpnWarningDismissed');
  },

  onDiskLow: (callback: (info: { paused: number; freeBytes: number; thresholdBytes: number }) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, info: { paused: number; freeBytes: number; thresholdBytes: number }) => callback(info);
    ipcRenderer.on('app:diskLow', handler);
    return () => { ipcRenderer.removeListener('app:diskLow', handler); };
  },

  onDiskRecovered: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('app:diskRecovered', handler);
    return () => { ipcRenderer.removeListener('app:diskRecovered', handler); };
  },

  // Priority 1: New torrent controls
  setSequentialDownload: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('downloads:setSequential', id, enabled),

  setFilePriority: (id: string, fileIndex: number, priority: string) =>
    ipcRenderer.invoke('downloads:setFilePriority', id, fileIndex, priority),

  setSeedRatioLimit: (id: string, ratio: number) =>
    ipcRenderer.invoke('downloads:setSeedRatio', id, ratio),

  setSeedTimeLimit: (id: string, minutes: number) =>
    ipcRenderer.invoke('downloads:setSeedTime', id, minutes),

  // Peers
  getPeers: (id: string) =>
    ipcRenderer.invoke('downloads:getPeers', id),

  // Swarm world map (peers grouped by country, across all active torrents)
  getSwarmGeo: () =>
    ipcRenderer.invoke('swarm:getGeo'),

  // Tracker management
  getTrackers: (id: string) =>
    ipcRenderer.invoke('downloads:getTrackers', id),

  addTracker: (id: string, url: string) =>
    ipcRenderer.invoke('downloads:addTracker', id, url),

  removeTracker: (id: string, url: string) =>
    ipcRenderer.invoke('downloads:removeTracker', id, url),

  // Watch folder
  getWatchFolderStatus: () =>
    ipcRenderer.invoke('watchFolder:getStatus'),

  setWatchFolder: (folderPath: string, enabled: boolean, deleteAfterAdd: boolean) =>
    ipcRenderer.invoke('watchFolder:set', folderPath, enabled, deleteAfterAdd),

  // Priority 2: RSS
  rss: {
    getFeeds: () => ipcRenderer.invoke('rss:getFeeds'),
    addFeed: (feed: any) => ipcRenderer.invoke('rss:addFeed', feed),
    updateFeed: (id: string, updates: any) => ipcRenderer.invoke('rss:updateFeed', id, updates),
    removeFeed: (id: string) => ipcRenderer.invoke('rss:removeFeed', id),
    checkFeed: (id: string) => ipcRenderer.invoke('rss:checkFeed', id),
    checkAll: () => ipcRenderer.invoke('rss:checkAll'),
    getItems: (feedId: string) => ipcRenderer.invoke('rss:getItems', feedId),
    markDownloaded: (guid: string) => ipcRenderer.invoke('rss:markDownloaded', guid),
    clearItems: (feedId?: string, onlyDownloaded?: boolean) => ipcRenderer.invoke('rss:clearItems', feedId, onlyDownloaded),
    markRead: (guids: string[], read?: boolean) => ipcRenderer.invoke('rss:markRead', guids, read),
    markFeedRead: (feedId?: string) => ipcRenderer.invoke('rss:markFeedRead', feedId),
    ignoreItems: (guids: string[], ignored?: boolean) => ipcRenderer.invoke('rss:ignoreItems', guids, ignored),
    exportOPML: () => ipcRenderer.invoke('rss:exportOPML'),
    importOPML: () => ipcRenderer.invoke('rss:importOPML'),
    getRules: () => ipcRenderer.invoke('rss:getRules'),
    addRule: (rule: any) => ipcRenderer.invoke('rss:addRule', rule),
    updateRule: (id: string, updates: any) => ipcRenderer.invoke('rss:updateRule', id, updates),
    removeRule: (id: string) => ipcRenderer.invoke('rss:removeRule', id),
    previewRule: (rule: any) => ipcRenderer.invoke('rss:previewRule', rule),
    runRule: (id: string) => ipcRenderer.invoke('rss:runRule', id),
  },

  // Priority 2: Search
  search: {
    start: (query: string, category?: string, refresh?: boolean) =>
      ipcRenderer.invoke('search:start', query, category, refresh),
    cancel: (searchId: string) => ipcRenderer.invoke('search:cancel', searchId),
    onProgress: (callback: (progress: SearchProgress) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, progress: SearchProgress) => callback(progress);
      ipcRenderer.on('search:progress', handler);
      return () => { ipcRenderer.removeListener('search:progress', handler); };
    },
    getProviders: () => ipcRenderer.invoke('search:getProviders'),
    addProvider: (provider: any) => ipcRenderer.invoke('search:addProvider', provider),
    updateProvider: (id: string, updates: any) => ipcRenderer.invoke('search:updateProvider', id, updates),
    removeProvider: (id: string) => ipcRenderer.invoke('search:removeProvider', id),
    testProvider: (id: string) => ipcRenderer.invoke('search:testProvider', id),
    getCategories: () => ipcRenderer.invoke('search:getCategories'),
    checkPython: (force?: boolean) => ipcRenderer.invoke('search:checkPython', force),
  },

  // Cast to a device on the LAN
  cast: {
    start: (id: string, fileIndex: number): Promise<{ url: string; lan: string; port: number } | null> =>
      ipcRenderer.invoke('cast:start', id, fileIndex),
    stop: (id: string, fileIndex: number): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('cast:stop', id, fileIndex),
    remoteStart: (id: string, fileIndex: number): Promise<{ url: string; sessionId: string }> =>
      ipcRenderer.invoke('cast:remoteStart', id, fileIndex),
    remoteStop: (sessionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('cast:remoteStop', sessionId),
    tvList: (): Promise<Array<{ name: string; host: string }>> => ipcRenderer.invoke('cast:tvList'),
    tvRefresh: (): Promise<Array<{ name: string; host: string }>> => ipcRenderer.invoke('cast:tvRefresh'),
    tvPlay: (id: string, fileIndex: number, host: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('cast:tvPlay', id, fileIndex, host),
    tvControl: (host: string, action: 'pause' | 'resume' | 'stop'): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('cast:tvControl', host, action),
  },

  // Subtitles
  subtitles: {
    list: (id: string, fileIndex: number): Promise<Array<{ key: string; label: string; lang?: string; source: 'embedded' | 'external' }>> =>
      ipcRenderer.invoke('subtitles:list', id, fileIndex),
    get: (id: string, fileIndex: number, key: string): Promise<string> =>
      ipcRenderer.invoke('subtitles:get', id, fileIndex, key),
  },

  // Audio tracks (multi-audio MKV)
  audioTracks: {
    list: (id: string, fileIndex: number): Promise<Array<{ index: number; label: string; lang?: string; isDefault?: boolean }>> =>
      ipcRenderer.invoke('audioTracks:list', id, fileIndex),
  },

  // Friend swarms / private rooms (Phase 3)
  rooms: {
    getProfile: (): Promise<RoomProfile> => ipcRenderer.invoke('rooms:getProfile'),
    setProfile: (updates: Partial<Pick<RoomProfile, 'name' | 'avatarSeed' | 'color' | 'status' | 'avatarImg'>>): Promise<RoomProfile> =>
      ipcRenderer.invoke('rooms:setProfile', updates),
    create: (name: string, e2e?: boolean): Promise<RoomState> => ipcRenderer.invoke('rooms:create', name, e2e),
    join: (code: string): Promise<RoomState> => ipcRenderer.invoke('rooms:join', code),
    leave: (roomId: string, deleteFiles?: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:leave', roomId, deleteFiles),
    list: (): Promise<RoomSummary[]> => ipcRenderer.invoke('rooms:list'),
    get: (roomId: string): Promise<RoomState | null> => ipcRenderer.invoke('rooms:get', roomId),
    addFiles: (roomId: string, paths: string[], folderId?: string): Promise<RoomState> => ipcRenderer.invoke('rooms:addFiles', roomId, paths, folderId),
    pickAndAddFiles: (roomId: string, folderId?: string): Promise<RoomState | null> => ipcRenderer.invoke('rooms:pickAndAddFiles', roomId, folderId),
    shareDownload: (roomId: string, downloadId: string, selectedPaths?: string[], folderName?: string): Promise<RoomState> =>
      ipcRenderer.invoke('rooms:shareDownload', roomId, downloadId, selectedPaths, folderName),
    listShareableFiles: (downloadId: string): Promise<{ files: Array<{ path: string; name: string; size: number }>; truncated: boolean; maxShare: number }> =>
      ipcRenderer.invoke('rooms:listShareableFiles', downloadId),
    openFolder: (roomId: string): Promise<void> => ipcRenderer.invoke('rooms:openFolder', roomId),
    openFile: (roomId: string, fileId: string): Promise<void> => ipcRenderer.invoke('rooms:openFile', roomId, fileId),
    revealFile: (roomId: string, fileId: string): Promise<void> => ipcRenderer.invoke('rooms:revealFile', roomId, fileId),
    watchFile: (roomId: string, fileId: string): Promise<{ directUrl: string; hlsUrl: string; playerUrl: string; coverUrl?: string; direct: boolean; kind: string; name: string; streaming?: boolean }> =>
      ipcRenderer.invoke('rooms:watchFile', roomId, fileId),
    imageUrl: (roomId: string, fileId: string): Promise<{ url: string }> =>
      ipcRenderer.invoke('rooms:imageUrl', roomId, fileId),
    subtitleList: (roomId: string, fileId: string): Promise<Array<{ key: string; label: string; lang?: string; source: 'embedded' | 'external' }>> =>
      ipcRenderer.invoke('rooms:subtitleList', roomId, fileId),
    subtitleGet: (roomId: string, fileId: string, key: string): Promise<string> =>
      ipcRenderer.invoke('rooms:subtitleGet', roomId, fileId, key),
    releaseFile: (roomId: string, fileId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:releaseFile', roomId, fileId),
    reseedFile: (roomId: string, fileId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:reseedFile', roomId, fileId),
    broadcastSync: (roomId: string, payload: { fileId: string; action: string; position: number; rate?: number; playing?: boolean; together?: boolean; emoji?: string }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:broadcastSync', roomId, payload),
    removeFile: (roomId: string, fileId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:removeFile', roomId, fileId),
    removeFiles: (roomId: string, fileIds: string[]): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:removeFiles', roomId, fileIds),
    rename: (roomId: string, name: string): Promise<RoomState> =>
      ipcRenderer.invoke('rooms:rename', roomId, name),
    setTopic: (roomId: string, text: string): Promise<RoomState> =>
      ipcRenderer.invoke('rooms:setTopic', roomId, text),
    requestFile: (roomId: string, text: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:requestFile', roomId, text),
    markRead: (roomId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:markRead', roomId),
    setActiveRoom: (roomId: string | null): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:setActiveRoom', roomId),
    voice: {
      join: (roomId: string): Promise<{ ok: boolean; warning?: string }> => ipcRenderer.invoke('rooms:voiceJoin', roomId),
      leave: (roomId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:voiceLeave', roomId),
      mute: (roomId: string, muted: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:voiceMute', roomId, muted),
      deafen: (roomId: string, deafened: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:voiceDeafen', roomId, deafened),
      volume: (roomId: string, memberId: string, volume: number): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:voiceVolume', roomId, memberId, volume),
      inputMode: (roomId: string, mode: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:voiceInputMode', roomId, mode),
      ptt: (roomId: string, active: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:voicePtt', roomId, active),
      settings: (settings: VoiceSettings): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:voiceSettings', settings),
      globalPtt: (enabled: boolean, code: string): Promise<{ ok: boolean; available: boolean; supported: boolean }> =>
        ipcRenderer.invoke('rooms:voiceGlobalPtt', enabled, code),
      devices: (): Promise<VoiceDeviceInfo[]> => ipcRenderer.invoke('rooms:voiceDevices'),
      micTestStart: (settings: VoiceSettings, monitor?: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:voiceMicTestStart', settings, monitor),
      micTestStop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:voiceMicTestStop'),
    },
    screen: {
      sources: (): Promise<ScreenSourceInfo[]> => ipcRenderer.invoke('rooms:screenSources'),
      shareStart: (roomId: string, sourceId: string, withAudio?: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:screenShareStart', roomId, sourceId, withAudio),
      shareStop: (roomId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:screenShareStop', roomId),
      watchStart: (roomId: string, memberId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:screenWatchStart', roomId, memberId),
      watchStop: (roomId: string, memberId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:screenWatchStop', roomId, memberId),
      signal: (roomId: string, memberId: string, kind: 'answer' | 'ice', data: unknown): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:screenSignal', roomId, memberId, kind, data),
    },
    // Serverless virtual-LAN (Havvn LAN) for games.
    lan: {
      start: (roomId: string, memberIds: string[]): Promise<{ ok: boolean; sessionId?: string; warning?: string }> =>
        ipcRenderer.invoke('rooms:lanStart', roomId, memberIds),
      stop: (roomId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:lanStop', roomId),
      invite: (roomId: string, memberId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:lanInvite', roomId, memberId),
      accept: (roomId: string): Promise<{ ok: boolean; warning?: string }> => ipcRenderer.invoke('rooms:lanAccept', roomId),
      evict: (roomId: string, memberId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:lanEvict', roomId, memberId),
      prefs: (roomId: string): Promise<LanRoomPrefs> => ipcRenderer.invoke('rooms:lanPrefs', roomId),
      diagnose: (roomId: string): Promise<LanDiagReport> => ipcRenderer.invoke('rooms:lanDiagnose', roomId),
      // Relay willingness is GLOBAL (one uplink, not one room) — no roomId.
      setRelay: (enabled: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:lanSetRelay', enabled),
      allowApp: (roomId: string): Promise<{ ok: boolean; canceled?: boolean; exe?: string; rule?: string; error?: string }> =>
        ipcRenderer.invoke('rooms:lanAllowApp', roomId),
    },
    // Game servers hosted inside a room (Minecraft and friends).
    servers: {
      state: (roomId: string): Promise<RoomServerState> => ipcRenderer.invoke('rooms:srvState', roomId),
      versions: (moduleId: string): Promise<GameVersionRef[]> => ipcRenderer.invoke('rooms:srvVersions', moduleId),
      legalGate: (moduleId: string): Promise<{ id: string; labelKey: string; url: string; accepted: boolean } | null> =>
        ipcRenderer.invoke('rooms:srvLegalGate', moduleId),
      acceptLegal: (moduleId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:srvAcceptLegal', moduleId),
      createForm: (roomId: string, moduleId: string): Promise<{ schema: ConfigField[]; values: Record<string, string> }> =>
        ipcRenderer.invoke('rooms:srvCreateForm', roomId, moduleId),
      create: (
        roomId: string, moduleId: string, refId: string, name?: string,
        config?: Record<string, string>,
      ): Promise<{ instanceId: string }> =>
        ipcRenderer.invoke('rooms:srvCreate', roomId, moduleId, refId, name, config),
      pickImport: (moduleId: string) => ipcRenderer.invoke('rooms:srvPickImport', moduleId),
      discardImport: (stagingId: string): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvDiscardImport', stagingId),
      createImported: (
        roomId: string, moduleId: string, stagingId: string, candidateId: string,
        name?: string, javaMajor?: number,
      ): Promise<{ instanceId: string }> =>
        ipcRenderer.invoke('rooms:srvCreateImported', roomId, moduleId, stagingId, candidateId, name, javaMajor),
      remove: (instanceId: string, deleteFiles: boolean): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvDelete', instanceId, deleteFiles),
      start: (instanceId: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('rooms:srvStart', instanceId),
      stop: (instanceId: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('rooms:srvStop', instanceId),
      restart: (instanceId: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('rooms:srvRestart', instanceId),
      reinstall: (instanceId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:srvInstall', instanceId),
      cancelInstall: (instanceId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:srvCancelInstall', instanceId),
      checkUpdate: (instanceId: string): Promise<{ current: string; available: string | null }> =>
        ipcRenderer.invoke('rooms:srvCheckUpdate', instanceId),
      applyUpdate: (instanceId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:srvApplyUpdate', instanceId),
      command: (instanceId: string, command: string, roomId?: string): Promise<{ ok: boolean; reason?: string }> =>
        ipcRenderer.invoke('rooms:srvCommand', instanceId, command, roomId),
      clearFailure: (instanceId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:srvClearFailure', instanceId),
      setAutoRestart: (instanceId: string, enabled: boolean): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvSetAutoRestart', instanceId, enabled),
      getConfig: (instanceId: string): Promise<{ schema: ConfigField[]; values: Record<string, string> }> =>
        ipcRenderer.invoke('rooms:srvGetConfig', instanceId),
      saveConfig: (instanceId: string, values: Record<string, string>): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvSaveConfig', instanceId, values),
      openFolder: (instanceId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:srvOpenFolder', instanceId),
      /** Console lines newer than `after`; the renderer keeps the last seq it saw. */
      console: (instanceId: string, after?: number, roomId?: string): Promise<ConsoleLine[]> =>
        ipcRenderer.invoke('rooms:srvConsole', instanceId, after ?? 0, roomId),
      /** Live console tail. Main only streams while at least one listener is
       *  attached, so a closed panel costs nothing. */
      onConsole: (cb: (payload: { instanceId: string; lines: ConsoleLine[] }) => void): (() => void) => {
        const listener = (_e: unknown, payload: { instanceId: string; lines: ConsoleLine[] }): void => cb(payload);
        ipcRenderer.on('rooms:srvConsoleLines', listener);
        return () => { ipcRenderer.removeListener('rooms:srvConsoleLines', listener); };
      },
      watchConsole: (instanceId: string | null): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvWatchConsole', instanceId),
      content: (instanceId: string): Promise<ServerContentState> =>
        ipcRenderer.invoke('rooms:srvContent', instanceId),
      setContentFolder: (instanceId: string, slotId: string, folderId: string): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvSetContentFolder', instanceId, slotId, folderId),
      clearContentFolder: (instanceId: string, slotId: string): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvClearContentFolder', instanceId, slotId),
      syncContent: (instanceId: string): Promise<ServerContentState> =>
        ipcRenderer.invoke('rooms:srvSyncContent', instanceId),
      consentContent: (hashes: string[]): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvConsentContent', hashes),
      roomFolders: (roomId: string): Promise<Array<{ id: string; name: string }>> =>
        ipcRenderer.invoke('rooms:srvRoomFolders', roomId),
      schedule: (instanceId: string): Promise<ServerScheduleState> =>
        ipcRenderer.invoke('rooms:srvSchedule', instanceId),
      setScheduleEnabled: (instanceId: string, enabled: boolean): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvSetScheduleEnabled', instanceId, enabled),
      saveSchedule: (instanceId: string, rules: ServerScheduleRule[]): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvSaveSchedule', instanceId, rules),
      access: (instanceId: string): Promise<ServerAccessState> =>
        ipcRenderer.invoke('rooms:srvAccess', instanceId),
      grantOperator: (instanceId: string, memberId: string): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvGrantOperator', instanceId, memberId),
      revokeOperator: (instanceId: string, memberId: string): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvRevokeOperator', instanceId, memberId),
      backups: (instanceId: string) => ipcRenderer.invoke('rooms:srvBackups', instanceId),
      createBackup: (instanceId: string, label?: string) =>
        ipcRenderer.invoke('rooms:srvCreateBackup', instanceId, label),
      restoreBackup: (instanceId: string, backupId: string) =>
        ipcRenderer.invoke('rooms:srvRestoreBackup', instanceId, backupId),
      deleteBackup: (instanceId: string, backupId: string) =>
        ipcRenderer.invoke('rooms:srvDeleteBackup', instanceId, backupId),
      openBackupsFolder: (instanceId: string): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvOpenBackups', instanceId),
      players: (instanceId: string) => ipcRenderer.invoke('rooms:srvPlayers', instanceId),
      savePlayers: (instanceId: string, patch: object): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvSavePlayers', instanceId, patch),
      setUseSystemJava: (instanceId: string, enabled: boolean): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvSetUseSystemJava', instanceId, enabled),
      setContentAutoSync: (instanceId: string, enabled: boolean): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('rooms:srvSetContentAutoSync', instanceId, enabled),
      systemJava: (): Promise<{ available: boolean; version?: string; major?: number }> =>
        ipcRenderer.invoke('rooms:srvSystemJava'),
      /** Pushed whenever anything about a room's servers changed. */
      onUpdate: (cb: (payload: { roomId: string; state: RoomServerState }) => void): (() => void) => {
        const listener = (_e: unknown, payload: { roomId: string; state: RoomServerState }): void => cb(payload);
        ipcRenderer.on('rooms:srvUpdate', listener);
        return () => { ipcRenderer.removeListener('rooms:srvUpdate', listener); };
      },
    },
    createFolder: (roomId: string, name: string, icon: string, color: string, parentId?: string): Promise<RoomState> =>
      ipcRenderer.invoke('rooms:createFolder', roomId, name, icon, color, parentId),
    updateFolder: (roomId: string, folderId: string, patch: { name?: string; icon?: string; color?: string; parentId?: string | null }): Promise<RoomState> =>
      ipcRenderer.invoke('rooms:updateFolder', roomId, folderId, patch),
    deleteFolder: (roomId: string, folderId: string): Promise<RoomState> =>
      ipcRenderer.invoke('rooms:deleteFolder', roomId, folderId),
    assignFile: (roomId: string, fileId: string, folderId: string | null): Promise<RoomState> =>
      ipcRenderer.invoke('rooms:assignFile', roomId, fileId, folderId),
    assignFiles: (roomId: string, fileIds: string[], folderId: string | null): Promise<RoomState> =>
      ipcRenderer.invoke('rooms:assignFiles', roomId, fileIds, folderId),
    setFolderAutoFetch: (roomId: string, folderId: string, mode: boolean | null): Promise<RoomState> =>
      ipcRenderer.invoke('rooms:setFolderAutoFetch', roomId, folderId, mode),
    setMuted: (roomId: string, memberId: string, muted: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:setMuted', roomId, memberId, muted),
    setAutoFetch: (roomId: string, autoFetch: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:setAutoFetch', roomId, autoFetch),
    setNotifyMuted: (roomId: string, muted: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:setNotifyMuted', roomId, muted),
    fetchFile: (roomId: string, fileId: string): Promise<RoomState> =>
      ipcRenderer.invoke('rooms:fetchFile', roomId, fileId),
    setLimits: (roomId: string, upKbps: number, downKbps: number): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:setLimits', roomId, upKbps, downKbps),
    kick: (roomId: string, memberId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:kick', roomId, memberId),
    transferOwner: (roomId: string, memberId: string): Promise<RoomState> =>
      ipcRenderer.invoke('rooms:transferOwner', roomId, memberId),
    sendChat: (roomId: string, text: string, replyTo?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:sendChat', roomId, text, replyTo),
    editChat: (roomId: string, msgId: string, text: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:editChat', roomId, msgId, text),
    typing: (roomId: string): void => {
      // Fire-and-forget liveness ping — the engine rate-limits the broadcast.
      ipcRenderer.invoke('rooms:typing', roomId).catch(() => { /* ignore */ });
    },
    reactFile: (roomId: string, fileId: string, emoji: string): Promise<void> =>
      ipcRenderer.invoke('rooms:reactFile', roomId, fileId, emoji),
    reactChat: (roomId: string, msgId: string, emoji: string): Promise<void> =>
      ipcRenderer.invoke('rooms:reactChat', roomId, msgId, emoji),
    exportIdentity: (): Promise<{ success: boolean; path?: string }> =>
      ipcRenderer.invoke('rooms:exportIdentity'),
    importIdentity: (): Promise<{ success: boolean; rooms?: number }> =>
      ipcRenderer.invoke('rooms:importIdentity'),
  },

  // Custom theme sharing (import/export as a JSON file)
  themes: {
    export: (theme: unknown, suggestedName?: string): Promise<{ success: boolean; path?: string }> =>
      ipcRenderer.invoke('themes:export', theme, suggestedName),
    import: (): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke('themes:import'),
  },

  onRoomUpdate: (callback: (state: RoomState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: RoomState) => callback(state);
    ipcRenderer.on('rooms:update', handler);
    return () => { ipcRenderer.removeListener('rooms:update', handler); };
  },

  onRoomSync: (callback: (msg: { roomId: string; fileId: string; action: string; position: number; rate: number; at: number; memberId: string; name: string; avatarSeed?: string; playing?: boolean; together?: boolean; emoji?: string }) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, msg: any) => callback(msg);
    ipcRenderer.on('rooms:sync', handler);
    return () => { ipcRenderer.removeListener('rooms:sync', handler); };
  },

  // The user clicked a room notification — open that room.
  onRoomOpen: (callback: (roomId: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, msg: { roomId: string }) => callback(msg?.roomId);
    ipcRenderer.on('rooms:open', handler);
    return () => { ipcRenderer.removeListener('rooms:open', handler); };
  },

  // Live mic level (0-255, post-gain) while a settings-modal mic test runs.
  onVoiceMicLevel: (callback: (level: number) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, level: number) => callback(level);
    ipcRenderer.on('rooms:micLevel', handler);
    return () => { ipcRenderer.removeListener('rooms:micLevel', handler); };
  },

  // Audio hardware changed — refresh the device pickers.
  onVoiceDevicesChanged: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('rooms:voiceDevicesChanged', handler);
    return () => { ipcRenderer.removeListener('rooms:voiceDevicesChanged', handler); };
  },

  // Transient voice warning (e.g. a mid-call mic fell back to the default device).
  onVoiceWarning: (callback: (msg: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, msg: string) => callback(msg);
    ipcRenderer.on('rooms:voiceWarn', handler);
    return () => { ipcRenderer.removeListener('rooms:voiceWarn', handler); };
  },

  // Transient LAN warning (UAC cancelled, helper crashed, driver missing, direct
  // connection failed). LAN state itself rides onRoomUpdate — no separate channel.
  onLanWarning: (callback: (msg: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, msg: string) => callback(msg);
    ipcRenderer.on('rooms:lanWarn', handler);
    return () => { ipcRenderer.removeListener('rooms:lanWarn', handler); };
  },

  onServerAlert: (callback: (payload: { roomId: string } & import('../shared/gameserver-types').ServerAlert) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: { roomId: string } & import('../shared/gameserver-types').ServerAlert) => callback(payload);
    ipcRenderer.on('rooms:srvAlert', handler);
    return () => { ipcRenderer.removeListener('rooms:srvAlert', handler); };
  },

  // Screen-watch loopback signaling from the engine forwarder (offer/ice/end).
  onRoomScreenSignal: (callback: (msg: { roomId: string; memberId: string; kind: 'offer' | 'ice' | 'end'; data?: unknown }) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, msg: any) => callback(msg);
    ipcRenderer.on('rooms:screenSignal', handler);
    return () => { ipcRenderer.removeListener('rooms:screenSignal', handler); };
  },

  // Priority 2: IP Blocklist
  blocklist: {
    getAll: () => ipcRenderer.invoke('blocklist:getAll'),
    add: (name: string, url: string) => ipcRenderer.invoke('blocklist:add', name, url),
    remove: (id: string) => ipcRenderer.invoke('blocklist:remove', id),
    update: (id: string) => ipcRenderer.invoke('blocklist:update', id),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('blocklist:setEnabled', id, enabled),
  },
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('api', api);

