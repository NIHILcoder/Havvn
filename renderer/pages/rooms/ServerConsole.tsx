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
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';
import { useHostWindow, resolveHostWindow } from '../../utils/hostWindow';
import type { ConsoleLine } from '../../../shared/types';

/** Lines kept in the DOM. Main buffers more; this is what stays rendered. */
const VIEW_LINES = 1200;

/** How close to the bottom still counts as "following". A couple of line heights
 *  of slack keeps follow-mode from breaking on a sub-pixel scroll position. */
const FOLLOW_SLACK_PX = 48;

interface ServerConsoleProps {
  instanceId: string;
  canSend: boolean;
}

export const ServerConsole: React.FC<ServerConsoleProps> = ({ instanceId, canSend }) => {
  const { t } = useTranslation();
  const toast = useHostToast();
  const host = useHostWindow();
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [command, setCommand] = useState('');
  const [following, setFollowing] = useState(true);

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
    const api = window.api.rooms.servers;

    void api.watchConsole(instanceId).catch(() => { /* instance vanished */ });
    void api.console(instanceId).then((snapshot) => { if (alive) setLines(snapshot); }).catch(() => { /* ignore */ });

    const off = api.onConsole((payload) => {
      if (!alive || payload.instanceId !== instanceId) return;
      setLines((prev) => {
        const lastSeq = prev.length ? prev[prev.length - 1].seq : 0;
        const fresh = payload.lines.filter((l) => l.seq > lastSeq);
        if (fresh.length === 0) return prev;
        const next = prev.concat(fresh);
        return next.length > VIEW_LINES ? next.slice(next.length - VIEW_LINES) : next;
      });
    });

    return () => {
      alive = false;
      off();
      // Unsubscribe in main too, or a closed panel keeps paying for the stream.
      void api.watchConsole(null).catch(() => { /* window closing */ });
    };
  }, [instanceId]);

  // Scroll AFTER paint, and only when the user was already at the bottom.
  useLayoutEffect(() => {
    if (!followingRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
    setFollowing(atBottom);
  }, []);

  const send = useCallback(async () => {
    const text = command.trim();
    if (!text) return;
    setCommand('');
    historyRef.current = [text, ...historyRef.current.filter((c) => c !== text)].slice(0, 50);
    historyPos.current = -1;
    // Sending scrolls back to the bottom: you want to see the answer.
    setFollowing(true);
    try {
      const res = await window.api.rooms.servers.command(instanceId, text);
      if (!res.ok && res.reason) toast.error(res.reason);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [command, instanceId, toast]);

  const copyLog = useCallback(() => {
    // The clipboard of the window this console is REALLY in. A detached panel
    // writing through the main window's navigator rejects with "Document is not
    // focused" — that document is unfocused precisely because the child has it.
    const win = resolveHostWindow(rootRef.current, host).window;
    const text = lines.map((l) => l.text).join('\n');
    win.navigator.clipboard?.writeText(text)
      .then(() => toast.success(t('rooms.server.console.copied')))
      .catch(() => { /* clipboard blocked — the log is still on screen */ });
  }, [host, lines, t, toast]);

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
          {t('rooms.server.console.lines').replace('{n}', String(lines.length))}
        </span>
        <button
          type="button"
          className="server-console-tool"
          disabled={lines.length === 0}
          title={t('rooms.server.console.copy')}
          aria-label={t('rooms.server.console.copy')}
          onClick={copyLog}
        >
          <Icon name="copy" size={12} />
        </button>
        <button
          type="button"
          className="server-console-tool"
          disabled={lines.length === 0}
          title={t('rooms.server.console.clear')}
          aria-label={t('rooms.server.console.clear')}
          onClick={() => setLines([])}
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      <div className="server-console-out" ref={scrollRef} onScroll={onScroll} role="log" aria-live="off">
        {lines.length === 0 ? (
          <p className="server-console-empty">{t('rooms.server.consoleEmpty')}</p>
        ) : (
          lines.map((line) => (
            <div key={line.seq} className={`server-console-line is-${line.stream}`}>
              {line.text}
            </div>
          ))
        )}
      </div>

      {!following && (
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

      <div className="server-console-input">
        <span className="server-console-prompt">
          <span className="server-console-prompt-sigil" aria-hidden="true">&gt;</span>
          <input
            type="text"
            value={command}
            disabled={!canSend}
            maxLength={512}
            placeholder={t('rooms.server.commandPlaceholder')}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </span>
        <button
          type="button"
          className="server-console-send"
          disabled={!canSend || !command.trim()}
          onClick={() => void send()}
        >
          {t('rooms.server.send')}
        </button>
      </div>
    </div>
  );
};
