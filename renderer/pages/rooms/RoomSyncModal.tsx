import { ErrorMessage } from '../../components/ErrorMessage';
import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { RoomToolSurface, type EmbeddedRoomTool } from './RoomToolSurface';
import { Toggle } from '../../components/Toggle';
import { NumberInput } from '../../components/NumberInput';
import { Icon } from '../../components/Icon';
import { RoomSyncMode, SyncModePicker } from './RoomSyncMode';
import type { SyncMode } from '../../../shared/room-file-sync-ui';
import { useTranslation } from '../../utils/i18nContext';
import { useHostWindow } from '../../utils/hostWindow';
import { useVisibleWork } from '../../utils/visible-work';
import { formatBytes } from '../../utils/format-helpers';
import type { SyncRoomView, SyncFilesPage, SyncFolderPreview, SyncLocalAction, SyncHistoryPage, SyncRestorePreview, SyncCacheView, SyncConflictPreview, SyncConflictChoice } from '../../../shared/room-file-sync-ui';
import { validSyncBackupPolicy, type SyncBackupPreview, type SyncBackupPolicy } from '../../../shared/room-file-sync-backups';
import { validSyncExclusions, type SyncFilterPreview } from '../../../shared/room-file-sync-filters';
import type { SyncRightsPreview, SyncMovePreview, SyncLogPreview, SyncCheckpointPreview, SyncDeletePreview } from '../../../shared/room-file-sync-ui';
import type { SyncPathConflict, SyncPathPreview } from '../../../shared/room-file-sync-ui';
import type { SyncMetadataView, SyncMissingView, SyncTrashView } from '../../../shared/room-file-sync-ui';
import { SYNC_TRASH_SELECTION_LIMIT } from '../../../shared/room-file-sync-ui';
import { validSyncRelativePath } from '../../../shared/room-file-sync';
import type { SyncEditorDraft } from '../../../shared/room-file-sync-editor';
import './RoomSyncModal.css';
import { RoomObjectCopy } from '../../components/RoomObjectCopy';
const RoomFileEditorModal = lazy(() => import('./RoomFileEditorModal').then(module => ({ default: module.RoomFileEditorModal })));

