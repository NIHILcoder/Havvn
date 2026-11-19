import { ErrorMessage } from '../../components/ErrorMessage';
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { yCollab, yUndoManagerKeymap, ySyncAnnotation } from 'y-codemirror.next';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel, gotoLine } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, bracketMatching } from '@codemirror/language';
import { roomEditorHighlight } from './room-editor-theme';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Modal } from '../../components/Modal';
import { RoomToolSurface, type EmbeddedRoomTool } from './RoomToolSurface';
import { RoomObjectCopy } from '../../components/RoomObjectCopy';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { useConfirm } from '../../components/ConfirmDialog';
import { useTranslation } from '../../utils/i18nContext';
import { useHostWindow } from '../../utils/hostWindow';
import { DOCUMENT_TEXT_BYTES, DOCUMENT_LIMIT, validDocumentText, type DocumentsView, type DocumentOpenView, type DocumentLocalSnapshot, type DocumentCursor } from '../../../shared/room-documents';
import { documentBytes, documentBase64, DocumentAwareness } from './document-session';
import { documentSaveStatus } from './document-save-status';
import { pageLeave } from '../../state/page-leave';
import './RoomDocuments.css';
import './RoomTextEditor.css';
import './RoomDocumentExtensions.css';
import { DOCUMENT_TEMPLATES, documentTemplate, type DocumentTemplateId } from '../../../shared/document-templates';

