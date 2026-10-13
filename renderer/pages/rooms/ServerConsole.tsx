/**
 * The server console: a live tail plus a command input.
 *
 * TWO THINGS MAKE THIS NON-TRIVIAL and both are about volume. A modded server's
 * startup emits thousands of lines in a few seconds, so:
 *
 *   • The subscription is EXPLICIT. Main streams one instance's output only
 *     while a panel asked for it (watchConsole), so a console nobody is looking
 *     at costs no IPC at all. The effect below is what turns it on and off.
 *   • Lines are capped in the view, not just in main. Rendering an unbounded list
 *     is how a console panel becomes the reason the whole UI stutters.
 *
 * FOLLOW-TAIL DISCIPLINE: the view auto-scrolls only while the user is already at
 * the bottom. Scrolling up to read something and being yanked back down by the
 * next line is the single most irritating thing a log view can do.
 *
 * REALM: this renders inside a dock panel that can be torn into a child window,
 * so "copy log" resolves the clipboard of the window it is REALLY in rather than
 * the module-singleton one (see RoomServerPanel's header for the failure that
 * looks like a silent no-op).
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Icon, Select } from '../../components';
import { useServerError } from './serverErrors';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';
import { useHostWindow, resolveHostWindow } from '../../utils/hostWindow';
import type { ConsoleLine } from '../../../shared/types';
import { consoleSeverity, filterConsole, loadSavedCommands, saveCommands, MAX_SAVED_COMMANDS, type ConsoleFilter } from './serverConsoleTools';

/** Lines kept in the DOM. Main buffers more; this is what stays rendered. */
const VIEW_LINES = 1200;

/** How close to the bottom still counts as "following". A couple of line heights
 *  of slack keeps follow-mode from breaking on a sub-pixel scroll position. */
const FOLLOW_SLACK_PX = 48;

interface ServerConsoleProps {
  instanceId: string;
  roomId: string;
  canSend: boolean;
  remote?: boolean;
}

