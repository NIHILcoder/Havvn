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
} from '../shared/types';

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

  getStreamUrl: (id: string, fileIndex: number, opts?: { transcode?: boolean }): Promise<{ url: string; name: string; kind: 'video' | 'audio' | 'other'; transcoded: boolean }> => {
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

  notifyReady: (): void => {
    ipcRenderer.send('app:rendererReady');
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

  onVpnDropped: (callback: (info: { paused: number; publicIP?: string }) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, info: { paused: number; publicIP?: string }) => callback(info);
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
  },

  // Priority 2: Search
  search: {
    query: (query: string, category?: string) => ipcRenderer.invoke('search:query', query, category),
    getProviders: () => ipcRenderer.invoke('search:getProviders'),
    addProvider: (provider: any) => ipcRenderer.invoke('search:addProvider', provider),
    updateProvider: (id: string, updates: any) => ipcRenderer.invoke('search:updateProvider', id, updates),
    removeProvider: (id: string) => ipcRenderer.invoke('search:removeProvider', id),
    testProvider: (id: string) => ipcRenderer.invoke('search:testProvider', id),
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

  // Friend swarms / private rooms (Phase 3)
  rooms: {
    getProfile: (): Promise<RoomProfile> => ipcRenderer.invoke('rooms:getProfile'),
    setProfile: (updates: Partial<Pick<RoomProfile, 'name' | 'avatarSeed'>>): Promise<RoomProfile> =>
      ipcRenderer.invoke('rooms:setProfile', updates),
    create: (name: string, e2e?: boolean): Promise<RoomState> => ipcRenderer.invoke('rooms:create', name, e2e),
    join: (code: string): Promise<RoomState> => ipcRenderer.invoke('rooms:join', code),
    leave: (roomId: string, deleteFiles?: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('rooms:leave', roomId, deleteFiles),
    list: (): Promise<RoomSummary[]> => ipcRenderer.invoke('rooms:list'),
    get: (roomId: string): Promise<RoomState | null> => ipcRenderer.invoke('rooms:get', roomId),
    addFiles: (roomId: string, paths: string[]): Promise<RoomState> => ipcRenderer.invoke('rooms:addFiles', roomId, paths),
    pickAndAddFiles: (roomId: string): Promise<RoomState | null> => ipcRenderer.invoke('rooms:pickAndAddFiles', roomId),
    shareDownload: (roomId: string, downloadId: string, selectedPaths?: string[]): Promise<RoomState> =>
      ipcRenderer.invoke('rooms:shareDownload', roomId, downloadId, selectedPaths),
    listShareableFiles: (downloadId: string): Promise<{ files: Array<{ path: string; name: string; size: number }>; truncated: boolean; maxShare: number }> =>
      ipcRenderer.invoke('rooms:listShareableFiles', downloadId),
    openFolder: (roomId: string): Promise<void> => ipcRenderer.invoke('rooms:openFolder', roomId),
    openFile: (roomId: string, fileId: string): Promise<void> => ipcRenderer.invoke('rooms:openFile', roomId, fileId),
    watchFile: (roomId: string, fileId: string): Promise<{ directUrl: string; hlsUrl: string; playerUrl: string; coverUrl?: string; direct: boolean; kind: string; name: string }> =>
      ipcRenderer.invoke('rooms:watchFile', roomId, fileId),
    broadcastSync: (roomId: string, payload: { fileId: string; action: string; position: number; rate?: number; playing?: boolean; together?: boolean; emoji?: string }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:broadcastSync', roomId, payload),
    removeFile: (roomId: string, fileId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:removeFile', roomId, fileId),
    setMuted: (roomId: string, memberId: string, muted: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:setMuted', roomId, memberId, muted),
    setAutoFetch: (roomId: string, autoFetch: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:setAutoFetch', roomId, autoFetch),
    fetchFile: (roomId: string, fileId: string): Promise<RoomState> =>
      ipcRenderer.invoke('rooms:fetchFile', roomId, fileId),
    setLimits: (roomId: string, upKbps: number, downKbps: number): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:setLimits', roomId, upKbps, downKbps),
    kick: (roomId: string, memberId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:kick', roomId, memberId),
    sendChat: (roomId: string, text: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rooms:sendChat', roomId, text),
    typing: (roomId: string): void => {
      // Fire-and-forget liveness ping — the engine rate-limits the broadcast.
      ipcRenderer.invoke('rooms:typing', roomId).catch(() => { /* ignore */ });
    },
    reactFile: (roomId: string, fileId: string, emoji: string): Promise<void> =>
      ipcRenderer.invoke('rooms:reactFile', roomId, fileId, emoji),
    exportIdentity: (): Promise<{ success: boolean; path?: string }> =>
      ipcRenderer.invoke('rooms:exportIdentity'),
    importIdentity: (): Promise<{ success: boolean; rooms?: number }> =>
      ipcRenderer.invoke('rooms:importIdentity'),
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