export function RoomSyncModal({ roomId, onClose, initialRootId, initialEntryId, initialRevisionId, initialDeleteEntryId, initialPathEntryId, initialMissing, initialTrashStorage, initialStorage, embedded, registerClose, onOpenEditor }: { roomId: string; onClose(): void; initialRootId?: string; initialEntryId?: string; initialRevisionId?: string; initialDeleteEntryId?: string; initialPathEntryId?: string; initialMissing?: boolean; initialTrashStorage?: boolean; initialStorage?: 'cache' | 'backups'; onOpenEditor?(draft: SyncEditorDraft): void } & EmbeddedRoomTool) {
  const { t } = useTranslation(), host = useHostWindow();
  const visible = useVisibleWork();
  const [view, setView] = useState<SyncRoomView | null>(null), [preview, setPreview] = useState<SyncFolderPreview | null>(null);
  const [name, setName] = useState(''), [selected, setSelected] = useState<string | null>(initialRootId ?? null), [offset, setOffset] = useState(0);
  const [page, setPage] = useState<SyncFilesPage | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [deletion, setDeletion] = useState<SyncDeletePreview | null>(null), [trashRoot, setTrashRoot] = useState<string | null>(null);
  const [missing, setMissing] = useState<SyncMissingView | null>(null), [missingMass, setMissingMass] = useState(false);
  const [trashStorage, setTrashStorage] = useState<SyncTrashView | null>(null), [trashSelected, setTrashSelected] = useState<string[]>([]);
  const [trashReviewed, setTrashReviewed] = useState(false), [trashOffset, setTrashOffset] = useState(0), [trashNotice, setTrashNotice] = useState('');
  const [lastTrashExport, setLastTrashExport] = useState<{ rootId: string; path: string } | null>(null);
  const [paths, setPaths] = useState<SyncPathConflict | null>(null), [pathVersion, setPathVersion] = useState(''), [pathName, setPathName] = useState('');
  const [pathReview, setPathReview] = useState<SyncPathPreview | null>(null);
  const reviewedPath = !!pathReview && pathReview.revisionId === pathVersion && pathReview.toPath === pathName;
  const [historyTarget, setHistoryTarget] = useState<{ rootId: string; entryId: string; offset: number } | null>(initialRootId && initialEntryId ? { rootId: initialRootId, entryId: initialEntryId, offset: 0 } : null);
  const [history, setHistory] = useState<SyncHistoryPage | null>(null), [restore, setRestore] = useState<SyncRestorePreview | null>(null);
  const [cache, setCache] = useState<Record<string, SyncCacheView>>({}), [limits, setLimits] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<SyncConflictPreview | null>(null), [resolvedCopy, setResolvedCopy] = useState<string | null>(null);
  const [backups, setBackups] = useState<SyncBackupPreview | null>(null), [backupOffset, setBackupOffset] = useState(0);
  const [backupFields, setBackupFields] = useState({ enabled: false, versions: '', days: '', mib: '' }), [backupNotice, setBackupNotice] = useState('');
  const [filters, setFilters] = useState<SyncFilterPreview | null>(null), [filterText, setFilterText] = useState(''), [filterOffset, setFilterOffset] = useState(0);
  const [filterNotice, setFilterNotice] = useState('');
  const [rights, setRights] = useState<SyncRightsPreview | null>(null), [writers, setWriters] = useState<string[]>([]);
  const [moves, setMoves] = useState(false);
  const [deletes, setDeletes] = useState(false);
  const reviewedRights = !!rights?.previewId && moves === rights.moves && deletes === !!rights.deletes && JSON.stringify([...writers].sort()) === JSON.stringify(rights.selected);
  const [moveTarget, setMoveTarget] = useState<{ rootId: string; entryId: string; path: string } | null>(null), [movePath, setMovePath] = useState('');
  const [moveReview, setMoveReview] = useState<SyncMovePreview | null>(null);
  const reviewedMove = !!moveReview && moveReview.toPath === movePath && moveTarget?.entryId === moveReview.entryId;
  const [editorDraft, setEditorDraft] = useState<SyncEditorDraft | null>(null);
  const [log, setLog] = useState<SyncLogPreview | null>(null), [logNotice, setLogNotice] = useState('');
  const [metadata, setMetadata] = useState<SyncMetadataView | null>(null), [metadataKeep, setMetadataKeep] = useState('2');
  const [metadataPassword, setMetadataPassword] = useState(''), [metadataRepeat, setMetadataRepeat] = useState(''), [metadataNotice, setMetadataNotice] = useState('');
  const reviewedMetadata = !!metadata && metadata.keep === Number(metadataKeep) && metadataKeep.trim() !== '';
  const [checkpoint, setCheckpoint] = useState<SyncCheckpointPreview | null>(null);
  const [historyNotice, setHistoryNotice] = useState('');
  useEffect(() => { setHistoryNotice(''); }, [historyTarget?.rootId, historyTarget?.entryId]);
  const filterRules = filterText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const validFilters = validSyncExclusions(filterRules), reviewedFilters = !!filters?.previewId && !filters.scanError && validFilters && JSON.stringify(filterRules) === JSON.stringify(filters.rules);
  const backupPolicy: SyncBackupPolicy = { enabled: backupFields.enabled, keepVersions: Number(backupFields.versions), maxAgeDays: Number(backupFields.days), limitBytes: Number(backupFields.mib) * 1024 ** 2 };
  const validBackups = Object.values(backupFields).every(v => typeof v !== 'string' || v.trim() !== '') && validSyncBackupPolicy(backupPolicy);
  const reviewedBackups = !!backups && validBackups && (Object.keys(backupPolicy) as Array<keyof SyncBackupPolicy>).every(k => backupPolicy[k] === backups.policy[k]);
  const generation = useRef(0), mounted = useRef(true), operation = useRef(false);
  useEffect(() => { registerClose?.(() => !operation.current); return () => registerClose?.(null); }, [registerClose]);
  const invalidate = useCallback(() => { mounted.current = false; generation.current++; }, []);
  const refresh = useCallback(async (force = false) => {
    if (operation.current && !force) return;
    const current = ++generation.current;
    try {
      const state = await window.api.rooms.fileSync.state(roomId);
      const files = selected && state.roots.some(root => root.rootId === selected && !root.paused)
        ? await window.api.rooms.fileSync.files(roomId, selected, offset, trashRoot === selected) : null;
      const versions = historyTarget && state.roots.some(root => root.rootId === historyTarget.rootId && !root.paused)
        ? await window.api.rooms.fileSync.history(roomId, historyTarget.rootId, historyTarget.entryId, historyTarget.offset) : null;
      if (!mounted.current || generation.current !== current) return;
      setView(state); setPage(files); setHistory(versions);
    } catch (cause) { if (mounted.current && generation.current === current) setError(String(cause instanceof Error ? cause.message : cause)); }
  }, [roomId, selected, offset, historyTarget, trashRoot]);
  useEffect(() => {
    mounted.current = true; return invalidate;
  }, [invalidate]);
  useEffect(() => {
    if (!visible) return;
    const revision = generation;
    void refresh();
    const timer = host.window.setInterval(() => { void refresh(); }, 2000);
    return () => { revision.current++; host.window.clearInterval(timer); };
  }, [refresh, host, visible]);
  const work = useCallback(async (action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; generation.current++; setBusy(true); setError('');
    try { await action(); if (mounted.current) await refresh(true); }
    catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      if (mounted.current) setError(message.includes('Trash export destination already exists') ? t('rooms.sync.trashExportExists')
        : message.includes('Trash export destination is managed') || message.includes('Invalid trash export destination') ? t('rooms.sync.trashExportOutside')
        : message.includes('Trash export receipt failed') ? t('rooms.sync.trashExportReceiptFailed')
        : message.includes('Trash export receipt capacity reached') ? t('rooms.sync.trashExportLimit')
        : message.includes('Trash export write failed') ? t('rooms.sync.trashExportFailed')
        : message.includes('Trash export changed') || message.includes('Trash copy is not exportable') || message.includes('Trash cleanup changed') || message.includes('Trash preview expired') || message.includes('Trash recovery copy changed') ? t('rooms.sync.trashStorageChanged')
        : message.includes('Trash binding unavailable') ? t('rooms.sync.trashStorageUnavailable')
        : message.includes('Sync missing files changed') ? t('rooms.sync.missingChanged')
        : message.includes('Sync metadata changed') || message.includes('Sync metadata protection changed') || message.includes('Sync recovery changed') || message.includes('Sync metadata preview expired') ? t('rooms.sync.metadataChanged')
        : message.includes('Incorrect password or damaged room backup') ? t('rooms.sync.metadataBadPassword')
        : message.includes('Invalid or foreign sync history export') ? t('rooms.sync.metadataForeign')
        : message.includes('Save history outside shared folders') ? t('rooms.sync.metadataOutside')
        : message.includes('Sync history export destination already exists') ? t('rooms.sync.metadataExists')
        : message.includes('Sync history export changed') || message.includes('Export the current signed history') ? t('rooms.sync.metadataExportNeeded')
        : message.includes('Sync destination already exists') ? t('rooms.sync.pathOccupied')
        : message.includes('Choose a free, included path outside the conflicting paths') ? t('rooms.sync.pathUnavailable')
        : message.includes('Sync path preview changed') || message.includes('Sync path preview expired') || message.includes('Sync path conflict unavailable')
          || message.includes('A bound writer with a current path conflict is required') ? t('rooms.sync.pathChanged') : message);
    }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }, [refresh, t]);
  const loadTrashStorage = useCallback((rootId: string, selected: string[] = []) => work(async () => {
    const result = await window.api.rooms.fileSync.trashPreview(roomId, rootId, selected);
    if (mounted.current) { setTrashStorage(result); setTrashSelected([...selected]); setTrashReviewed(selected.length > 0); setTrashOffset(0); setTrashNotice(''); }
  }), [roomId, work]);
  const initialTrashRequested = useRef(false);
  useEffect(() => {
    if (!initialTrashStorage || !initialRootId || initialTrashRequested.current) return;
    initialTrashRequested.current = true; void loadTrashStorage(initialRootId);
  }, [initialTrashStorage, initialRootId, loadTrashStorage]);
  const trashStoragePage = (offset: number) => work(async () => {
    if (!trashStorage) return; const result = await window.api.rooms.fileSync.trashPage(roomId, trashStorage.previewId, offset);
    if (mounted.current) { setTrashStorage(result); setTrashOffset(offset); }
  });
  const loadMissing = useCallback((rootId: string) => work(async () => {
    const result = await window.api.rooms.fileSync.missing(roomId, rootId);
    if (mounted.current) { setMissing(result); setMissingMass(false); }
  }), [roomId, work]);
  const initialMissingRequested = useRef(false);
  useEffect(() => {
    if (!initialMissing || !initialRootId || initialMissingRequested.current) return;
    initialMissingRequested.current = true; void loadMissing(initialRootId);
  }, [initialMissing, initialRootId, loadMissing]);
  const missingRoot = missing?.rootId;
  useEffect(() => {
    if (!missingRoot) return;
    let alive = true, running = false;
    const timer = host.window.setInterval(() => {
      if (operation.current || running) return;
      running = true;
      void window.api.rooms.fileSync.missing(roomId, missingRoot).then(result => {
        if (alive && mounted.current && !operation.current) setMissing(old => old?.rootId === missingRoot ? result : old);
      }).catch(() => { /* Manual review reports errors through the normal action state. */ }).finally(() => { running = false; });
    }, 2000);
    return () => { alive = false; host.window.clearInterval(timer); };
  }, [missingRoot, host, roomId]);
  useEffect(() => { setMissingMass(false); }, [missing?.stamp]);
  const initialDeleteRequested = useRef(false);
  useEffect(() => {
    if (!initialRootId || !initialDeleteEntryId || initialDeleteRequested.current) return;
    initialDeleteRequested.current = true;
    void work(async () => { const result = await window.api.rooms.fileSync.prepareDelete(roomId, initialRootId, initialDeleteEntryId); if (mounted.current) setDeletion(result); });
  }, [initialRootId, initialDeleteEntryId, roomId, work]);
  const loadPaths = useCallback((rootId: string, entryId: string) => work(async () => {
    const result = await window.api.rooms.fileSync.pathConflict(roomId, rootId, entryId);
    if (mounted.current) { setPaths(result); setPathVersion(result.versions[0].revisionId); setPathName(result.suggestedPath); setPathReview(null); }
  }), [roomId, work]);
  const initialPathRequested = useRef(false);
  useEffect(() => {
    if (!initialRootId || !initialPathEntryId || initialPathRequested.current) return;
    initialPathRequested.current = true; void loadPaths(initialRootId, initialPathEntryId);
  }, [initialRootId, initialPathEntryId, loadPaths]);
  const loadDelete = (rootId: string, entryId: string, resolve = false) => work(async () => {
    const result = await window.api.rooms.fileSync.prepareDelete(roomId, rootId, entryId, resolve); if (mounted.current) setDeletion(result);
  });
  const confirmDelete = (keepBoth = false) => work(async () => {
    if (!deletion) return;
    const result = await window.api.rooms.fileSync.confirmDelete(roomId, deletion.previewId, keepBoth);
    if (mounted.current) { setDeletion(null); setResolvedCopy(result.copyPath); setCache({}); }
  });
  const action = (rootId: string, kind: SyncLocalAction, enabled?: boolean) => work(async () => {
    const state = await window.api.rooms.fileSync.action(roomId, rootId, kind, enabled);
    if (mounted.current) setView(state);
  });
  const choose = (rootId?: string) => work(async () => {
    const picked = await window.api.rooms.fileSync.choose(roomId, rootId ? { kind: 'bind', rootId } : { kind: 'create', name: name.trim() });
    if (mounted.current && picked) { setConnectionMode(rootId ? view?.roots.find(r => r.rootId === rootId)?.publisher ? 'sync' : 'receive' : 'send'); setPreview(picked); }
  });
  const [connectionMode, setConnectionMode] = useState<SyncMode>('receive');
  const connect = () => work(async () => {
    if (!preview) return;
    const previous = new Set(view?.roots.map(r => r.rootId));
    const state = await window.api.rooms.fileSync.confirm(roomId, preview.previewId);
    if (mounted.current) { setView(state); setPreview(null); setName(''); }
    const root = preview.rootId ? state.roots.find(r => r.rootId === preview.rootId)
      : state.roots.find(r => !previous.has(r.rootId) && r.path === preview.path && r.name === preview.name);
    if (root && connectionMode !== 'manual') {
      const next = await window.api.rooms.fileSync.action(roomId, root.rootId, `mode-${connectionMode}`);
      if (mounted.current) setView(next);
    }
  });
  const loadCache = useCallback((rootId: string, save = false) => work(async () => {
    const value = save ? Number(limits[rootId]) * 1024 * 1024 : undefined;
    const result = await window.api.rooms.fileSync.cache(roomId, rootId, value);
    if (mounted.current) { setCache(old => ({ ...old, [rootId]: result })); setLimits(old => ({ ...old, [rootId]: String(result.limitBytes / 1024 / 1024) })); }
  }), [roomId, limits, work]);
  const loadBackups = useCallback((rootId: string, policy?: SyncBackupPolicy) => work(async () => {
    const result = await window.api.rooms.fileSync.backups(roomId, rootId, policy);
    if (mounted.current) {
      setBackups(result); setBackupOffset(0); setBackupNotice('');
      setBackupFields({ enabled: result.policy.enabled, versions: String(result.policy.keepVersions), days: String(result.policy.maxAgeDays), mib: String(result.policy.limitBytes / 1024 ** 2) });
    }
  }), [roomId, work]);
  const initialStorageRequested = useRef(false);
  useEffect(() => {
    if (!initialRootId || !initialStorage || !view || busy || initialStorageRequested.current) return;
    if (!view.roots.some(root => root.rootId === initialRootId && !root.paused)) return;
    initialStorageRequested.current = true;
    void (initialStorage === 'cache' ? loadCache(initialRootId) : loadBackups(initialRootId));
  }, [initialRootId, initialStorage, view, busy, loadCache, loadBackups]);
  const initialStoragePositioned = useRef(false);
  useEffect(() => {
    if (!initialRootId || !initialStorage || initialStoragePositioned.current) return;
    const panel = host.document.querySelector<HTMLElement>(initialStorage === 'cache'
      ? `[data-sync-storage-cache="${initialRootId}"]` : '[data-sync-storage-backups]');
    if (panel) { initialStoragePositioned.current = true; panel.scrollIntoView({ block: 'start' }); panel.focus({ preventScroll: true }); }
  }, [initialRootId, initialStorage, cache, backups, host]);
  const backupPage = (offset: number) => work(async () => {
    if (!backups) return;
    const result = await window.api.rooms.fileSync.backupPage(roomId, backups.previewId, offset);
    if (mounted.current) { setBackups(result); setBackupOffset(offset); }
  });
  const confirmBackups = () => work(async () => {
    if (!backups || !reviewedBackups) return;
    const result = await window.api.rooms.fileSync.confirmBackups(roomId, backups.previewId);
    if (mounted.current) {
      setBackups(null);
      setBackupNotice(t('rooms.sync.backupDone').replace('{n}', String(result.removedCopies)).replace('{bytes}', formatBytes(result.removedBytes)));
      if (result.error) setError(t('rooms.sync.backupPartial') + ' ' + result.error);
    }
  });
  const confirmRestore = () => work(async () => {
    if (!restore) return;
    await window.api.rooms.fileSync.restore(roomId, restore.previewId);
    if (mounted.current) { setRestore(null); setCache({}); }
  });
  const loadFilters = (rootId: string, rules?: string[]) => work(async () => {
    const result = await window.api.rooms.fileSync.filters(roomId, rootId, rules);
    if (mounted.current) { setFilters(result); setFilterText(result.rules.join('\n')); setFilterOffset(0); setFilterNotice(''); }
  });
  const filterPage = (offset: number) => work(async () => {
    if (!filters) return;
    const result = await window.api.rooms.fileSync.filterPage(roomId, filters.previewId, offset);
    if (mounted.current) { setFilters(result); setFilterOffset(offset); }
  });
  const confirmFilters = () => work(async () => {
    if (!filters || !reviewedFilters) return;
    await window.api.rooms.fileSync.confirmFilters(roomId, filters.previewId);
    if (mounted.current) { setFilters(null); setFilterNotice(t('rooms.sync.filtersSaved')); }
  });
  const defer = (rootId: string, entryId: string) => work(async () => {
    await window.api.rooms.fileSync.deferConflict(roomId, rootId, entryId);
    if (mounted.current) setConflict(null);
  });
  const resolve = (choice: SyncConflictChoice) => work(async () => {
    if (!conflict) return;
    const result = await window.api.rooms.fileSync.resolveConflict(roomId, conflict.previewId, choice);
    if (mounted.current) { setConflict(null); setResolvedCopy(result.copyPath); }
  });
  const loadRights = (rootId: string, selected?: string[], moving?: boolean, deleting?: boolean) => work(async () => {
    const result = await window.api.rooms.fileSync.rights(roomId, rootId, selected, moving, deleting);
    if (mounted.current) { setRights(result); setWriters(result.selected); setMoves(result.moves); setDeletes(!!result.deletes); }
  });
  const confirmRights = () => work(async () => {
    if (!rights?.previewId || !reviewedRights) return;
    await window.api.rooms.fileSync.confirmRights(roomId, rights.previewId);
    if (mounted.current) setRights(null);
  });
  const loadLog = (rootId: string) => work(async () => {
    const preview = await window.api.rooms.fileSync.logPreview(roomId, rootId);
    if (mounted.current) { setLog(preview); setLogNotice(''); }
  });
  const loadMetadata = (rootId: string, keep = 2) => work(async () => {
    const result = await window.api.rooms.fileSync.metadata(roomId, rootId, keep);
    if (mounted.current) { setMetadata(result); setMetadataKeep(String(keep)); setMetadataNotice(''); }
  });
  const compactLog = () => work(async () => {
    if (!log?.previewId) return;
    await window.api.rooms.fileSync.compactLog(roomId, log.previewId);
    if (mounted.current) { setLog(null); setLogNotice(t('rooms.sync.logDone').replace('{bytes}', formatBytes(log.savedBytes))); }
  });
  return <><RoomToolSurface embedded={embedded} title={t(initialRootId ? 'rooms.sync.folderSettings' : 'rooms.sync.title')} icon={initialRootId ? 'sliders' : 'refresh'} size="xl" className="room-sync-modal" busy={busy} onClose={onClose}
    footer={trashStorage ? <>
      <Button variant="secondary" disabled={busy} onClick={() => setTrashStorage(null)}>{t('common.close')}</Button>
      <Button variant="danger" data-sync-trash-storage-confirm disabled={busy || !trashReviewed || !trashStorage.selectedCopies} onClick={() => { void work(async () => {
        if (!trashStorage || !trashReviewed) return;
        const token = trashStorage.previewId, rootId = trashStorage.rootId; setTrashReviewed(false);
        const result = await window.api.rooms.fileSync.trashConfirm(roomId, token);
        if (mounted.current) {
          setTrashNotice(t('rooms.sync.trashStorageDone').replace('{n}', String(result.removedCopies)).replace('{bytes}', formatBytes(result.removedBytes)));
          if (result.error) setError(t('rooms.sync.trashStoragePartial'));
        }
        const fresh = await window.api.rooms.fileSync.trashPreview(roomId, rootId);
        if (mounted.current) {
          setTrashStorage(fresh); setTrashSelected([]); setTrashOffset(0);
        }
      }); }}>{t('rooms.sync.trashStorageConfirm')}</Button>
    </> : missing ? <Button variant="secondary" disabled={busy} onClick={() => setMissing(null)}>{t('common.close')}</Button> : metadata ? <>
      <Button variant="secondary" disabled={busy} onClick={() => { setMetadata(null); setMetadataPassword(''); setMetadataRepeat(''); setMetadataNotice(''); }}>{t('common.close')}</Button>
      <Button variant="danger" data-sync-metadata-confirm disabled={busy || !reviewedMetadata || !metadata.previewId || !metadata.exported || metadata.blocked} onClick={() => { void work(async () => {
        if (!metadata.previewId || !reviewedMetadata) return;
        const token = metadata.previewId; setMetadata(old => old ? { ...old, previewId: null } : old);
        await window.api.rooms.fileSync.metadataConfirm(roomId, token);
        const result = await window.api.rooms.fileSync.metadata(roomId, metadata.rootId, Number(metadataKeep));
        if (mounted.current) { setMetadata(result); setMetadataNotice(t('rooms.sync.metadataDone')); }
      }); }}>{t('rooms.sync.metadataConfirm')}</Button>
    </> : paths ? <>
      <Button variant="secondary" disabled={busy} onClick={() => { setPaths(null); setPathReview(null); }}>{t('common.cancel')}</Button>
      <Button variant="primary" data-sync-path-confirm disabled={busy || !reviewedPath} loading={busy} onClick={() => { void work(async () => {
        if (!pathReview || !reviewedPath) return;
        const token = pathReview.previewId; setPathReview(null);
        await window.api.rooms.fileSync.confirmPathResolution(roomId, token);
        if (mounted.current) { setPaths(null); setCache({}); }
      }); }}>{t('rooms.sync.pathConfirm')}</Button>
    </> : deletion ? <>
      <Button variant="secondary" disabled={busy} onClick={() => setDeletion(null)}>{t('common.cancel')}</Button>
      {deletion.mode === 'apply' && <Button variant="secondary" data-sync-delete-keep disabled={busy} onClick={() => { void confirmDelete(true); }}>{t('rooms.sync.conflictKeep')}</Button>}
      <Button variant="danger" data-sync-delete-confirm disabled={busy} onClick={() => { void confirmDelete(); }}>{t('rooms.sync.deleteConfirm')}</Button>
    </> : checkpoint ? <>
      <Button variant="secondary" disabled={busy} onClick={() => setCheckpoint(null)}>{t('common.cancel')}</Button>
      <Button variant="primary" disabled={busy} loading={busy} onClick={() => { void work(async () => {
        await window.api.rooms.fileSync.checkpointConfirm(roomId, checkpoint.previewId);
        if (mounted.current) { setCheckpoint(null); setLogNotice(t('rooms.sync.checkpointDone')); }
      }); }}>{t('rooms.sync.checkpointConfirm')}</Button>
    </> : log ? <>
      <Button variant="secondary" disabled={busy} onClick={() => setLog(null)}>{t('common.cancel')}</Button>
      <Button variant="primary" disabled={busy || !log.previewId} loading={busy} onClick={compactLog}>{t('rooms.sync.logConfirm')}</Button>
    </> : moveTarget ? <>
      <Button variant="secondary" disabled={busy} onClick={() => { setMoveTarget(null); setMoveReview(null); }}>{t('common.cancel')}</Button>
      <Button variant="primary" disabled={busy || !reviewedMove} loading={busy} onClick={() => { void work(async () => {
        if (!moveReview || !reviewedMove) return;
        await window.api.rooms.fileSync.confirmMove(roomId, moveReview.previewId);
        if (mounted.current) { setMoveTarget(null); setMoveReview(null); setCache({}); }
      }); }}>{t('rooms.sync.moveConfirm')}</Button>
    </> : rights ? <>
      <Button variant="secondary" disabled={busy} onClick={() => setRights(null)}>{t('common.cancel')}</Button>
      <Button variant="primary" disabled={busy || !reviewedRights} loading={busy} onClick={confirmRights}>{t('rooms.sync.rightsConfirm')}</Button>
    </> : filters ? <>
      <Button variant="secondary" disabled={busy} onClick={() => setFilters(null)}>{t('common.cancel')}</Button>
      <Button variant="primary" disabled={busy || !reviewedFilters} loading={busy} onClick={confirmFilters}>{t('rooms.sync.filtersConfirm')}</Button>
    </> : backups ? <>
      <Button variant="secondary" disabled={busy} onClick={() => setBackups(null)}>{t('common.cancel')}</Button>
      <Button variant="primary" disabled={busy || !reviewedBackups} loading={busy} onClick={confirmBackups}>{t('rooms.sync.backupConfirm')}</Button>
    </> : conflict ? <>
      <Button variant="secondary" disabled={busy} onClick={() => setConflict(null)}>{t('common.cancel')}</Button>
      <Button variant="secondary" disabled={busy} onClick={() => { void defer(conflict.rootId, conflict.entryId); }}>{t('rooms.sync.conflictDefer')}</Button>
      <Button variant="secondary" disabled={busy || !conflict.local.exists} onClick={() => { void resolve('keep-both'); }}>{t('rooms.sync.conflictKeep')}</Button>
      <Button variant="primary" disabled={busy} onClick={() => { void resolve('accept'); }}>{t('rooms.sync.conflictAccept')}</Button>
    </> : restore ? <><Button variant="secondary" disabled={busy} onClick={() => setRestore(null)}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={confirmRestore}>{t('rooms.sync.restoreConfirm')}</Button></>
      : preview ? <><Button variant="secondary" disabled={busy} onClick={() => setPreview(null)}>{t('common.cancel')}</Button><Button variant="primary" data-sync-connect-confirm loading={busy} onClick={connect}>{t(`rooms.workspace.connect.${connectionMode}`)}</Button></>
      : <Button variant="secondary" disabled={busy} onClick={onClose}>{t('common.close')}</Button>}>
    <div className="room-sync-panel" aria-busy={busy}>
      {error && <div className="room-sync-error" role="alert"><ErrorMessage error={error} /></div>}
      {backupNotice && <p role="status" className="room-sync-notice">{backupNotice}</p>}
      {filterNotice && <p role="status" className="room-sync-notice">{filterNotice}</p>}
      {logNotice && <p role="status" className="room-sync-notice">{logNotice}</p>}
      {resolvedCopy && <p role="status" className="room-sync-notice">{t('rooms.sync.conflictSaved')} <code className="room-sync-path">{resolvedCopy}</code></p>}
      {!view && !error && <p role="status">{t('common.loading')}</p>}
      {view && !view.enabled && <p>{t('rooms.sync.disabled')}</p>}
      {view?.enabled && (trashStorage ? <>
        <h3>{t('rooms.sync.trashStorageTitle')} · {view.roots.find(root => root.rootId === trashStorage.rootId)?.name}</h3>
        <p>{t('rooms.sync.trashStorageHint')}</p>
        <div className="room-sync-trash-stats">
          <div><small>{t('rooms.sync.trashStorageUsed')}</small><strong>{formatBytes(trashStorage.bytes)}</strong><small>{t('rooms.sync.trashStorageLimit').replace('{bytes}', formatBytes(trashStorage.limitBytes))}</small></div>
          <div><small>{t('rooms.sync.trashStorageAvailable')}</small><strong>{formatBytes(trashStorage.reclaimableBytes)}</strong></div>
          <div><small>{t('rooms.sync.trashStorageProtected')}</small><strong>{formatBytes(trashStorage.protectedBytes)}</strong></div>
        </div>
        <p>{t('rooms.sync.trashExportSummary')}</p>
        {trashStorage.unscanned > 0 && <p className="room-sync-notice">{t('rooms.sync.trashStorageUnknown')}</p>}
        {trashNotice && <p className="room-sync-notice" role="status">{trashNotice}</p>}
        <div className="room-sync-actions">
          <Button variant="secondary" data-sync-trash-storage-refresh disabled={busy} onClick={() => { void loadTrashStorage(trashStorage.rootId); }}>{t('rooms.sync.trashStorageRefresh')}</Button>
          <Button variant="secondary" data-sync-trash-storage-review disabled={busy || !trashSelected.length} onClick={() => { void loadTrashStorage(trashStorage.rootId, trashSelected); }}>{t('rooms.sync.trashStorageReview')}</Button>
        </div>
        <p role="status">{trashReviewed ? t('rooms.sync.trashStorageReviewed').replace('{n}', String(trashStorage.selectedCopies)).replace('{bytes}', formatBytes(trashStorage.selectedBytes)) : t('rooms.sync.trashStorageSelection').replace('{n}', String(trashSelected.length))}</p>
        <div className="room-sync-files room-sync-trash-storage-list">
          {trashStorage.items.map(row => <div className="room-sync-file room-sync-trash-row" key={row.operationId} data-sync-trash-storage-row={row.operationId}>
            <input type="checkbox" aria-label={`${t('rooms.sync.trashStorageReview')}: ${row.path}`} data-sync-trash-storage-select disabled={busy || !row.eligible || trashSelected.length >= SYNC_TRASH_SELECTION_LIMIT && !trashSelected.includes(row.operationId)} checked={trashSelected.includes(row.operationId)} onChange={e => {
              const checked = e.target.checked; setTrashReviewed(false);
              setTrashSelected(old => checked ? [...old, row.operationId] : old.filter(id => id !== row.operationId));
            }} />
            <span><strong>{row.path}</strong><small>{formatBytes(row.size)}{row.createdAt > 0 ? ` · ${new Date(row.createdAt).toLocaleString()}` : ''}</small><small>{t(`rooms.sync.trashStorageReason.${row.reason}`)}</small></span>
            {row.exportable && <Button variant="secondary" size="sm" icon={<Icon name="download" size={14} />} data-sync-trash-export disabled={busy} title={`${t('rooms.sync.trashExport')}: ${row.path}`} onClick={() => { void work(async () => {
              const result = await window.api.rooms.fileSync.trashExport(roomId, trashStorage.previewId, row.operationId);
              if (!result || !mounted.current) return;
              setTrashReviewed(false); setTrashSelected([]); setTrashOffset(0);
              setLastTrashExport({ rootId: trashStorage.rootId, path: result.path });
              setTrashNotice(t('rooms.sync.trashExportDone').replace('{file}', result.path.split(/[\\/]/).at(-1) ?? result.path));
              setTrashStorage(await window.api.rooms.fileSync.trashPreview(roomId, trashStorage.rootId));
            }); }}>{t('rooms.sync.trashExport')}</Button>}
          </div>)}
          {!trashStorage.items.length && <p>{t('rooms.sync.trashStorageEmpty')}</p>}
        </div>
        {(trashOffset > 0 || trashStorage.next !== null) && <div className="room-sync-actions">
          <Button variant="secondary" disabled={busy || !trashOffset} onClick={() => { void trashStoragePage(Math.max(0, trashOffset - 100)); }}>{t('rooms.sync.previous')}</Button>
          <Button variant="secondary" disabled={busy || trashStorage.next === null} onClick={() => { void trashStoragePage(trashStorage.next!); }}>{t('rooms.sync.next')}</Button>
        </div>}
        {lastTrashExport?.rootId === trashStorage.rootId && <details className="room-sync-trash-help" data-sync-trash-export-location><summary>{t('rooms.sync.trashExportLocation')}</summary><p><code>{lastTrashExport.path}</code></p></details>}
        <details className="room-sync-trash-help"><summary>{t('rooms.sync.trashStorageHelp')}</summary><p>{t('rooms.sync.trashStorageRecovery')}</p><p>{t('rooms.sync.trashExportHint')}</p></details>
      </> : missing ? <>
        <h3>{t('rooms.sync.missingTitle')} · {view.roots.find(root => root.rootId === missing.rootId)?.name}</h3>
        <p>{t('rooms.sync.missingHint')}</p>
        <p className="room-sync-notice">{t('rooms.sync.missingRecovery')}</p>
        {missing.blocked && <p className="room-sync-missing-warning" role="alert">{t(`rooms.sync.missingBlocked.${missing.blocked}`)}</p>}
        {missing.mass && <div className="room-sync-missing-warning"><strong>{t('rooms.sync.missingMassTitle')}</strong><p>{t('rooms.sync.missingMassHint')}</p>
          <label className="room-sync-missing-ack"><input data-sync-missing-ack type="checkbox" checked={missingMass} disabled={busy} onChange={e => setMissingMass(e.target.checked)} />{t('rooms.sync.missingMassAck')}</label>
        </div>}
        <div className="room-sync-actions"><Button variant="secondary" data-sync-missing-refresh disabled={busy} onClick={() => { void loadMissing(missing.rootId); }}>{t('rooms.sync.recheck')}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => { void action(missing.rootId, 'open-folder'); }}>{t('rooms.sync.openFolder')}</Button></div>
        <p role="status">{t('rooms.sync.missingCounts').replace('{n}', String(missing.items.length)).replace('{waiting}', String(missing.waiting))}</p>
        <div className="room-sync-files room-sync-missing-list">
          {missing.items.map(row => <div className="room-sync-file" key={row.entryId} data-sync-missing-entry={row.entryId}>
            <span><strong>{row.path}</strong><small>{formatBytes(row.size)} · {t('rooms.sync.missingLastVersion')}</small></span>
            <Button size="sm" variant="secondary" data-sync-missing-review disabled={busy || !!missing.blocked || missing.mass && !missingMass} onClick={() => { void work(async () => {
              const result = await window.api.rooms.fileSync.prepareMissingDelete(roomId, missing.rootId, row.entryId, missing.stamp, missingMass);
              if (mounted.current) { setMissing(null); setDeletion(result); }
            }); }}>{t('rooms.sync.missingReview')}</Button>
          </div>)}
          {!missing.items.length && <p>{t(missing.waiting ? 'rooms.sync.missingWaiting' : 'rooms.sync.missingEmpty')}</p>}
        </div>
      </> : metadata ? <>
        <h3>{t('rooms.sync.metadataTitle')} · {view.roots.find(root => root.rootId === metadata.rootId)?.name}</h3>
        <p>{t('rooms.sync.metadataHint')}</p>
        <div className="room-sync-backup-settings">
          <label>{t('rooms.sync.metadataPassword')}<input data-sync-metadata-password type="password" minLength={12} maxLength={1024} autoComplete="new-password" value={metadataPassword} disabled={busy} onChange={e => setMetadataPassword(e.target.value)} /></label>
          <label>{t('rooms.sync.metadataRepeat')}<input data-sync-metadata-repeat type="password" maxLength={1024} autoComplete="new-password" value={metadataRepeat} disabled={busy} onChange={e => setMetadataRepeat(e.target.value)} /></label>
        </div>
        <div className="room-sync-actions">
          <Button variant="secondary" data-sync-metadata-export disabled={busy || metadataPassword.length < 12 || metadataPassword !== metadataRepeat} onClick={() => { void work(async () => {
            const result = await window.api.rooms.fileSync.metadataExport(roomId, metadata.rootId, metadataPassword);
            if (!result) return;
            const state = await window.api.rooms.fileSync.metadata(roomId, metadata.rootId, metadata.keep);
            if (mounted.current) { setMetadata(state); setMetadataKeep(String(state.keep)); setMetadataPassword(''); setMetadataRepeat(''); setMetadataNotice(t('rooms.sync.metadataSaved') + ' ' + result.path); }
          }); }}>{t('rooms.sync.metadataExport')}</Button>
          <Button variant="secondary" data-sync-metadata-import disabled={busy || metadataPassword.length < 12} onClick={() => { void work(async () => {
            const count = await window.api.rooms.fileSync.metadataImport(roomId, metadata.rootId, metadataPassword);
            if (count === null) return;
            const state = await window.api.rooms.fileSync.metadata(roomId, metadata.rootId, metadata.keep);
            if (mounted.current) { setMetadata(state); setMetadataKeep(String(state.keep)); setMetadataPassword(''); setMetadataRepeat(''); setMetadataNotice(t('rooms.sync.metadataImported').replace('{n}', String(count))); }
          }); }}>{t('rooms.sync.metadataImport')}</Button>
        </div>
        {metadataNotice && <p role="status" className="room-sync-notice">{metadataNotice}</p>}
        <p className="room-sync-notice">{t('rooms.sync.metadataContents')}</p>
        <label className="room-sync-filter-editor">{t('rooms.sync.metadataKeep')}<NumberInput data-sync-metadata-keep min={0} max={8} step={1} value={metadataKeep} disabled={busy} onValueChange={setMetadataKeep} /></label>
        <Button variant="secondary" data-sync-metadata-review disabled={busy || metadataKeep.trim() === '' || !Number.isInteger(Number(metadataKeep)) || Number(metadataKeep) < 0 || Number(metadataKeep) > 8} onClick={() => { void loadMetadata(metadata.rootId, Number(metadataKeep)); }}>{t('rooms.sync.metadataReview')}</Button>
        <p>{t('rooms.sync.metadataSizes').replace('{before}', formatBytes(metadata.beforeBytes)).replace('{after}', formatBytes(metadata.afterBytes)).replace('{n}', String(metadata.removed))}</p>
        {metadata.blocked && <p className="room-sync-notice">{t('rooms.sync.metadataBlocked')}</p>}
        {metadata.epochs.some(e => e.reason === 'source') && <p className="room-sync-notice">{t('rooms.sync.metadataCacheHint')}</p>}
        {!metadata.exported && metadata.removed > 0 && <p className="room-sync-notice">{t('rooms.sync.metadataExportNeeded')}</p>}
        <div className="room-sync-files room-sync-metadata-list" data-sync-metadata-epochs>
          {metadata.epochs.map(e => <div className="room-sync-file" key={e.source + e.digest} data-sync-metadata-remove={e.remove ? 'true' : 'false'}>
            <span>{t('rooms.sync.metadataEpoch').replace('{n}', String(e.generation))} · {t(e.source === 'retired' ? 'rooms.sync.metadataLocal' : 'rooms.sync.metadataDownloaded')}<small>{e.records} · {formatBytes(e.bytes)} · {e.digest.slice(0, 12)}</small></span>
            <span>{t(`rooms.sync.metadataReason.${e.reason}`)}</span>
          </div>)}
          {metadata.epochs.length === 0 && <p>{t('rooms.sync.metadataEmpty')}</p>}
        </div>
      </> : paths ? <>
        <h3>{t('rooms.sync.pathTitle')}</h3>
        <p>{t('rooms.sync.pathHint')}</p>
        <fieldset className="room-sync-path-versions" disabled={busy}><legend>{t('rooms.sync.pathChoose')}</legend>
          {paths.versions.map(version => <label className="room-sync-file" key={version.revisionId}>
            <input type="radio" name="sync-path-version" data-sync-path-version value={version.revisionId} checked={pathVersion === version.revisionId} onChange={() => { setPathVersion(version.revisionId); setPathReview(null); }} />
            <span><strong>{version.path}</strong><small>{formatBytes(version.size)} · {new Date(version.createdAt).toLocaleString()}</small><small>{t('rooms.sync.pathAuthor')}: {version.authorId.slice(0, 12)} · {version.revisionId.slice(0, 12)}</small></span>
          </label>)}
        </fieldset>
        {paths.others.length > 0 && <div className="room-sync-path-others"><strong>{t('rooms.sync.pathOthers')}</strong>
          {paths.others.map((other, index) => <p key={other.entryId + ':' + index}><code>{other.path}</code> · {formatBytes(other.size)} · {other.authorId.slice(0, 12)}</p>)}
          {paths.more && <p>{t('rooms.sync.pathMore')}</p>}
        </div>}
        <label className="room-sync-filter-editor">{t('rooms.sync.movePath')}<input data-sync-path-name value={pathName} maxLength={1024} spellCheck={false} disabled={busy} onChange={event => { setPathName(event.target.value); setPathReview(null); }} /></label>
        <p className="room-sync-notice">{t('rooms.sync.pathPreserve')}</p>
        <Button variant="secondary" data-sync-path-review disabled={busy || !validSyncRelativePath(pathName)} onClick={() => { void work(async () => {
          setPathReview(null);
          const result = await window.api.rooms.fileSync.preparePathResolution(roomId, paths.rootId, paths.entryId, pathVersion, pathName);
          if (mounted.current) setPathReview(result);
        }); }}>{t('rooms.sync.moveReview')}</Button>
        {reviewedPath && <p role="status">{pathReview.fromPath} → {pathReview.toPath} · {formatBytes(pathReview.size)}{pathReview.branches > 1 && ` · ${t('rooms.sync.pathBranches').replace('{n}', String(pathReview.branches))}`}</p>}
      </> : deletion ? <>
        <h3>{t(deletion.mode === 'apply' ? 'rooms.sync.deleteConflict' : 'rooms.sync.deleteTitle')}</h3>
        <code className="room-sync-path">{deletion.path}</code><p>{formatBytes(deletion.size)}</p>
        <p className="room-sync-notice">{t(deletion.external ? 'rooms.sync.missingDeleteHint' : 'rooms.sync.deleteHint')}</p>
        {deletion.mode === 'apply' && <><p>{t('rooms.sync.deleteConflictHint')}</p><code className="room-sync-path">{deletion.copyPath}</code></>}
      </> : checkpoint ? <>
        <h3>{t('rooms.sync.checkpoint')}</h3>
        <p>{t('rooms.sync.checkpointHint')}</p>
        <p>{t('rooms.sync.checkpointCounts').replace('{generation}', String(checkpoint.generation)).replace('{records}', String(checkpoint.activeRecords)).replace('{heads}', String(checkpoint.heads))}</p>
        <p>{t('rooms.sync.checkpointArchives').replace('{n}', String(checkpoint.archives + 1)).replace('{max}', String(checkpoint.maxArchives))}</p>
        <p className="room-sync-notice">{t('rooms.sync.checkpointCompatibility').replaceAll('{version}', String(checkpoint.version))}</p>
        <p className="room-sync-notice">{t('rooms.sync.checkpointOffline')}</p>
        <p>{t('rooms.sync.checkpointLimits')}</p>
      </> : log ? <>
        <h3>{t('rooms.sync.log')}</h3>
        <p>{t('rooms.sync.logHint')}</p>
        <p>{t('rooms.sync.logCounts').replace('{revisions}', String(log.revisions)).replace('{policies}', String(log.policies)).replace('{limit}', String(log.revisionLimit)).replace('{policyLimit}', String(log.policyLimit))}</p>
        <p>{t('rooms.sync.logSizes').replace('{before}', formatBytes(log.storedBytes)).replace('{after}', formatBytes(log.afterBytes)).replace('{saved}', formatBytes(log.savedBytes))}</p>
        <p>{t('rooms.sync.logArchive').replace('{archived}', String(log.archived)).replace('{pending}', String(log.pending))}</p>
        <p className="room-sync-notice">{t('rooms.sync.logLimits')}</p>
        <p className="room-sync-notice">{t('rooms.sync.logCompatibility')}</p>
        {!log.previewId && <p role="status">{t('rooms.sync.logNoSaving')}</p>}
        <Button variant="secondary" disabled={busy} onClick={() => { void loadLog(log.rootId); }}>{t('rooms.sync.logReview')}</Button>
      </> : moveTarget ? <>
        <h3>{t('rooms.sync.move')}</h3>
        <code className="room-sync-path">{moveTarget.path}</code>
        <label className="room-sync-filter-editor">{t('rooms.sync.movePath')}<input data-sync-move-path value={movePath} maxLength={1024} disabled={busy} spellCheck={false} onChange={event => setMovePath(event.target.value)} /></label>
        <p>{t('rooms.sync.moveHint')}</p>
        <Button variant="secondary" disabled={busy || !validSyncRelativePath(movePath) || movePath === moveTarget.path} onClick={() => { void work(async () => {
          const result = await window.api.rooms.fileSync.prepareMove(roomId, moveTarget.rootId, moveTarget.entryId, movePath);
          if (mounted.current) setMoveReview(result);
        }); }}>{t('rooms.sync.moveReview')}</Button>
        {reviewedMove && <p role="status">{moveReview.fromPath} → {moveReview.toPath} · {formatBytes(moveReview.size)}</p>}
      </> : rights ? <>
        <h3>{t('rooms.sync.rights')}</h3>
        <p className="room-sync-notice">{t('rooms.sync.rightsHint')}</p>
        <p>{t('rooms.sync.rightsResume')}</p>
        <label className="room-sync-file"><input type="checkbox" data-sync-moves checked={moves} disabled={busy || rights.version >= 3} onChange={event => setMoves(event.target.checked)} /><span>{t('rooms.sync.movesEnable')}<small>{t('rooms.sync.movesEnableHint')}</small></span></label>
        <label className="room-sync-file"><input type="checkbox" data-sync-deletes checked={deletes} disabled={busy || rights.version >= 6} onChange={event => { setDeletes(event.target.checked); if (event.target.checked) setMoves(true); }} /><span>{t('rooms.sync.deletesEnable')}<small>{t('rooms.sync.deletesEnableHint')}</small></span></label>
        <div className="room-sync-files">
          {rights.candidates.map(member => <label className="room-sync-file" key={member.memberId}>
            <input type="checkbox" data-sync-writer checked={writers.includes(member.memberId)} disabled={busy || member.memberId === rights.ownerId || !(deletes ? member.deletes : rights.version >= 4 ? (rights.version >= 5 ? member.multipart : member.checkpoints) : moves ? member.moves : member.capable) && !(rights.version >= (deletes ? 6 : moves ? 3 : 2) && rights.selected.includes(member.memberId))}
              onChange={event => setWriters(old => event.target.checked ? [...old, member.memberId] : old.filter(id => id !== member.memberId))} />
            <span>{member.name}<small>{member.memberId.slice(0, 12)}{!(deletes ? member.deletes : rights.version >= 4 ? (rights.version >= 5 ? member.multipart : member.checkpoints) : moves ? member.moves : member.capable) && ` · ${t('rooms.sync.rightsNeedsUpdate')}`}</small></span>
          </label>)}
        </div>
        <Button variant="secondary" disabled={busy || writers.length > 16 || writers.length === 0} onClick={() => { void loadRights(rights.rootId, writers, moves, deletes); }}>{t('rooms.sync.rightsReview')}</Button>
        {reviewedRights && <p role="status">{t('rooms.sync.rightsReviewed')}</p>}
      </> : filters ? <>
        <h3>{t('rooms.sync.filters')}</h3>
        <p>{t(filters.publisher ? 'rooms.sync.filtersPublisher' : 'rooms.sync.filtersReceiver')}</p>
        <label className="room-sync-filter-editor">{t('rooms.sync.filtersPatterns')}
          <textarea rows={5} maxLength={16384} disabled={busy} value={filterText} onChange={event => setFilterText(event.target.value)} spellCheck={false} placeholder={'*.log\ncache/**\nnotes/private.md'} />
        </label>
        <p>{t('rooms.sync.filtersSyntax')}</p>
        <p className="room-sync-notice">{t('rooms.sync.filtersBuiltin')}</p>
        {!validFilters && <p role="alert" className="room-sync-error">{t('rooms.sync.filtersInvalid')}</p>}
        <Button variant="secondary" disabled={busy || !validFilters} onClick={() => { void loadFilters(filters.rootId, filterRules); }}>{t('rooms.sync.filtersReview')}</Button>
        {!reviewedFilters && <p role="status">{t('rooms.sync.filtersChanged')}</p>}
        {filters.scanError && <p role="alert" className="room-sync-error">{t('rooms.sync.filtersScanError')} {filters.scanError}</p>}
        {!filters.scanError && <>
        <p>{t('rooms.sync.filtersCounts').replace('{included}', String(filters.included)).replace('{skipped}', String(filters.skipped)).replace('{shared}', String(filters.sharedIncluded)).replace('{excluded}', String(filters.sharedSkipped))}</p>
        <p>{t('rooms.sync.filtersDirectories')}</p>
        <div className="room-sync-files room-sync-filter-list" aria-label={t('rooms.sync.filters')}>
          {filters.items.map(row => <div key={row.source + ':' + row.path} data-reason={row.reason} className={'room-sync-file ' + (row.reason === 'included' ? 'filter-included' : 'filter-excluded')}>
            <span>{row.path}{row.directory && '/'}<small>{t(`rooms.sync.filtersSource.${row.source}`)} · {t(`rooms.sync.filtersReason.${row.reason}`)}{row.rule && <> · <code>{row.rule}</code></>}{row.change && <> · <strong>{t(`rooms.sync.filtersChange.${row.change}`)}</strong></>}</small></span>
            <span>{row.size !== null ? formatBytes(row.size) : '—'}</span>
          </div>)}
          {filters.items.length === 0 && <p>{t('rooms.sync.noFiles')}</p>}
        </div>
        <div className="room-sync-actions">
          {filterOffset > 0 && <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void filterPage(Math.max(0, filterOffset - 100)); }}>{t('rooms.sync.previous')}</Button>}
          {filters.next !== null && <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void filterPage(filters.next!); }}>{t('rooms.sync.next')}</Button>}
        </div>
        </>}
      </> : backups ? <>
        <h3 data-sync-storage-backups tabIndex={-1}>{t('rooms.sync.backups')}</h3>
        <p>{t('rooms.sync.backupHint')}</p>
        <Toggle checked={backupFields.enabled} disabled={busy} onChange={enabled => setBackupFields(old => ({ ...old, enabled }))} label={t('rooms.sync.backupAuto')} />
        <div className="room-sync-backup-settings">
          {(['versions', 'days', 'mib'] as const).map(field => <label key={field}>{t(`rooms.sync.backupField.${field}`)}<NumberInput min={field === 'versions' ? 1 : 0} max={field === 'versions' ? 1000 : field === 'days' ? 3650 : 102400} step="1" value={backupFields[field]} disabled={busy} onValueChange={value => setBackupFields(old => ({ ...old, [field]: value }))} /></label>)}
        </div>
        <p>{t('rooms.sync.backupLimitsHint')}</p>
        <Button variant="secondary" disabled={busy || !validBackups} onClick={() => { void loadBackups(backups.rootId, backupPolicy); }}>{t('rooms.sync.backupReview')}</Button>
        {!reviewedBackups && <p role="status" className="room-sync-notice">{t('rooms.sync.backupChanged')}</p>}
        <p className="room-sync-backup-summary">{t('rooms.sync.backupSize').replace('{used}', formatBytes(backups.bytes)).replace('{protected}', formatBytes(backups.protectedBytes)).replace('{n}', String(backups.copies))}</p>
        <p>{t('rooms.sync.backupRemove').replace('{n}', String(backups.removeCopies)).replace('{bytes}', formatBytes(backups.removeBytes))}</p>
        {backups.unscanned > 0 && <p className="room-sync-notice">{t('rooms.sync.backupUnscanned')}</p>}
        {backups.bytes - backups.removeBytes > backups.policy.limitBytes && <p className="room-sync-notice">{t('rooms.sync.backupOver')}</p>}
        <div className="room-sync-files room-sync-backup-list" aria-label={t('rooms.sync.backups')}>
          {backups.items.map(copy => <div key={copy.operationId} className={'room-sync-file ' + (copy.remove ? 'backup-remove' : 'backup-keep')}>
            <span>{copy.path}<small>{copy.createdAt > 0 && new Date(copy.createdAt).toLocaleString()} · {t(`rooms.sync.backupReason.${copy.reason}`)}</small></span><span>{formatBytes(copy.size)}</span>
          </div>)}
          {backups.items.length === 0 && <p>{t('rooms.sync.backupEmpty')}</p>}
        </div>
        <div className="room-sync-actions">
          {backupOffset > 0 && <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void backupPage(Math.max(0, backupOffset - 100)); }}>{t('rooms.sync.previous')}</Button>}
          {backups.next !== null && <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void backupPage(backups.next!); }}>{t('rooms.sync.next')}</Button>}
        </div>
      </> : conflict ? <>
        <h3>{t('rooms.sync.conflictTitle')}</h3>
        <code className="room-sync-path">{conflict.path}</code>
        <div className="room-sync-comparison">
          <div><strong>{t('rooms.sync.conflictLocal')}</strong><p>{conflict.local.exists ? formatBytes(conflict.local.size) : t('rooms.sync.conflictAbsent')}</p><p>{conflict.local.modifiedAt !== null && new Date(conflict.local.modifiedAt).toLocaleString()}</p></div>
          <div><strong>{t('rooms.sync.conflictIncoming')}</strong><p>{formatBytes(conflict.incomingSize)}</p><p>{new Date(conflict.createdAt).toLocaleString()}</p><code>{conflict.revisionId.slice(0, 12)}</code></div>
        </div>
        <p className="room-sync-notice">{t('rooms.sync.conflictHint')}</p>
        <p>{t('rooms.sync.conflictCopyHint')} <code className="room-sync-path">{conflict.copyPath}</code></p>
        {conflict.diff.kind === 'text' ? <>
          <p>{t('rooms.sync.conflictDiffLegend')}</p>
          <div className="room-sync-diff" role="region" aria-label={t('rooms.sync.conflictDiff')} tabIndex={0}>
            {conflict.diff.lines.map((line, index) => <div className={'room-sync-diff-line ' + line.kind} key={index}>
              <span className="room-sync-diff-number" aria-hidden="true">{line.local ?? ''}</span><span className="room-sync-diff-number" aria-hidden="true">{line.incoming ?? ''}</span>
              <span className="sr-only">{line.kind === 'added' ? t('a11y.diff.added') : line.kind === 'removed' ? t('a11y.diff.removed') : t('a11y.diff.context')}: </span>
              <span aria-hidden="true">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span>
              <code>{line.text.replace(/\r/g, '␍').replace(/\uFEFF/g, '⟨BOM⟩') || ' '}</code>
            </div>)}
          </div>
        </> : <p>{t(conflict.diff.reason === 'large' ? 'rooms.sync.conflictDiffLarge' : 'rooms.sync.conflictDiffBinary')}</p>}
      </> : restore ? <>
        <h3>{t('rooms.sync.restoreReview')}</h3>
        <code className="room-sync-path">{restore.path}</code>
        {restore.moveFrom && <p>{restore.moveFrom} → {restore.path}</p>}
        <p>{new Date(restore.createdAt).toLocaleString()}</p>
        <p className="room-sync-notice">{t('rooms.sync.restoreHint')}</p>
        {(restore.branches ?? 0) > 1 && <p className="room-sync-notice">{t('rooms.sync.mergeHint').replace('{n}', String(restore.branches))}</p>}
        {restore.replacesLocal && <p>{t('rooms.sync.restoreBackup')}</p>}
      </> : preview ? <>
        <h3>{t('rooms.sync.review')} · {preview.name}</h3>
        <code className="room-sync-path">{preview.path}</code>
        <p>{t('rooms.sync.previewCount').replace('{n}', String(preview.localFiles)).replace('{skip}', String(preview.skipped))}</p>
        {preview.rootId && <p>{t('rooms.sync.incomingCount').replace('{n}', String(preview.incoming)).replace('{existing}', String(preview.existing))}</p>}
        {preview.existing > 0 && <p className="room-sync-notice">{t('rooms.sync.preserveExisting')}</p>}
        <p>{t('rooms.sync.connectHint')}</p>
        <div className="room-sync-connect-mode" data-sync-connect-mode={connectionMode}><strong>{t('rooms.workspace.mode')}</strong><SyncModePicker value={connectionMode} onChange={setConnectionMode}
          writer={!preview.rootId || !!view?.roots.find(r => r.rootId === preview.rootId)?.publisher} disabled={busy} /></div>
        <div className="room-sync-files">
          {preview.items.map(item => <div className="room-sync-file" key={item.path}><span>{item.path}{item.existing && <small>{t('rooms.sync.existing')}</small>}</span><span>{formatBytes(item.size)}</span></div>)}
          {preview.items.length === 0 && <p>{t('rooms.sync.noFiles')}</p>}
        </div>
        {preview.more && <p>{t('rooms.sync.firstHundred')}</p>}
        <p>{t('rooms.sync.exclusions')}</p>
      </> : <>
        {!initialRootId && <><p>{t('rooms.sync.intro')}</p><p>{t('rooms.sync.exclusions')}</p></>}
        {view.canCreate && !initialRootId && <form className="room-sync-create" onSubmit={event => { event.preventDefault(); void choose(); }}>
          <label><span>{t('rooms.sync.name')}</span><input value={name} maxLength={80} disabled={busy} onChange={event => setName(event.target.value)} placeholder={t('rooms.sync.namePlaceholder')} /></label>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{t('rooms.sync.chooseSource')}</Button>
        </form>}
        {view.roots.length === 0 && <p>{t(view.canCreate ? 'rooms.sync.emptyOwner' : 'rooms.sync.emptyMember')}</p>}
        {view.roots.filter(root => !initialRootId || root.rootId === initialRootId).map(root => <article className="room-sync-root" key={root.rootId}>
          <header><div className="room-sync-root-name"><Icon name="folder" size={22} /><strong>{root.name}</strong></div><span className="room-sync-role">{t(root.paused ? 'rooms.sync.paused' : root.publisher ? 'rooms.sync.publisher' : 'rooms.sync.receiver')}</span></header>
          {root.path ? <code className="room-sync-path">{root.path}</code> : <p>{t('rooms.sync.notConnected')}</p>}
          <div className="room-sync-stats"><span><strong>{root.files}</strong>{t('rooms.sync.statFiles')}</span><span><strong>{root.pending}</strong>{t('rooms.sync.statPending')}</span><span className={root.conflicts ? 'has-conflicts' : ''}><strong>{root.conflicts}</strong>{t('rooms.sync.statConflicts')}</span></div>
          {root.paused && <p className="room-sync-notice">{t('rooms.sync.contextChanged')}</p>}
          {root.error && <p className="room-sync-error" role="alert"><ErrorMessage error={root.error} /></p>}
          {root.notice && <p className="room-sync-notice">{t('rooms.sync.rightsChangedNotice')}</p>}
          {root.path && !root.paused && <>
            <RoomSyncMode root={root} disabled={busy} onApply={mode => action(root.rootId, `mode-${mode}`)} />
          </>}
          <div className="room-sync-actions room-sync-main-actions">
            {root.path && root.publisher && root.deletes && !root.paused && <Button variant="secondary" size="sm" data-sync-action="missing" disabled={busy} onClick={() => { void loadMissing(root.rootId); }}>{t('rooms.sync.missingTitle')}{root.missing ? ` · ${root.missing}` : ''}</Button>}
            {!root.path && !root.paused && <Button variant="primary" size="sm" icon={<Icon name="folder-plus" size={15} />} data-sync-action="bind" disabled={busy} onClick={() => { void choose(root.rootId); }}>{t('rooms.sync.chooseDestination')}</Button>}
            {!root.paused && <Button variant={selected === root.rootId && trashRoot !== root.rootId ? 'secondary' : 'primary'} size="sm" icon={<Icon name="folder-open" size={15} />} data-sync-action="files" aria-expanded={selected === root.rootId && trashRoot !== root.rootId} disabled={busy} onClick={() => { setSelected(selected === root.rootId && trashRoot !== root.rootId ? null : root.rootId); setTrashRoot(null); setOffset(0); setPage(null); }}>{t(selected === root.rootId && trashRoot !== root.rootId ? 'rooms.sync.hideFiles' : 'rooms.sync.files')}</Button>}
            {!!root.trash && !root.paused && <Button variant="secondary" size="sm" data-sync-trash icon={<Icon name="trash" size={15} />} disabled={busy} onClick={() => { setSelected(root.rootId); setTrashRoot(root.rootId); setOffset(0); setPage(null); }}>{t('rooms.sync.trash')} · {root.trash}</Button>}
            {root.path && <Button variant="secondary" size="sm" icon={<Icon name="folder" size={15} />} data-sync-action="open-folder" disabled={busy} onClick={() => { void action(root.rootId, 'open-folder'); }}>{t('rooms.sync.openFolder')}</Button>}
          </div>
          <details className="room-sync-settings" open={initialRootId === root.rootId && !root.path || undefined}>
            <summary><Icon name="sliders" size={15} /><span>{t('rooms.sync.folderSettings')}</span><Icon name="chevron-down" size={14} /></summary>
            <div className="room-sync-settings-group"><strong>{t('rooms.sync.settingsAccess')}</strong><div className="room-sync-settings-grid">
              {root.path && !root.paused && <Button variant="secondary" size="sm" data-sync-action="bind" disabled={busy} onClick={() => { void choose(root.rootId); }}>{t('rooms.sync.changeFolder')}</Button>}
              {root.owner && !root.paused && <Button variant="secondary" size="sm" data-sync-action="rights" disabled={busy} onClick={() => { void loadRights(root.rootId); }}>{t('rooms.sync.rights')}</Button>}
              {root.path && !root.paused && <Button variant="secondary" size="sm" data-sync-action="filters" disabled={busy} onClick={() => { void loadFilters(root.rootId); }}>{t('rooms.sync.filters')}</Button>}
            </div></div>
            <div className="room-sync-settings-group"><strong>{t('rooms.sync.settingsStorage')}</strong><div className="room-sync-settings-grid">
              {root.path && !root.paused && <Button variant="secondary" size="sm" data-sync-action="trash-storage" disabled={busy} onClick={() => { void loadTrashStorage(root.rootId); }}>{t('rooms.sync.trashStorageTitle')}</Button>}
              {!root.paused && <Button variant="secondary" size="sm" data-sync-action="metadata" disabled={busy} onClick={() => { void loadMetadata(root.rootId); }}>{t('rooms.sync.metadataTitle')}</Button>}
              {!root.paused && <Button variant="secondary" size="sm" data-sync-action="cache" disabled={busy} onClick={() => { void loadCache(root.rootId); }}>{t('rooms.sync.cache')}</Button>}
              {root.path && !root.paused && <Button variant="secondary" size="sm" data-sync-action="backups" disabled={busy} onClick={() => { void loadBackups(root.rootId); }}>{t('rooms.sync.backups')}</Button>}
            </div></div>
            <div className="room-sync-settings-group"><strong>{t('rooms.sync.settingsAdvanced')}</strong><div className="room-sync-settings-grid">
              {!root.paused && <Button variant="secondary" size="sm" data-sync-action="log" disabled={busy} onClick={() => { void loadLog(root.rootId); }}>{t('rooms.sync.log')}</Button>}
              {root.owner && !root.paused && <Button variant="secondary" size="sm" data-sync-action="checkpoint" disabled={busy} onClick={() => { void work(async () => {
                const preview = await window.api.rooms.fileSync.checkpointPreview(roomId, root.rootId);
                if (mounted.current) setCheckpoint(preview);
              }); }}>{t('rooms.sync.checkpoint')}</Button>}
              {root.path && !root.paused && <Button variant="secondary" size="sm" data-sync-action="scan" disabled={busy || !(root.autoPublish || root.autoApply)} onClick={() => { void action(root.rootId, 'scan'); }}>{t('rooms.sync.recheck')}</Button>}
            </div></div>
            {root.path && <div className="room-sync-settings-disconnect"><p>{t('rooms.sync.disconnectHint')}</p><Button variant="danger" size="sm" data-sync-action="unbind" disabled={busy} onClick={() => { void action(root.rootId, 'unbind'); }}>{t('rooms.sync.disconnect')}</Button></div>}
          </details>
          {cache[root.rootId] && <div className="room-sync-cache" data-sync-storage-cache={root.rootId} tabIndex={-1}>
            <strong>{t('rooms.sync.cache')}</strong>
            <p>{t('rooms.sync.cacheSize').replace('{used}', formatBytes(cache[root.rootId].bytes)).replace('{protected}', formatBytes(cache[root.rootId].protectedBytes)).replace('{free}', formatBytes(cache[root.rootId].removableBytes))}</p>
            {cache[root.rootId].freedBytes > 0 && <p role="status">{t('rooms.sync.cacheFreed').replace('{n}', formatBytes(cache[root.rootId].freedBytes))}</p>}
            <label>{t('rooms.sync.cacheLimit')} <NumberInput min="0" max="102400" step="1" value={limits[root.rootId] ?? ''} disabled={busy} onValueChange={value => setLimits(old => ({ ...old, [root.rootId]: value }))} /></label>
            <Button variant="secondary" size="sm" disabled={busy || !limits[root.rootId]?.trim() || !Number.isInteger(Number(limits[root.rootId])) || Number(limits[root.rootId]) < 0 || Number(limits[root.rootId]) > 102400} onClick={() => { void loadCache(root.rootId, true); }}>{t('rooms.sync.cacheSave')}</Button>
            <p>{t('rooms.sync.cacheHint')}</p>
            {cache[root.rootId].bytes > cache[root.rootId].limitBytes && <p className="room-sync-notice">{t('rooms.sync.cacheOver')}</p>}
          </div>}
          {selected === root.rootId && page && <>
            {trashRoot === root.rootId && <p>{t('rooms.sync.trashHint')}</p>}
            <div className="room-sync-files">
              {page.items.map(file => <div key={file.entryId} data-sync-entry={file.entryId} className={'room-sync-file room-sync-document ' + file.status}>
                <div className="room-sync-document-info"><Icon name="file-text" size={17} /><span>{file.path}<small>{t(`rooms.sync.status.${file.status}`)}{file.detail && !['conflict', 'deferred'].includes(file.status) && ` · ${file.detail}`}</small>
                  {file.orphaned && <small>{t('rooms.sync.checkpointLocal')}</small>}
                  {file.status === 'conflict' && !file.resolvable && !file.pathResolvable && <small>{t('rooms.sync.conflictManual')}</small>}
                </span>{!file.deleted && <small>{formatBytes(file.size)}</small>}</div><div className="room-sync-document-actions">
                {file.resolvable && <div className="room-sync-actions">
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void work(async () => {
                    if (file.deleted) { const reviewed = await window.api.rooms.fileSync.prepareDelete(roomId, root.rootId, file.entryId, true); if (mounted.current) setDeletion(reviewed); return; }
                    const reviewed = await window.api.rooms.fileSync.conflict(roomId, root.rootId, file.entryId);
                    if (mounted.current) { setConflict(reviewed); setResolvedCopy(null); }
                  }); }}>{t('rooms.sync.conflictReview')}</Button>
                  {file.status !== 'deferred' && <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void defer(root.rootId, file.entryId); }}>{t('rooms.sync.conflictDefer')}</Button>}
                </div>}
                <Button variant="secondary" size="sm" data-sync-entry-history icon={<Icon name="clock" size={14} />} disabled={busy} onClick={() => { setHistoryTarget({ rootId: root.rootId, entryId: file.entryId, offset: 0 }); setHistory(null); }}>{t('rooms.sync.history')}</Button>
                {file.pathResolvable && <Button variant="secondary" size="sm" data-sync-path-open disabled={busy} onClick={() => { void loadPaths(root.rootId, file.entryId); }}>{t('rooms.sync.pathTitle')}</Button>}
                {file.movable && <Button variant="secondary" size="sm" disabled={busy} onClick={() => { setMoveTarget({ rootId: root.rootId, entryId: file.entryId, path: file.path }); setMovePath(file.path); setMoveReview(null); }}>{t('rooms.sync.move')}</Button>}
                {file.deletable && <Button variant="danger" size="sm" data-sync-delete iconOnly icon={<Icon name="trash" size={15} />} title={t('rooms.sync.deleteTitle')} aria-label={`${t('rooms.sync.deleteTitle')}: ${file.path}`} disabled={busy} onClick={() => { void loadDelete(root.rootId, file.entryId); }} />}
                {file.editable && <Button variant="primary" size="sm" data-sync-open-editor icon={<Icon name="edit-2" size={14} />} disabled={busy} onClick={() => { void work(async () => {
                  const draft = await window.api.rooms.fileSync.openEditor(roomId, root.rootId, file.entryId);
                  if (mounted.current) { if (onOpenEditor) onOpenEditor(draft); else setEditorDraft(draft); } else void window.api.rooms.fileSync.closeEditor(roomId, draft.token).catch(() => {});
                }); }}>{t('rooms.sync.editorOpen')}</Button>}
              </div></div>)}
              {page.items.length === 0 && <p>{t('rooms.sync.noFiles')}</p>}
            </div>
            <div className="room-sync-actions">
              {offset > 0 && <Button variant="secondary" size="sm" disabled={busy} onClick={() => setOffset(Math.max(0, offset - 100))}>{t('rooms.sync.previous')}</Button>}
              {page.next !== null && <Button variant="secondary" size="sm" disabled={busy} onClick={() => setOffset(page.next!)}>{t('rooms.sync.next')}</Button>}
            </div>
          </>}
          {historyTarget?.rootId === root.rootId && history && <section className="room-sync-history" aria-label={t('rooms.sync.history')}>
            <strong>{t('rooms.sync.history')} · {history.path}</strong>
            <p>{t('rooms.sync.historyHint')}</p>
            <p>{t('rooms.sync.historyFetchHint')}</p>
            {historyNotice && <p className="room-sync-notice" role="status">{historyNotice}</p>}
            {history.canFetch && <Button variant="secondary" size="sm" data-sync-history-fetch disabled={busy} onClick={() => { void work(async () => {
              setHistoryNotice('');
              const result = await window.api.rooms.fileSync.fetchHistory(roomId, root.rootId, historyTarget.entryId);
              if (mounted.current) {
                setHistoryNotice(t(`rooms.sync.historyFetch.${result.state}`).replace('{n}', String(result.epochs)));
                setHistoryTarget({ ...historyTarget, offset: 0 });
              }
            }); }}>{t('rooms.sync.historyFetch')}</Button>}
            {(history.branches ?? 0) > 1 && <p className="room-sync-notice">{t('rooms.sync.mergeHint').replace('{n}', String(history.branches))}</p>}
            <div className="room-sync-files">
              {initialRevisionId && <p role="status">{t(history.items.some(version => version.revisionId === initialRevisionId) ? 'rooms.objects.versionListed' : 'rooms.objects.versionNotListed')} <code>{initialRevisionId.slice(0, 12)}</code></p>}
              {history.items.map(version => <div className="room-sync-file" key={version.revisionId} data-requested-version={version.revisionId === initialRevisionId}>
                <span>{new Date(version.createdAt).toLocaleString()}<small>{version.revisionId.slice(0, 12)} · {t(version.current ? 'rooms.sync.versionCurrent' : version.local ? 'rooms.sync.versionLocal' : 'rooms.sync.versionRemote')}{root.multiWriter && version.authorId && ` · ${version.authorId.slice(0, 12)}`}</small></span>
                <span>{version.deleted ? t('rooms.sync.status.deleted') : formatBytes(version.size)}</span>
                <RoomObjectCopy target={{ kind: 'project', rootId: root.rootId, entryId: historyTarget.entryId, revisionId: version.revisionId, name: history.path }} />
                {history.canRestore && !version.deleted && <Button variant="secondary" size="sm" disabled={busy || version.current && (history.branches ?? 1) < 2} onClick={() => { void work(async () => {
                  const reviewed = await window.api.rooms.fileSync.prepareRestore(roomId, root.rootId, version.revisionId);
                  if (mounted.current) setRestore(reviewed);
                }); }}>{t('rooms.sync.restore')}</Button>}
              </div>)}
            </div>
            <div className="room-sync-actions">
              {historyTarget.offset > 0 && <Button variant="secondary" size="sm" disabled={busy} onClick={() => setHistoryTarget({ ...historyTarget, offset: Math.max(0, historyTarget.offset - 50) })}>{t('rooms.sync.previous')}</Button>}
              {history.next !== null && <Button variant="secondary" size="sm" disabled={busy} onClick={() => setHistoryTarget({ ...historyTarget, offset: history.next! })}>{t('rooms.sync.next')}</Button>}
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => { setHistoryTarget(null); setHistory(null); }}>{t('common.close')}</Button>
            </div>
          </section>}
        </article>)}
      </>)}
    </div>
  </RoomToolSurface>{editorDraft && <Suspense fallback={null}><RoomFileEditorModal roomId={roomId} initial={editorDraft} onClose={() => { setEditorDraft(null); void refresh(); }} /></Suspense>}</>;
}