export const ServerConsole: React.FC<ServerConsoleProps> = ({ instanceId, roomId, canSend, remote }) => {
  const { t } = useTranslation();
  const toast = useHostToast();
  const errorText = useServerError();
  const [sending, setSending] = useState(false);
  const [commandStatus, setCommandStatus] = useState('');
  const sendPending = useRef(false);
  const sendEpoch = useRef(0);
  useEffect(() => {
    setCommandStatus(''); setSending(false); sendPending.current = false;
    const epoch = ++sendEpoch.current;
    return () => { sendEpoch.current = epoch + 1; };
  }, [instanceId]);
  const host = useHostWindow();
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [command, setCommand] = useState('');
  const [following, setFollowing] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ConsoleFilter>('all');
  const [paused, setPaused] = useState<ConsoleLine[] | null>(null);
  const [jumpSeq, setJumpSeq] = useState<number | null>(null);
  const commandScope = `${roomId}:${instanceId}`;
  const [savedCommands, setSavedCommands] = useState(() => loadSavedCommands(commandScope));
  const [savedName, setSavedName] = useState('');
  const commandRef = useRef<HTMLInputElement | null>(null);
  const lastSeqRef = useRef(0);
  const displayed = paused ?? lines;
  const visible = useMemo(() => filterConsole(displayed, query, filter), [displayed, query, filter]);
  useEffect(() => {
    setQuery(''); setFilter('all'); setPaused(null); setJumpSeq(null);
    setSavedCommands(loadSavedCommands(commandScope)); setSavedName(''); setCommand('');
    historyRef.current = []; historyPos.current = -1;
    setFollowing(true); followingRef.current = true;
  }, [commandScope]);
  const storeCommands = (next: typeof savedCommands) => {
    if (!saveCommands(commandScope, next)) { toast.error(t('rooms.server.console.saveFailed')); return; }
    setSavedCommands(next);
  };
  const saveCommand = () => {
    if (!savedName.trim() || !command.trim() || savedCommands.length >= MAX_SAVED_COMMANDS || /[\r\n\0]/.test(command)) return;
    storeCommands([...savedCommands, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: savedName.trim(), command: command.trim() }]);
    setSavedName('');
  };

  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);
  /** Recently sent commands, newest first — arrow-up recall. */
  const historyRef = useRef<string[]>([]);
  const historyPos = useRef(-1);

  useEffect(() => { followingRef.current = following; }, [following]);

  // Snapshot, then subscribe. The snapshot's last seq is not needed as a cursor:
  // main starts the live stream at subscribe time and the snapshot is taken
  // after, so an overlap is possible — the merge below de-dupes on `seq`.
  useEffect(() => {
    let alive = true;
    setLines([]);
    lastSeqRef.current = 0;
    const api = window.api.rooms.servers;

    // Append what is newer than the last seq we hold, capped to the view. Shared
    // by both paths: a mirrored tail carries the HOST's sequence numbers, so it
    // merges by exactly the same rule as a locally streamed line.
    const append = (incoming: ConsoleLine[]): void => {
      if (!alive || incoming.length === 0) return;
      const fresh = incoming.filter((l) => l.seq > lastSeqRef.current);
      if (fresh.length === 0) return;
      lastSeqRef.current = fresh[fresh.length - 1].seq;
      setLines((prev) => {
        const next = prev.concat(fresh);
        return next.length > VIEW_LINES ? next.slice(next.length - VIEW_LINES) : next;
      });
    };

    if (remote) {
      // The mirror only ever carries the last few lines, so this console shows
      // a moving window rather than full history — but it no longer REPLACES
      // what it has, which is what made the same lines flicker in and out.
      void api.console(instanceId, 0, roomId).then(append).catch(() => { /* ignore */ });
      const offUp = api.onUpdate((payload) => {
        if (payload.roomId !== roomId) return;
        const inst = payload.state.instances.find((i) => i.instanceId === instanceId);
        const tail = inst?.consoleTail;
        const lastSeq = inst?.consoleTailSeq;
        if (!tail?.length || !lastSeq) return;
        const at = Date.now();
        const firstSeq = lastSeq - (tail.length - 1);
        append(tail.map((text, i) => ({ seq: firstSeq + i, at, stream: 'out' as const, text })));
      });
      return () => { alive = false; offUp(); };
    }

    void api.watchConsole(instanceId).catch(() => { /* instance vanished */ });
    void api.console(instanceId).then(append).catch(() => { /* ignore */ });

    const off = api.onConsole((payload) => {
      if (payload.instanceId !== instanceId) return;
      append(payload.lines);
    });

    return () => {
      alive = false;
      off();
      void api.watchConsole(null).catch(() => { /* window closing */ });
    };
  }, [instanceId, remote, roomId]);

  // Scroll AFTER paint, and only when the user was already at the bottom.
  useLayoutEffect(() => {
    if (!followingRef.current || paused !== null || jumpSeq !== null) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible, paused, jumpSeq]);
  useLayoutEffect(() => {
    if (jumpSeq === null) return;
    rootRef.current?.querySelector(`[data-console-seq="${jumpSeq}"]`)?.scrollIntoView({ block: 'center' });
    setJumpSeq(null);
  }, [jumpSeq, visible]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
    if (paused === null) setFollowing(atBottom);
  }, [paused]);

  const send = useCallback(async () => {
    const text = command.trim();
    if (!text || !canSend || sendPending.current) return;
    sendPending.current = true; setSending(true);
    const epoch = sendEpoch.current;
    setCommandStatus(t('rooms.server.console.pending'));
    setCommand('');
    historyRef.current = [text, ...historyRef.current.filter((c) => c !== text)].slice(0, 50);
    historyPos.current = -1;
    // Sending scrolls back to the bottom: you want to see the answer.
    setPaused(null); setQuery(''); setFilter('all'); setFollowing(true);
    try {
      const res = await window.api.rooms.servers.command(instanceId, text, roomId);
      if (epoch !== sendEpoch.current) return;
      const status = res.ok ? t('rooms.server.console.accepted') : errorText(res.reason || 'command-unknown');
      setCommandStatus(status);
      if (!res.ok) toast.error(status);
    } catch (err) {
      if (epoch === sendEpoch.current) { const message = errorText(err); setCommandStatus(message); toast.error(message); }
    } finally { if (epoch === sendEpoch.current) { sendPending.current = false; setSending(false); } }
  }, [command, instanceId, roomId, toast, errorText, t, canSend]);

  const copyLog = useCallback(() => {
    // The clipboard of the window this console is REALLY in. A detached panel
    // writing through the main window's navigator rejects with "Document is not
    // focused" — that document is unfocused precisely because the child has it.
    const win = resolveHostWindow(rootRef.current, host).window;
    const text = visible.map((l) => l.text).join('\n');
    win.navigator.clipboard?.writeText(text)
      .then(() => toast.success(t('rooms.server.console.copied')))
      .catch(() => { /* clipboard blocked — the log is still on screen */ });
  }, [host, visible, t, toast]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); void send(); return; }
    if (e.key === 'ArrowUp') {
      const history = historyRef.current;
      if (history.length === 0) return;
      e.preventDefault();
      historyPos.current = Math.min(historyPos.current + 1, history.length - 1);
      setCommand(history[historyPos.current]);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      historyPos.current -= 1;
      if (historyPos.current < 0) { historyPos.current = -1; setCommand(''); return; }
      setCommand(historyRef.current[historyPos.current] ?? '');
    }
  }, [send]);

  return (
    <div className="server-console" ref={rootRef}>
      {/*
        The toolbar answers "how much am I looking at" and gives the log the two
        things a person always wants from one: a way to take it somewhere else,
        and a way to start clean before reproducing something. Clearing is
        VIEW-ONLY — main keeps its buffer, so a cleared view is not lost evidence.
      */}
      <div className="server-console-bar">
        <span className="server-console-count">
          {t('rooms.server.console.filteredCount').replace('{shown}', String(visible.length)).replace('{total}', String(displayed.length))}
        </span>
        <button type="button" className="server-console-tool" aria-pressed={paused !== null} title={t(paused === null ? 'rooms.server.console.pause' : 'rooms.server.console.resume')} aria-label={t(paused === null ? 'rooms.server.console.pause' : 'rooms.server.console.resume')}
          onClick={() => { setPaused(paused === null ? lines : null); setFollowing(paused !== null); }}><Icon name={paused === null ? 'pause' : 'play'} size={12} /></button>
        <button type="button" className="server-console-tool" title={t('rooms.server.console.lastError')} aria-label={t('rooms.server.console.lastError')}
          disabled={!displayed.some(line => consoleSeverity(line) === 'error')}
          onClick={() => { const line = [...displayed].reverse().find(l => consoleSeverity(l) === 'error'); if (line) { setQuery(''); setFilter('error'); setFollowing(false); setJumpSeq(line.seq); } }}><Icon name="alert-circle" size={12} /></button>
        <button
          type="button"
          className="server-console-tool"
          disabled={visible.length === 0}
          title={t('rooms.server.console.copy')}
          aria-label={t('rooms.server.console.copy')}
          onClick={copyLog}
        >
          <Icon name="copy" size={12} />
        </button>
        <button
          type="button"
          className="server-console-tool"
          disabled={displayed.length === 0}
          title={t('rooms.server.console.clear')}
          aria-label={t('rooms.server.console.clear')}
          onClick={() => { setLines([]); if (paused !== null) setPaused([]); }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      <div className="server-console-filters">
        <input type="search" value={query} maxLength={256} onChange={e => setQuery(e.target.value)} placeholder={t('rooms.server.console.search')} aria-label={t('rooms.server.console.search')} />
        <Select value={filter} onChange={value => setFilter(value as ConsoleFilter)} ariaLabel={t('rooms.server.console.filter')} options={(['all', 'warn', 'error'] as const).map(value => ({ value, label: t(`rooms.server.console.filter.${value}`) }))} />
      </div>
      {paused !== null && <p className="server-console-command-status" role="status">{t('rooms.server.console.paused')}</p>}

      <div className="server-console-out" ref={scrollRef} onScroll={onScroll} role="log" aria-live="off">
        {visible.length === 0 ? (
          <p className="server-console-empty">{t(displayed.length ? 'rooms.server.console.noMatches' : 'rooms.server.consoleEmpty')}</p>
        ) : (
          visible.map((line) => (
            <div key={line.seq} data-console-seq={line.seq} className={`server-console-line is-${line.stream} severity-${consoleSeverity(line)}`}>
              {line.text}
            </div>
          ))
        )}
      </div>

      {!following && paused === null && (
        <button
          type="button"
          className="server-console-jump"
          title={t('rooms.server.console.jump')}
          aria-label={t('rooms.server.console.jump')}
          onClick={() => {
            setFollowing(true);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          <Icon name="chevron-down" size={12} />
        </button>
      )}

      <details className="server-console-saved">
        <summary>{t('rooms.server.console.saved')}</summary>
        <p>{t('rooms.server.console.savedHint')}</p>
        {savedCommands.map(item => <div key={item.id} className="server-console-saved-row">
          <Button variant="ghost" size="sm" title={item.command} disabled={!canSend || sending} onClick={() => { setCommand(item.command); commandRef.current?.focus(); }}>{item.name}</Button>
          <Button variant="ghost" size="sm" iconOnly aria-label={`${t('rooms.workspace.delete')} ${item.name}`} icon={<Icon name="trash" size={12} />} onClick={() => storeCommands(savedCommands.filter(c => c.id !== item.id))} />
        </div>)}
        {canSend && <div className="server-console-save-row">
          <input value={savedName} maxLength={80} onChange={e => setSavedName(e.target.value)} placeholder={t('rooms.server.console.commandName')} aria-label={t('rooms.server.console.commandName')} />
          <Button size="sm" variant="ghost" disabled={!savedName.trim() || !command.trim() || savedCommands.length >= MAX_SAVED_COMMANDS} onClick={saveCommand}>{t('rooms.server.console.save')}</Button>
        </div>}
      </details>

      {commandStatus && <p className="server-console-command-status" role="status">{commandStatus}</p>}
      <div className="server-console-input" aria-busy={sending}>
        <span className="server-console-prompt">
          <span className="server-console-prompt-sigil" aria-hidden="true">&gt;</span>
          <input
            ref={commandRef}
            type="text"
            value={command}
            disabled={!canSend || sending}
            maxLength={512}
            placeholder={t('rooms.server.commandPlaceholder')}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </span>
        <button
          type="button"
          className="server-console-send"
          disabled={!canSend || sending || !command.trim()}
          onClick={() => void send()}
        >
          {t('rooms.server.send')}
        </button>
      </div>
    </div>
  );
};