const REMOTE = 'havvn-confirmed';
type Mode = 'source' | 'split' | 'preview';
const failure = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const Preview = React.memo(function Preview({ text, font }: { text: string; font: number }) {
  return <article className="hd-preview" data-docs-preview style={{ fontSize: font }}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: ({ alt }) => <span className="hd-image-placeholder">[{alt || 'image'}]</span>,
    a: ({ children, href }) => <a href={href && /^https?:\/\//i.test(href) ? href : undefined} target="_blank" rel="noopener noreferrer">{children}</a>,
  }}>{text}</ReactMarkdown></article>;
});
export function RoomDocumentsEditor({ roomId, onClose, seed, aboveFileEditor, embedded, registerClose, visible = true, initialDocumentId, openRequestRevision = 0 }: { roomId: string; onClose(): void; seed?: { title: string; text: string }; aboveFileEditor?: boolean; visible?: boolean; initialDocumentId?: string; openRequestRevision?: number } & EmbeddedRoomTool) {
  const { t, language: uiLanguage } = useTranslation(), host = useHostWindow(), { confirm } = useConfirm();
  const [catalog, setCatalog] = useState<DocumentsView | null>(null), [tabs, setTabs] = useState<DocumentOpenView[]>([]), [selected, setSelected] = useState('');
  const [query, setQuery] = useState(''), [showArchived, setShowArchived] = useState(false), [creating, setCreating] = useState(!!seed), [sidebar, setSidebar] = useState(() => host.window.innerWidth > 570);
  const [title, setTitle] = useState(seed?.title ?? ''), [language, setLanguage] = useState<'markdown' | 'text'>(() => !seed || /\.(md|markdown)$/i.test(seed.title) ? 'markdown' : 'text'), [writers, setWriters] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [template, setTemplate] = useState<DocumentTemplateId>('blank'), [initialText, setInitialText] = useState(seed?.text ?? '');
  const templateBase = useRef(seed?.text ?? ''), newDraftStarted = useRef(!!seed);
  const guardCreateDraft = useRef<() => Promise<boolean>>(async () => true);
  guardCreateDraft.current = async () => !(title.trim() || initialText.trim()) || await confirm({ message: t('rooms.docs.discardNewDraft'), danger: true });
  const [catalogError, setCatalogError] = useState('');
  const alive = useRef(true), opening = useRef(false), latest = useRef(tabs), closers = useRef(new Map<string, () => Promise<void>>()); latest.current = tabs;
  useEffect(() => { const resized = () => { if (host.window.innerWidth <= 570) setSidebar(false); }; host.window.addEventListener('resize', resized); return () => host.window.removeEventListener('resize', resized); }, [host]);
  useEffect(() => {
    alive.current = true; let reading = false;
    const refresh = async () => { if (reading) return; reading = true; try { const view = await window.api.rooms.documents.view(roomId); if (alive.current) { setCatalog(view); setCatalogError(''); } } catch (cause) { if (alive.current) setCatalogError(failure(cause)); } finally { reading = false; } };
    void refresh(); const timer = host.window.setInterval(refresh, 2000);
    return () => { alive.current = false; host.window.clearInterval(timer); };
  }, [roomId, host]);
  useEffect(() => () => { latest.current.forEach(d => { void window.api.rooms.documents.close(roomId, d.token).catch(() => {}); }); }, [roomId]);
  const run = async (action: () => Promise<void>) => { if (opening.current) return; opening.current = true; setBusy(true); setError(''); try { await action(); } catch (cause) { if (alive.current) setError(failure(cause)); } finally { opening.current = false; if (alive.current) setBusy(false); } };
  const open = (id: string) => {
    if (host.window.innerWidth <= 570) setSidebar(false);
    if (tabs.some(d => d.documentId === id)) { setSelected(id); setCreating(false); return; }
    void run(async () => { if (latest.current.length >= 8) throw new Error(t('rooms.docs.tabLimit')); const value = await window.api.rooms.documents.open(roomId, id);
      if (!alive.current) { await window.api.rooms.documents.close(roomId, value.token); return; } setTabs(old => [...old, value]); setSelected(id); setCreating(false); });
  };
  const closeTab = async (id: string) => {
    const tab = latest.current.find(d => d.documentId === id); if (!tab) return;
    await closers.current.get(id)?.(); await window.api.rooms.documents.close(roomId, tab.token);
    const next = latest.current.filter(d => d.documentId !== id); setTabs(next); if (selected === id) setSelected(next.at(-1)?.documentId ?? '');
  };
  const requested = useRef(''), requestedOpen = useRef(open); requestedOpen.current = open;
  useEffect(() => {
    const key = `${initialDocumentId}:${openRequestRevision}`;
    if (!initialDocumentId || !catalog || requested.current === key) return;
    requested.current = key;
    if (!catalog.enabled || !catalog.items.some(item => item.documentId === initialDocumentId)) { setError(t('rooms.objects.unavailable')); return; }
    requestedOpen.current(initialDocumentId);
  }, [catalog, initialDocumentId, openRequestRevision, t]);
  const close = () => { void run(async () => { if (!await guardCreateDraft.current()) return; for (const tab of latest.current) await closers.current.get(tab.documentId)?.(); onClose(); }); };
  useEffect(() => {
    registerClose?.(async () => {
      if (opening.current) { setError(t('navigation.waitWork')); return false; }
      if (!await guardCreateDraft.current()) return false;
      try { for (const tab of latest.current) await closers.current.get(tab.documentId)?.(); return true; }
      catch (cause) { if (alive.current) setError(failure(cause)); return false; }
    });
    return () => registerClose?.(null);
  }, [registerClose, t]);
  useEffect(() => pageLeave.register(async () => {
    if (opening.current) { setError(t('navigation.waitWork')); return false; }
    if (!await guardCreateDraft.current()) return false;
    try { for (const tab of latest.current) await closers.current.get(tab.documentId)?.(); return true; }
    catch (cause) { if (alive.current) setError(failure(cause)); return false; }
  }), [roomId, t]);
  const create = () => { void run(async () => {
    if (!catalog) return;
    if (!validDocumentText(initialText)) throw new Error('Invalid document text');
    const result = await window.api.rooms.documents.create(roomId, title.trim(), language, initialText, [...new Set([catalog.ownerId, ...writers])]);
    setTitle(''); setInitialText(''); templateBase.current = ''; setTemplate('blank'); newDraftStarted.current = false;
    const value = await window.api.rooms.documents.open(roomId, result.documentId);
    if (!alive.current) { await window.api.rooms.documents.close(roomId, value.token); return; }
    setTabs(old => [...old, value]); setSelected(value.documentId); setCreating(false); setCatalog(await window.api.rooms.documents.view(roomId));
  }); };
  return <RoomToolSurface embedded={embedded} size="full" className="hd-modal" backdropClassName={aboveFileEditor ? 'room-documents-overlay' : undefined} bodyClassName="hd-body" icon="book-open" title={t('rooms.editor.documentMode')} onClose={close} busy={busy} closeOnBackdrop={false}>
    <div className="hd-workspace">
      <div className="room-editor-mode" data-editor-mode="document"><strong>{t('rooms.editor.documentMode')}</strong><span>{t('rooms.editor.documentHint')}</span></div>
      <div className="hd-topbar"><button className="hd-icon" onClick={() => setSidebar(v => !v)} title={t('rooms.docs.library')} aria-label={t('rooms.docs.library')} aria-pressed={sidebar}><Icon name="list" size={17} /></button><span className="hd-eyebrow">{t('rooms.docs.workspace')}</span><span className="hd-network"><i className={catalog?.ownerOnline ? 'online' : ''} />{t(catalog?.ownerOnline ? 'rooms.docs.connected' : 'rooms.docs.offline')}</span></div>
      <div className={'hd-layout' + (sidebar ? '' : ' hd-hide-sidebar')}>
        <aside className="hd-sidebar"><div className="hd-sidebar-heading"><strong>{t('rooms.docs.library')}</strong><span>{catalog?.items.length ?? 0}</span></div>
          <label className="hd-search"><Icon name="search" size={14} /><input aria-label={t('rooms.docs.search')} placeholder={t('rooms.docs.search')} value={query} onChange={e => setQuery(e.target.value)} /></label>
          <button data-docs-new className="btn btn-primary btn-sm hd-primary" disabled={!catalog?.canCreate || catalog.items.length >= DOCUMENT_LIMIT || busy || tabs.length >= 8} onClick={() => { if (host.window.innerWidth <= 570) setSidebar(false); setCreating(true); if (!newDraftStarted.current) { newDraftStarted.current = true; setWriters(catalog ? [catalog.ownerId, ...catalog.members.filter(m => m.capable && m.memberId !== catalog.ownerId).slice(0, 31).map(m => m.memberId)] : []); } }}><Icon name="plus" size={15} />{t('rooms.docs.new')}</button>
          <div className="hd-document-list">{catalog?.items.filter(d => (showArchived || !d.archived) && d.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(d => <button key={d.documentId} data-docs-document={d.documentId} className={'hd-document' + (selected === d.documentId && !creating ? ' active' : '')} onClick={() => open(d.documentId)} disabled={busy}>
            <span className="hd-document-symbol">{d.language === 'markdown' ? 'M↓' : 'Aa'}</span><span><strong>{d.title}</strong><small>{t(d.archived ? 'rooms.docs.archived' : d.writable ? 'rooms.docs.canEdit' : 'rooms.docs.readOnly')}{d.pending ? ' · ' + d.pending + ' ↑' : ''}{d.accessRequestCount ? ' · ' + t('rooms.docs.requests') + ': ' + d.accessRequestCount : ''}</small></span></button>)}</div>
          <label className="hd-check"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />{t('rooms.docs.showArchived')}</label>
          <p className="hd-sidebar-hint"><Icon name="users" size={16} />{t('rooms.docs.sidebarHint')}</p>
        </aside>
        <main className="hd-main">
          {(error || catalogError) && <div className="hd-error" role="alert"><ErrorMessage error={error || catalogError} /></div>}
          {!!tabs.length && <div className="hd-tabs" role="tablist" aria-label={t('rooms.docs.openTabs')}>{tabs.map(d => <div className={'hd-tab' + (selected === d.documentId && !creating ? ' active' : '')} key={d.documentId}><button role="tab" aria-selected={selected === d.documentId && !creating} onClick={() => { setSelected(d.documentId); setCreating(false); }}>{catalog?.items.find(i => i.documentId === d.documentId)?.title ?? d.title}</button><button aria-label={t('common.close') + ' ' + d.title} onClick={() => { void run(() => closeTab(d.documentId)); }}><Icon name="x" size={14} /></button></div>)}</div>}
          {creating ? <form className="hd-create" onSubmit={e => { e.preventDefault(); create(); }}><span className="hd-create-symbol"><Icon name="file-plus" size={28} /></span><span className="hd-eyebrow">{t('rooms.docs.together')}</span><h2>{t('rooms.docs.new')}</h2><p>{t('rooms.docs.createHint')}</p>
            <label>{t('rooms.docs.name')}<input data-docs-title disabled={busy} required maxLength={120} autoFocus value={title} placeholder={t('rooms.docs.namePlaceholder')} onChange={e => setTitle(e.target.value)} /></label>
            <div className="hd-field"><span>{t('rooms.docs.template')}</span><Select disabled={busy} ariaLabel={t('rooms.docs.template')} value={template} options={DOCUMENT_TEMPLATES.map(id => ({ value: id, label: t(`rooms.docs.template.${id}`) }))} onChange={value => { void (async () => {
              if (initialText !== templateBase.current && initialText.trim() && !await confirm({ message: t('rooms.docs.templateReplace') })) return;
              const next = documentTemplate(value as DocumentTemplateId, uiLanguage);
              setTemplate(value as DocumentTemplateId); setInitialText(next.text); templateBase.current = next.text; setLanguage(next.language);
              if (!title.trim() || title === documentTemplate(template, uiLanguage).title) setTitle(next.title);
            })(); }} /></div>
            <p>{t('rooms.docs.templateHint')}</p>
            <label>{t('rooms.docs.initialText')}<textarea data-docs-initial-text disabled={busy} value={initialText} maxLength={DOCUMENT_TEXT_BYTES} rows={7} onChange={e => setInitialText(e.target.value)} /></label>
            <div className="hd-field"><span>{t('rooms.docs.format')}</span><Select disabled={busy} ariaLabel={t('rooms.docs.format')} value={language} onChange={value => setLanguage(value as 'markdown' | 'text')} options={[{ value: 'markdown', label: 'Markdown' }, { value: 'text', label: t('rooms.docs.plain') }]} /></div>
            <fieldset disabled={busy}><legend>{t('rooms.docs.writers')}</legend>{catalog?.members.filter(m => m.capable).map(m => <label className="hd-check" key={m.memberId}><input type="checkbox" checked={m.memberId === catalog.ownerId || writers.includes(m.memberId)} disabled={m.memberId === catalog.ownerId || !writers.includes(m.memberId) && new Set([catalog.ownerId, ...writers]).size >= 32} onChange={e => setWriters(old => e.target.checked ? [...old, m.memberId] : old.filter(id => id !== m.memberId))} />{m.name}<small>{m.online ? '●' : '○'}</small></label>)}</fieldset>
            {seed && <p>{t('rooms.docs.importCopy')}</p>}<button className="btn btn-primary btn-sm hd-primary" disabled={busy || !title.trim() || !catalog?.canCreate} type="submit">{t('rooms.docs.create')}</button>
          </form> : !catalog ? <div className="hd-empty" role="status">{t('common.loading')}</div> : tabs.length === 0 ? <div className="hd-empty"><Icon name="book-open" size={46} /><h2>{t('rooms.docs.empty')}</h2><p>{t(catalog?.canCreate ? 'rooms.docs.emptyOwner' : 'rooms.docs.emptyReader')}</p></div> : null}
          {tabs.map(d => <DocumentBuffer key={d.token} roomId={roomId} initial={d} catalog={catalog} visible={visible && selected === d.documentId && !creating} register={flush => { if (flush) closers.current.set(d.documentId, flush); else closers.current.delete(d.documentId); }} confirm={confirm} />)}
        </main>
      </div>
    </div>
  </RoomToolSurface>;
}

function DocumentBuffer({ roomId, initial, catalog, visible, register, confirm }: {
  roomId: string; initial: DocumentOpenView; catalog: DocumentsView | null; visible: boolean;
  register(flush: (() => Promise<void>) | null): void; confirm: ReturnType<typeof useConfirm>['confirm'];
}) {
  const { t } = useTranslation(), host = useHostWindow();
  const [view, setView] = useState(initial), [text, setText] = useState(() => { const d = new Y.Doc(); try { Y.applyUpdate(d, documentBytes(initial.state)); return d.getText('text').toString(); } finally { d.destroy(); } });
  const previewText = useDeferredValue(text);
  const [mode, setMode] = useState<Mode>('source'), [wrap, setWrap] = useState(true), [font, setFont] = useState(14), [focus, setFocus] = useState(false);
  const [unsaved, setUnsaved] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [position, setPosition] = useState({ line: 1, column: 1, selected: 0 });
  const [pollError, setPollError] = useState('');
  const [panel, setPanel] = useState<'history' | 'rights' | 'outline' | null>(null), [snapshots, setSnapshots] = useState<DocumentLocalSnapshot[]>([]), [snapshotLabel, setSnapshotLabel] = useState('');
  const [previewSnapshot, setPreviewSnapshot] = useState<DocumentLocalSnapshot | null>(null), [policyTitle, setPolicyTitle] = useState(initial.title), [policyWriters, setPolicyWriters] = useState(initial.writers), [policyArchived, setPolicyArchived] = useState(initial.archived), [policyExpected, setPolicyExpected] = useState(initial.policyId);
  const mount = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null), live = useRef(true), latest = useRef(view), updates = useRef<Uint8Array[]>([]), sending = useRef<Promise<void> | null>(null);
  useEffect(() => { editor.current?.setRoot(host.document); editor.current?.requestMeasure(); }, [host]);
  const actionBusy = useRef(false), saveAction = useRef<() => Promise<void>>(async () => {}), presenceAction = useRef<() => void>(() => {});
  const writeAccess = useRef(new Compartment()), wrapping = useRef(new Compartment()), language = useRef(new Compartment()); latest.current = view;
  const [generation, setGeneration] = useState(0), baseState = useRef(initial.state), retryAfter = useRef(0);
  const resource = useMemo(() => {
    const doc = new Y.Doc(); Y.applyUpdate(doc, documentBytes(baseState.current), REMOTE); const ytext = doc.getText('text'), undo = new Y.UndoManager(ytext);
    return { doc, ytext, undo, cursors: null as DocumentAwareness | null, disposal: undefined as number | undefined };
    // A deliberate draft review starts a new local binding; normal remote updates always merge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);
  const apply = useCallback((next: DocumentOpenView) => {
    if (!live.current || next.version < latest.current.version) return;
    if (next.state) Y.applyUpdate(resource.doc, documentBytes(next.state), REMOTE);
    resource.cursors?.apply(next.cursors); latest.current = next; setView(next);
  }, [resource]);
  const flush = useCallback(async (): Promise<void> => {
    if (sending.current) { await sending.current; if (updates.current.length) return flush(); return; }
    if (!updates.current.length) return;
    const task = (async () => {
      while (updates.current.length) {
        const batch = updates.current.splice(0), merged = Y.mergeUpdates(batch);
        try { apply(await window.api.rooms.documents.update(roomId, initial.token, documentBase64(merged))); if (live.current) setError(''); }
        catch (cause) {
          updates.current.unshift(...batch); retryAfter.current = Date.now() + 5000;
          try {
            const draftText = resource.ytext.toString();
            await window.api.rooms.documents.keepDraft(roomId, initial.token, draftText);
            const next = await window.api.rooms.documents.poll(roomId, initial.token, -1);
            if (next.blockedPending && next.state && draftText === resource.ytext.toString() && live.current) {
              // A permission/context race is now a durable local draft. Bind its saved state
              // once so the review controls work without replaying stale updates forever.
              updates.current = []; baseState.current = next.state; latest.current = next; setView(next);
              setGeneration(value => value + 1); setUnsaved(false); setError(''); return;
            }
          } catch { /* Keep the unsaved buffer visible if local storage also fails. */ }
          if (live.current) setError(failure(cause)); throw cause;
        }
      }
      if (live.current) setUnsaved(false);
    })(); sending.current = task;
    try { await task; } finally { sending.current = null; }
  }, [roomId, initial.token, apply, resource]); saveAction.current = flush;
  useEffect(() => {
    register(async () => {
      try { await flush(); }
      catch (cause) {
        await window.api.rooms.documents.keepDraft(roomId, initial.token, resource.ytext.toString());
        if (!await confirm({ title: t('rooms.docs.needsReview'), message: t('rooms.docs.closeUnsent'), confirmLabel: t('common.close') })) throw cause;
        updates.current = [];
      }
    }); return () => register(null);
  }, [register, flush, confirm, roomId, initial.token, resource, t]);
  useEffect(() => {
    live.current = true; let pollBusy = false;
    const changed = (update: Uint8Array, origin: unknown) => { if (origin === REMOTE) return; updates.current.push(update); setUnsaved(true); setNotice(''); };
    resource.doc.on('update', changed);
    const save = host.window.setInterval(() => { if (updates.current.length && Date.now() >= retryAfter.current) void flush().catch(() => {}); }, 500);
    const poll = host.window.setInterval(async () => {
      if (pollBusy || sending.current) return; pollBusy = true;
      try { apply(await window.api.rooms.documents.poll(roomId, initial.token, latest.current.version)); if (live.current) setPollError(''); }
      catch (cause) { if (live.current) setPollError(failure(cause)); } finally { pollBusy = false; }
    }, 700);
    const leaving = (event: BeforeUnloadEvent) => { if (updates.current.length || sending.current) { event.preventDefault(); event.returnValue = ''; void flush().catch(() => {}); } };
    const blurred = () => { if (updates.current.length) void flush().catch(() => {}); };
    host.window.addEventListener('beforeunload', leaving); host.window.addEventListener('blur', blurred);
    return () => { live.current = false; host.window.clearInterval(save); host.window.clearInterval(poll); host.window.removeEventListener('beforeunload', leaving); host.window.removeEventListener('blur', blurred); resource.doc.off('update', changed); if (updates.current.length) void flush().catch(() => {}); };
  }, [resource, roomId, initial.token, host, apply, flush]);
  useEffect(() => {
    if (!mount.current) return;
    const awareness = new Awareness(resource.doc); resource.cursors = new DocumentAwareness(awareness, resource.ytext); resource.cursors.apply(latest.current.cursors);
    const phrases = Object.fromEntries((['Find', 'Replace', 'next', 'previous', 'all', 'match case', 'regexp', 'by word', 'replace', 'replace all', 'close', 'Go to line', 'go'] as const).map(key => [key, t(`rooms.sync.editorPhrase.${key}`)]));
    const cm = new EditorView({ parent: mount.current, state: EditorState.create({ doc: resource.ytext.toString(), extensions: [
      yCollab(resource.ytext, awareness, { undoManager: resource.undo }), lineNumbers(), highlightActiveLine(), drawSelection(), bracketMatching(), search({ top: true }), syntaxHighlighting(roomEditorHighlight),
      language.current.of(initial.language === 'markdown' ? markdown() : []), wrapping.current.of(EditorView.lineWrapping), writeAccess.current.of(EditorState.readOnly.of(!initial.writable || initial.blockedPending)),
      EditorState.phrases.of(phrases), EditorState.tabSize.of(2), EditorView.contentAttributes.of({ 'aria-label': t('rooms.docs.buffer'), spellcheck: 'false' }),
      EditorState.transactionFilter.of(transaction => !transaction.docChanged || transaction.annotation(ySyncAnnotation) || validDocumentText(transaction.newDoc.toString()) ? transaction : []),
      keymap.of([{ key: 'Mod-s', run: () => { void saveAction.current().catch(() => {}); return true; } }, ...yUndoManagerKeymap, ...searchKeymap, ...defaultKeymap, indentWithTab]),
      EditorView.updateListener.of(update => {
        if (update.docChanged) setText(update.state.doc.toString());
        if (update.docChanged || update.selectionSet) { const selection = update.state.selection.main, line = update.state.doc.lineAt(selection.head); setPosition({ line: line.number, column: selection.head - line.from + 1, selected: selection.to - selection.from }); presenceAction.current(); }
      }),
    ] }) }); editor.current = cm;
    return () => { editor.current = null; cm.destroy(); awareness.destroy(); resource.cursors = null; };
  }, [resource, initial.language, initial.writable, initial.blockedPending, t]);
  useEffect(() => {
    // StrictMode replays effects using the same resource; defer final disposal for one task.
    window.clearTimeout(resource.disposal);
    return () => { resource.disposal = window.setTimeout(() => { resource.undo.destroy(); resource.doc.destroy(); }, 0); };
  }, [resource]);
  useEffect(() => { editor.current?.dispatch({ effects: writeAccess.current.reconfigure(EditorState.readOnly.of(!view.writable || view.blockedPending || busy)) }); }, [view.writable, view.blockedPending, busy, generation]);
  useEffect(() => { editor.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) }); }, [wrap, generation]);
  useEffect(() => { if (visible) { editor.current?.requestMeasure(); editor.current?.focus(); } }, [visible, resource]);
  useEffect(() => {
    if (!visible) return; let last = 0, timer: number | undefined;
    const send = () => {
      host.window.clearTimeout(timer); const cm = editor.current; if (!cm || !live.current) return; last = Date.now();
      const selection = cm.state.selection.main, anchor = documentBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(resource.ytext, selection.anchor))), head = documentBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(resource.ytext, selection.head)));
      void window.api.rooms.documents.presence(roomId, initial.token, { clientId: resource.doc.clientID, anchor, head }).catch(() => {});
    };
    presenceAction.current = () => { if (Date.now() - last > 180) send(); else { host.window.clearTimeout(timer); timer = host.window.setTimeout(send, 180); } };
    send(); const heartbeat = host.window.setInterval(send, 8000);
    return () => { presenceAction.current = () => {}; host.window.clearInterval(heartbeat); host.window.clearTimeout(timer); void window.api.rooms.documents.presence(roomId, initial.token, { clientId: resource.doc.clientID, anchor: null, head: null }).catch(() => {}); };
  }, [visible, resource, roomId, initial.token, host]);
  const run = async (action: () => Promise<void>) => { if (actionBusy.current) return; actionBusy.current = true; setBusy(true); setError(''); try { await flush(); await action(); } catch (cause) { if (live.current) setError(failure(cause)); } finally { actionBusy.current = false; if (live.current) setBusy(false); } };
  const format = (before: string, after = before, line = false) => {
    const cm = editor.current; if (!cm || !view.writable || view.blockedPending || busy) return;
    const selection = cm.state.selection.main, from = line ? cm.state.doc.lineAt(selection.from).from : selection.from, to = selection.to, selectedText = cm.state.sliceDoc(from, to);
    cm.dispatch({ changes: { from, to, insert: before + selectedText + after }, selection: { anchor: from + before.length, head: from + before.length + selectedText.length } }); cm.focus();
  };
  const withEditor = (action: (cm: EditorView) => void) => { if (mode === 'preview') setMode('source'); host.window.requestAnimationFrame(() => { const cm = editor.current; if (cm) { cm.requestMeasure(); action(cm); cm.focus(); } }); };
  const followCursor = (cursor: DocumentCursor) => {
    try { if (!cursor.head) return; const p = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(documentBytes(cursor.head)), resource.doc);
      if (p?.type === resource.ytext) withEditor(cm => cm.dispatch({ selection: { anchor: p.index }, effects: EditorView.scrollIntoView(p.index, { y: 'center' }) }));
    } catch { /* Presence is ephemeral and never prevents editing. */ }
  };
  const review = (choice: 'apply' | 'discard') => { void run(async () => { if (!await confirm({ title: t('rooms.docs.review'), message: t('rooms.docs.reviewConfirm'), confirmLabel: t('rooms.docs.continue') })) return;
    const next = await window.api.rooms.documents.review(roomId, initial.token, choice);
    // Explicit discard/rebase is the only operation that replaces the local CRDT and clears undo.
    baseState.current = next.state; const reset = new Y.Doc();
    try { Y.applyUpdate(reset, documentBytes(next.state)); setText(reset.getText('text').toString()); } finally { reset.destroy(); }
    latest.current = next; setView(next); setGeneration(value => value + 1); setNotice(t('rooms.docs.reviewDone'));
  }); };
  const outline = text.split('\n').map((line, index) => ({ line: index + 1, match: /^(#{1,6})\s+(.+)$/.exec(line) })).filter(i => i.match);
  const readonly = !view.writable || view.blockedPending || busy;
  const status = documentSaveStatus(view, unsaved);
  return <section className={'hd-buffer' + (focus ? ' hd-focus' : '')} style={{ display: visible ? 'flex' : 'none' }} data-docs-buffer={view.documentId}>
    <div className="hd-doc-header"><div><span className="hd-eyebrow">{t(view.archived ? 'rooms.docs.archived' : 'rooms.docs.liveDocument')}</span><h2>{view.title}</h2></div><div className="hd-collaborators">{view.cursors.slice(0, 5).map(c => <button key={c.memberId + c.sessionId} style={{ '--peer-color': c.color } as React.CSSProperties} title={c.name} onClick={() => followCursor(c)}>{c.name.slice(0, 2).toUpperCase()}<span>{c.name}</span></button>)}<span className="hd-self">{t('rooms.docs.you')}</span></div></div>
    <div className="hd-toolbar"><div className="hd-tool-group"><button title={t('rooms.sync.editorUndo') + ' · Ctrl+Z'} aria-label={t('rooms.sync.editorUndo')} disabled={readonly} onClick={() => resource.undo.undo()}><Icon name="rotate-ccw" size={15} /></button><button title={t('rooms.sync.editorRedo') + ' · Ctrl+Shift+Z'} aria-label={t('rooms.sync.editorRedo')} disabled={readonly} onClick={() => resource.undo.redo()}><Icon name="rotate-cw" size={15} /></button></div>
      {view.language === 'markdown' && <div className="hd-tool-group hd-format"><button title={t('rooms.docs.bold')} disabled={readonly} onClick={() => format('**')}><Icon name="bold" size={15} /></button><button title={t('rooms.docs.italic')} disabled={readonly} onClick={() => format('*')}><Icon name="italic" size={15} /></button><button title={t('rooms.docs.heading')} disabled={readonly} onClick={() => format('## ', '', true)}><Icon name="heading" size={15} /></button><button title={t('rooms.docs.task')} disabled={readonly} onClick={() => format('- [ ] ', '', true)}><Icon name="list" size={15} /></button><button title={t('rooms.docs.code')} disabled={readonly} onClick={() => format('`')}><Icon name="code" size={15} /></button></div>}
      <div className="hd-tool-group"><button title={t('rooms.sync.editorFind')} aria-label={t('rooms.sync.editorFind')} onClick={() => withEditor(openSearchPanel)}><Icon name="search" size={15} /></button><button title={t('rooms.docs.goLine')} onClick={() => withEditor(gotoLine)}><Icon name="hash" size={15} /></button><button title={t('rooms.sync.editorWrap')} aria-pressed={wrap} onClick={() => setWrap(v => !v)}><Icon name="wrap-text" size={15} /></button></div>
      <div className="hd-tool-group hd-zoom"><button aria-label={t('rooms.docs.smaller')} onClick={() => setFont(v => Math.max(11, v - 1))}>A−</button><span>{font}</span><button aria-label={t('rooms.docs.larger')} onClick={() => setFont(v => Math.min(24, v + 1))}>A+</button></div>
      <div className="hd-tool-spacer" />
      <div className="hd-view-modes" role="group" aria-label={t('rooms.docs.viewMode')}>{(['source', 'split', 'preview'] as Mode[]).filter(m => view.language === 'markdown' || m === 'source').map(m => <button key={m} data-docs-mode={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{t(`rooms.docs.${m}`)}</button>)}</div>
      <button className="hd-icon" aria-label={t('rooms.docs.focus')} title={t('rooms.docs.focus')} aria-pressed={focus} onClick={() => setFocus(v => !v)}><Icon name={focus ? 'minimize' : 'maximize'} size={15} /></button>
    </div>
    <div className="hd-actionbar"><RoomObjectCopy target={{ kind: "document", id: view.documentId, name: view.title }} /><span className={'hd-save-status' + (status !== 'rooms.docs.synced' ? ' pending' : '')} role="status" title={status === 'rooms.docs.localSaved' ? t('rooms.docs.localSavedHint') : undefined} data-docs-status={status}><i />{t(status)}{view.pending > 0 && ' · ' + view.pending}</span><div><button data-docs-history aria-pressed={panel === 'history'} onClick={() => { void run(async () => { setSnapshots(await window.api.rooms.documents.history(roomId, initial.token)); setPanel(panel === 'history' ? null : 'history'); }); }}><Icon name="clock" size={13} />{t('rooms.docs.history')}</button>{view.language === 'markdown' && <button aria-pressed={panel === 'outline'} onClick={() => setPanel(panel === 'outline' ? null : 'outline')}><Icon name="list" size={13} />{t('rooms.docs.outline')}</button>}<button data-docs-export disabled={busy} onClick={() => { void run(async () => { if (await window.api.rooms.documents.export(roomId, initial.token)) setNotice(t('rooms.docs.exported')); }); }}><Icon name="download" size={13} />{t('rooms.docs.export')}</button>{view.selfId === view.ownerId && <button data-docs-rights aria-pressed={panel === 'rights'} onClick={() => { setPolicyExpected(view.policyId); setPolicyTitle(view.title); setPolicyWriters(view.writers); setPolicyArchived(view.archived); setPanel(panel === 'rights' ? null : 'rights'); }}><Icon name="settings" size={13} />{t('rooms.docs.access')}</button>}</div></div>
    <p className="hd-save-scope" data-docs-save-scope>{t('rooms.docs.confirmedHint')}</p>
    {!view.writable && !view.archived && !view.recovering && view.selfId !== view.ownerId && <div className="hd-access-request" data-docs-access-request>
      <p>{!view.ownerOnline ? t('rooms.docs.requestOffline') : !view.access?.supported ? t('rooms.docs.requestUnsupported') : view.access?.own ? t(`rooms.docs.request.${view.access.own.status}`) : t('rooms.docs.requestHint')}</p>
      <button className="btn btn-secondary btn-sm" disabled={busy || !view.ownerOnline || !view.access?.supported || Date.now() < (view.access?.nextRequestAt ?? 0) || !!view.access?.own && view.access.own.status !== 'declined'} onClick={() => { void run(async () => {
        if (!await confirm({ message: t('rooms.docs.requestConfirm') })) return;
        await window.api.rooms.documents.requestAccess(roomId, view.documentId, view.policyId);
        apply(await window.api.rooms.documents.poll(roomId, initial.token, -1));
      }); }}>{t('rooms.docs.requestAccess')}</button>
      <p>{t('rooms.docs.requestCopyHint')}</p>
    </div>}
    {view.selfId === view.ownerId && !!view.access?.pending.length && <button className="btn btn-secondary btn-sm" data-docs-requests onClick={() => { setPolicyExpected(view.policyId); setPolicyTitle(view.title); setPolicyWriters(view.writers); setPolicyArchived(view.archived); setPanel('rights'); }}>{t('rooms.docs.requests')} · {view.access.pending.length}</button>}

    {!view.ownerOnline && <p className="hd-notice">{t('rooms.docs.offlineHint')}</p>}
    {view.recovering && <p className="hd-notice" data-docs-recovery>{t('rooms.docs.recoveryHint')}</p>}
    {view.transferring && <p className="hd-notice">{t('rooms.docs.transferHint')}</p>}
    {!view.writable && !view.recovering && !view.transferring && <p className="hd-notice">{t(view.archived ? 'rooms.docs.archiveHint' : 'rooms.docs.readerHint')}</p>}
    {view.blockedPending && <div className="hd-review" role="alert"><p>{t('rooms.docs.reviewHint')}</p><button data-docs-apply-draft disabled={busy || !view.writable} onClick={() => review('apply')}>{t('rooms.docs.applyDraft')}</button><button data-docs-use-shared disabled={busy || view.recovering} onClick={() => review('discard')}>{t('rooms.docs.useShared')}</button></div>}
    {(error || pollError) && <div className="hd-error" role="alert"><ErrorMessage error={error || pollError} /><button onClick={() => { void flush().catch(() => {}); }}>{t('rooms.docs.retry')}</button><button onClick={() => { void host.window.navigator.clipboard.writeText(text).then(() => setNotice(t('rooms.sync.editorCopied'))).catch(cause => setError(failure(cause))); }}>{t('rooms.sync.editorCopy')}</button></div>}
    {notice && <p className="hd-notice hd-dismissible" role="status">{notice}<button data-docs-dismiss-notice className="hd-icon" aria-label={t('common.close')} onClick={() => setNotice('')}><Icon name="x" size={14} /></button></p>}
    <div className={'hd-edit-area hd-mode-' + mode}>
      <div className="hd-code room-text-editor" ref={mount} style={{ fontSize: font }} />
      {mode !== 'source' && <Preview text={previewText} font={font} />}
      {panel && <aside className="hd-inspector"><div className="hd-inspector-title"><strong>{t(panel === 'history' ? 'rooms.docs.history' : panel === 'outline' ? 'rooms.docs.outline' : 'rooms.docs.access')}</strong><button className="hd-icon" aria-label={t('common.close')} onClick={() => setPanel(null)}><Icon name="x" size={14} /></button></div>
        {panel === 'rights' && !!view.access?.pending.length && <div className="hd-access-inbox"><h3>{t('rooms.docs.requests')}</h3><p>{t('rooms.docs.requestChooseHint')}</p>{view.access.pending.map(request => <div key={request.requestId}><strong>{catalog?.members.find(member => member.memberId === request.memberId)?.name ?? request.memberId.slice(0, 10)}</strong><button type="button" className="btn btn-secondary btn-sm" disabled={busy || policyWriters.includes(request.memberId) || policyWriters.length >= 32} onClick={() => setPolicyWriters(old => [...new Set([...old, request.memberId])])}>{t('rooms.docs.chooseWriter')}</button><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { void run(async () => { if (await confirm({ message: t('rooms.docs.declineConfirm') })) { await window.api.rooms.documents.dismissAccess(roomId, view.documentId, request.requestId); apply(await window.api.rooms.documents.poll(roomId, initial.token, -1)); } }); }}>{t('rooms.docs.declineRequest')}</button></div>)}</div>}
        {panel === 'outline' ? <nav>{outline.length ? outline.map(h => <button key={h.line} style={{ paddingLeft: 10 + h.match![1].length * 7 }} onClick={() => withEditor(cm => { const line = cm.state.doc.line(h.line); cm.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start' }) }); })}>{h.match![2]}</button>) : <p>{t('rooms.docs.noHeadings')}</p>}</nav> : panel === 'history' ? <><p>{t('rooms.docs.historyHint')}</p><input maxLength={120} placeholder={t('rooms.docs.snapshotName')} aria-label={t('rooms.docs.snapshotName')} value={snapshotLabel} onChange={e => setSnapshotLabel(e.target.value)} /><button data-docs-snapshot className="btn btn-primary btn-sm hd-primary" disabled={busy} onClick={() => { void run(async () => { await window.api.rooms.documents.snapshot(roomId, initial.token, snapshotLabel); setSnapshotLabel(''); setSnapshots(await window.api.rooms.documents.history(roomId, initial.token)); }); }}>{t('rooms.docs.snapshot')}</button>
          {snapshots.map(s => <button className="hd-snapshot" key={s.id} onClick={() => setPreviewSnapshot(s)}><strong>{s.label || t('rooms.docs.untitledSnapshot')}</strong><time>{new Date(s.at).toLocaleString()}</time><small>{new TextEncoder().encode(s.text).length.toLocaleString()} B · v{s.seq}</small></button>)}{!snapshots.length && <p>{t('rooms.docs.noSnapshots')}</p>}</> : <form onSubmit={e => { e.preventDefault(); void run(async () => { await window.api.rooms.documents.policy(roomId, view.documentId, policyExpected, policyTitle.trim(), policyWriters, policyArchived); apply(await window.api.rooms.documents.poll(roomId, initial.token, -1)); setPanel(null); }); }}><label>{t('rooms.docs.name')}<input maxLength={120} required value={policyTitle} onChange={e => setPolicyTitle(e.target.value)} /></label><p>{t('rooms.docs.writers')}</p>{[...new Set([...view.writers, ...(catalog?.members.filter(m => m.capable).map(m => m.memberId) ?? [])])].map(id => <label className="hd-check" key={id}><input type="checkbox" checked={policyWriters.includes(id)} disabled={id === view.ownerId || !policyWriters.includes(id) && policyWriters.length >= 32} onChange={e => setPolicyWriters(old => e.target.checked ? [...old, id] : old.filter(v => v !== id))} />{catalog?.members.find(m => m.memberId === id)?.name ?? id.slice(0, 10)}</label>)}<label className="hd-check"><input type="checkbox" checked={policyArchived} onChange={e => setPolicyArchived(e.target.checked)} />{t('rooms.docs.archive')}</label><p>{t('rooms.docs.accessHint')}</p><button data-docs-policy-save className="btn btn-primary btn-sm hd-primary" disabled={busy || !policyTitle.trim()} type="submit">{t('rooms.docs.saveAccess')}</button></form>}
      </aside>}
    </div>
    <footer className="hd-statusbar"><span>{t('rooms.docs.line')} {position.line}, {t('rooms.docs.column')} {position.column}{position.selected > 0 && ' · ' + position.selected + ' ' + t('rooms.docs.selected')}</span><span>{text.trim() ? text.trim().split(/\s+/u).length : 0} {t('rooms.docs.words')} · {text.length.toLocaleString()} {t('rooms.docs.characters')}</span><span>{Math.ceil(new TextEncoder().encode(text).length / 1024)} / {DOCUMENT_TEXT_BYTES / 1024} KB · UTF-8 · {view.language === 'markdown' ? 'Markdown' : 'Text'} · v{view.seq}</span></footer>
    {previewSnapshot && <Modal size="xl" title={previewSnapshot.label || t('rooms.docs.untitledSnapshot')} onClose={() => setPreviewSnapshot(null)} footer={<button disabled={readonly} className="btn btn-primary btn-sm hd-primary" onClick={() => { void run(async () => { if (await confirm({ message: t('rooms.docs.restoreConfirm'), confirmLabel: t('rooms.docs.restore') })) { apply(await window.api.rooms.documents.restore(roomId, initial.token, previewSnapshot.id)); setPreviewSnapshot(null); } }); }}>{t('rooms.docs.restore')}</button>}><pre className="hd-snapshot-preview">{previewSnapshot.text}</pre></Modal>}
  </section>;
}
