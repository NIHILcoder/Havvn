import { ErrorMessage } from '../../components/ErrorMessage';
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo, redo, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { syntaxHighlighting, bracketMatching } from '@codemirror/language';
import { fileEditorSyntax } from './file-editor-syntax';
import { roomEditorHighlight } from './room-editor-theme';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/Button';
import { RoomToolSurface, type EmbeddedRoomTool } from './RoomToolSurface';
import { useConfirm } from '../../components/ConfirmDialog';
import { pageLeave } from '../../state/page-leave';
import { useTranslation } from '../../utils/i18nContext';
import { useHostWindow } from '../../utils/hostWindow';
import { validSyncEditorText, type SyncEditorDraft } from '../../../shared/room-file-sync-editor';
import type { SyncWorkView } from '../../../shared/room-file-sync-ui';
import './RoomFileEditorModal.css';
import './RoomTextEditor.css';
import { RoomObjectCopy } from '../../components/RoomObjectCopy';
const CollaborativeEditor = lazy(() => import('./RoomDocumentsEditor').then(m => ({ default: m.RoomDocumentsEditor })));

/** A local file buffer. Signed file revisions remain its source of truth; this is not a CRDT document. */
export function RoomFileEditorModal({ roomId, initial, onClose, work, onCancelWork, canceling, embedded, registerClose, onDocumentCopy }: { roomId: string; initial: SyncEditorDraft; onClose(): void; work?: SyncWorkView; onCancelWork?(): Promise<void>; canceling?: boolean; onDocumentCopy?(seed: { title: string; text: string }): void } & EmbeddedRoomTool) {
  const { t } = useTranslation(), host = useHostWindow();
  const { confirm } = useConfirm();
  const [draft, setDraft] = useState(initial), [text, setText] = useState(initial.text), [savedText, setSavedText] = useState(initial.text);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [discard, setDiscard] = useState<'close' | 'reload' | null>(null), [stale, setStale] = useState(false), [generation, setGeneration] = useState(0);
  const [wrap, setWrap] = useState(true);
  const [collaborative, setCollaborative] = useState(false), [canCreateDocument, setCanCreateDocument] = useState(false);
  useEffect(() => { let alive = true; void window.api.rooms.documents?.view(roomId).then(v => { if (alive) setCanCreateDocument(v.canCreate); }).catch(() => {}); return () => { alive = false; }; }, [roomId]);
  const mount = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null), active = useRef(true), working = useRef(false);
  const token = useRef(initial.token), initialText = useRef(initial.text), saveRef = useRef<() => void>(() => {});
  const access = useRef(new Compartment()), wrapping = useRef(new Compartment());
  const dirty = text !== savedText, valid = validSyncEditorText(text);
  useEffect(() => {
    registerClose?.(async () => {
      if (working.current) { setError(t('navigation.waitWork')); return false; }
      return !dirty || await confirm({ title: t('rooms.sync.editorDirty'), message: t('rooms.sync.editorDiscardHint'), confirmLabel: t('settings.discardAndLeave'), cancelLabel: t('rooms.sync.editorContinue') });
    });
    return () => registerClose?.(null);
  }, [registerClose, dirty, confirm, t]);
  useEffect(() => { editor.current?.setRoot(host.document); editor.current?.requestMeasure(); }, [host]);
  useEffect(() => pageLeave.register(async () => {
    if (working.current) { setError(t('navigation.waitWork')); return false; }
    return !dirty || await confirm({ title: t('rooms.sync.editorDirty'), message: t('rooms.sync.editorDiscardHint'),
      confirmLabel: t('settings.discardAndLeave'), cancelLabel: t('rooms.sync.editorContinue') });
  }), [dirty, confirm, t]);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; void window.api.rooms.fileSync.closeEditor(roomId, token.current).catch(() => {}); };
  }, [roomId]);
  useEffect(() => {
    if (!mount.current) return;
    const phrases = Object.fromEntries((['Find', 'Replace', 'next', 'previous', 'all', 'match case', 'regexp', 'by word', 'replace', 'replace all', 'close', 'Go to line', 'go'] as const).map(key => [key, t(`rooms.sync.editorPhrase.${key}`)]));
    const view = new EditorView({ parent: mount.current, state: EditorState.create({ doc: initialText.current, extensions: [
      lineNumbers(), highlightActiveLine(), highlightSpecialChars(), drawSelection(), history(), bracketMatching(), search({ top: true }),
      syntaxHighlighting(roomEditorHighlight), EditorState.phrases.of(phrases), EditorState.tabSize.of(4),
      access.current.of(EditorState.readOnly.of(!initial.writable)), wrapping.current.of(EditorView.lineWrapping),
      fileEditorSyntax(initial),
      EditorView.contentAttributes.of({ 'aria-label': t('rooms.sync.editorBuffer'), spellcheck: 'false' }),
      keymap.of([{ key: 'Mod-s', run: () => { saveRef.current(); return true; } }, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      EditorView.updateListener.of(update => { if (update.docChanged) { initialText.current = update.state.doc.toString(); setText(initialText.current); setNotice(''); } }),
    ] }) });
    editor.current = view; view.focus();
    return () => { editor.current = null; view.destroy(); };
  }, [generation, initial, t]);
  useEffect(() => { editor.current?.dispatch({ effects: access.current.reconfigure(EditorState.readOnly.of(!draft.writable || busy)) }); }, [draft.writable, busy, generation]);
  useEffect(() => { editor.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) }); }, [wrap, generation]);
  const run = async (action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (cause) { if (active.current) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message.includes('Sync preparation canceled') ? t('rooms.sync.workCanceled') : message);
    } }
    finally { working.current = false; if (active.current) setBusy(false); }
  };
  const save = () => {
    if (!draft.writable || !dirty || !valid || stale) return;
    void run(async () => {
      try {
        const result = await window.api.rooms.fileSync.saveEditor(roomId, token.current, text);
        if (!active.current) return;
        setSavedText(text); setNotice(t('rooms.sync.editorSaved')); setStale(!result.draft);
        if (result.draft) { token.current = result.draft.token; setDraft(result.draft); }
      } catch (cause) { if (active.current) setStale(true); throw cause; }
    });
  };
  saveRef.current = save;
  const reload = () => { void run(async () => {
    const next = await window.api.rooms.fileSync.openEditor(roomId, draft.rootId, draft.entryId);
    if (!active.current) { void window.api.rooms.fileSync.closeEditor(roomId, next.token).catch(() => {}); return; }
    void window.api.rooms.fileSync.closeEditor(roomId, token.current).catch(() => {});
    token.current = next.token; initialText.current = next.text; setDraft(next); setText(next.text); setSavedText(next.text); setStale(false); setNotice(''); setDiscard(null); setGeneration(n => n + 1);
  }); };
  const close = () => { if (working.current) return; if (embedded) onClose(); else if (dirty) setDiscard('close'); else onClose(); };
  const workNotice = busy && work ? <div className="room-sync-library-work" data-sync-editor-work>
    <p role="status">{work.waiting ? t('rooms.sync.workWaiting').replace('{n}', String(work.position ?? 1)) : t('rooms.sync.workActive')}<small>{t('rooms.sync.workCancelNote')}</small></p>
    {onCancelWork && <Button variant="ghost" size="sm" title={t('rooms.sync.workCancelHint')} disabled={canceling} loading={canceling}
      onClick={() => { void onCancelWork(); }}>{t('rooms.sync.workCancel')}</Button>}
  </div> : null;
  return <RoomToolSurface embedded={embedded} title={t('rooms.editor.diskMode')} icon="file-text" size="xl" className="room-file-editor-modal" backdropClassName="room-file-editor-backdrop" busy={busy} onClose={close}
    footer={discard ? <>
      <Button variant="secondary" disabled={busy} onClick={() => setDiscard(null)}>{t('rooms.sync.editorContinue')}</Button>
      <Button variant="primary" disabled={busy} onClick={() => discard === 'close' ? onClose() : reload()}>{t('rooms.sync.editorDiscard')}</Button>
    </> : workNotice ?? <>
      <Button variant="secondary" disabled={busy} onClick={close}>{t('common.close')}</Button>
      {draft.writable && <Button variant="primary" disabled={busy || !dirty || !valid || stale} loading={busy} onClick={save}>{t('rooms.sync.editorSave')}</Button>}
    </>}>
    <div className="room-file-editor-panel" aria-busy={busy}>
      <div className="room-editor-mode" data-editor-mode="disk"><strong>{t('rooms.editor.diskMode')}</strong><span role="status">{t(busy ? 'rooms.editor.diskSaving' : stale ? 'rooms.editor.diskStale' : dirty ? 'rooms.editor.diskUnsaved' : 'rooms.editor.diskSaved')}</span></div>
      <div className="room-file-editor-heading"><Icon name="file-text" size={18} /><code>{draft.path}</code><span role="status" className={dirty ? 'is-dirty' : ''}>{t(dirty ? 'rooms.sync.editorDirty' : 'rooms.sync.editorClean')}</span></div>
      <p className="room-file-editor-description">{t('rooms.sync.editorHint')}</p>
      {draft.localChanges && <p className="room-sync-notice">{t('rooms.sync.editorLocalChanges')}</p>}
      {!draft.writable && <p className="room-sync-notice">{t('rooms.sync.editorReadOnly')}</p>}
      {discard && <p role="alert" className="room-sync-error">{t('rooms.sync.editorDiscardHint')}</p>}
      {error && <p role="alert" className="room-sync-error"><ErrorMessage error={error} /></p>}
      {stale && <p className="room-sync-notice">{t('rooms.sync.editorStale')}</p>}
      {!valid && <p role="alert" className="room-sync-error">{t('rooms.sync.editorInvalid')}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="room-file-editor-toolbar" role="toolbar" aria-label={t('rooms.sync.editor')}>
        <RoomObjectCopy target={{ kind: 'project', rootId: draft.rootId, entryId: draft.entryId, name: draft.path }} />
        <div className="room-file-editor-tools">
          <Button variant="ghost" size="sm" iconOnly icon={<Icon name="rotate-ccw" size={16} />} title={t('rooms.sync.editorUndo') + ' · Ctrl+Z'} aria-label={t('rooms.sync.editorUndo')} disabled={busy || !draft.writable} onClick={() => { if (editor.current) undo(editor.current); }} />
          <Button variant="ghost" size="sm" iconOnly icon={<Icon name="rotate-cw" size={16} />} title={t('rooms.sync.editorRedo') + ' · Ctrl+Shift+Z'} aria-label={t('rooms.sync.editorRedo')} disabled={busy || !draft.writable} onClick={() => { if (editor.current) redo(editor.current); }} />
        </div>
        <div className="room-file-editor-tools">
          <Button variant="ghost" size="sm" iconOnly icon={<Icon name="search" size={16} />} title={t('rooms.sync.editorFind')} aria-label={t('rooms.sync.editorFind')} disabled={busy} onClick={() => { if (editor.current) openSearchPanel(editor.current); }} />
          <Button variant="ghost" size="sm" iconOnly icon={<Icon name="wrap-text" size={16} />} title={t('rooms.sync.editorWrap')} aria-label={t('rooms.sync.editorWrap')} disabled={busy} aria-pressed={wrap} onClick={() => setWrap(old => !old)} />
          <Button variant="ghost" size="sm" iconOnly icon={<Icon name="copy" size={16} />} title={t('rooms.sync.editorCopy')} aria-label={t('rooms.sync.editorCopy')} disabled={busy} onClick={() => { void run(async () => { await host.window.navigator.clipboard.writeText(text); if (active.current) setNotice(t('rooms.sync.editorCopied')); }); }} />
          <Button variant="ghost" size="sm" iconOnly icon={<Icon name="refresh" size={16} />} title={t('rooms.sync.editorReload')} aria-label={t('rooms.sync.editorReload')} disabled={busy} onClick={() => dirty ? setDiscard('reload') : reload()} />
        </div>
        {canCreateDocument && <Button className="room-file-editor-collaborate" variant="secondary" size="sm" icon={<Icon name="users" size={14} />} disabled={busy || new TextEncoder().encode(text).length > 256 * 1024} onClick={() => onDocumentCopy ? onDocumentCopy({ title: draft.path.split('/').at(-1)?.slice(0, 120) || 'Document', text }) : setCollaborative(true)}>{t('rooms.docs.fromFile')}</Button>}
      </div>
      <div className="room-file-editor-buffer room-text-editor" ref={mount} />
      {collaborative && <Suspense fallback={null}><CollaborativeEditor roomId={roomId} aboveFileEditor seed={{ title: draft.path.split('/').at(-1)?.slice(0, 120) || 'Document', text }} onClose={() => setCollaborative(false)} /></Suspense>}
      <div className="room-file-editor-status"><span>UTF-8{draft.bom ? ' BOM' : ''} · {draft.newline.toUpperCase()}</span><span>{text.split('\n').length} {t('rooms.sync.editorLines')}</span><span title={draft.revisionId}>{draft.path.match(/\.([a-z0-9]{1,12})$/i)?.[1].toUpperCase() || 'TEXT'}</span></div>
    </div>
  </RoomToolSurface>;
}
