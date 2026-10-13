import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useId } from 'react';
import { createPortal } from 'react-dom';
import type { RoomState, RoomMember, RoomChatMessage } from '../../../shared/types';
import { roomChatPage, ROOM_CHAT_LIMIT } from '../../../shared/room-chat-history';
import { parseChatSegments, isCopyworthy, splitLinks } from '../../../shared/chat-format';
import { CHAT_REACT_EMOJIS } from '../../../shared/reactions';
import { Button, Icon, Identicon, Avatar, ProfileCard, Select } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';
import { useRoomChatComposer } from '../../utils/useRoomChatComposer';
import { EMPTY_CHAT_FILTER, roomMentionRanges, chatFilterActive, parseFileRequest, firstUnreadMessage, type RoomChatFilter } from '../../../shared/room-chat-tools';
import { useRoomChatSearch } from './useRoomChatSearch';
import { useRoomChatRead } from './useRoomChatRead';
import { RoomFileRequestCard } from './RoomFileRequestCard';
type RoomsTFn = ReturnType<typeof useTranslation>['t'];

/** Human text for one activity-log event (actor name is rendered separately). */
function eventText(t: RoomsTFn, ev: import('../../../shared/types').RoomEvent): string {
  switch (ev.type) {
    case 'created': return t('rooms.ev.created');
    case 'joined': return t('rooms.ev.joined');
    case 'left': return t('rooms.ev.left');
    case 'file-added': return `${t('rooms.ev.fileAdded')} ${ev.fileName || ''}`.trim();
    case 'file-removed': return `${t('rooms.ev.fileRemoved')} ${ev.fileName || ''}`.trim();
    case 'kicked': return `${t('rooms.ev.kicked')} ${ev.targetName || ''}`.trim();
    case 'rekeyed': return t('rooms.ev.rekeyed');
    case 'ownership-transferred': return `${t('rooms.ev.ownerTransferred')} ${ev.targetName || ''}`.trim();
    default: return ev.type;
  }
}

function shortTime(at: number): string {
  try { return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

/** Time-of-day only — chat messages carry the date via the day separators. */
function timeOnly(at: number): string {
  try { return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

/** Label for a chat day separator: Today / Yesterday / a locale date. */
function dayLabel(at: number, t: RoomsTFn): string {
  const d = new Date(at);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return t('rooms.today');
  if (diffDays === 1) return t('rooms.yesterday');
  try {
    return d.toLocaleDateString(undefined, {
      month: 'long', day: 'numeric',
      year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
  } catch { return ''; }
}

// ── Room chat panel ───────────────────────────────────────────────────────
// Pure text chat — a dock panel like any other (it merely DEFAULTS to the right
// column); this card is just log + typing indicator + composer.
// Highlight the current user's name inside a plain-text run (@-less mention).
const renderWithMention = (text: string, selfName?: string): React.ReactNode => {
  if (!selfName) return text;
  const ranges = roomMentionRanges(text, selfName), parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [i, range] of ranges.entries()) {
    parts.push(text.slice(cursor, range.start));
    parts.push(<mark key={i} className="room-chat-mention">{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }
  parts.push(text.slice(cursor));
  return parts;
};

// Highlight the active chat-search query inside a plain run, then mention-
// highlight the gaps. Search hits win over mention marks where they overlap, so
// the two passes never nest the same <mark>. `query` arrives pre-trimmed and
// lowercased (the filter's `q`); empty → mention-only (and no indexOf('') loop).
const highlightRun = (text: string, selfName: string | undefined, query?: string): React.ReactNode => {
  if (!query) return renderWithMention(text, selfName);
  const lower = text.toLowerCase();
  let hit = lower.indexOf(query);
  if (hit < 0) return renderWithMention(text, selfName);
  const parts: React.ReactNode[] = [];
  let i = 0, k = 0;
  while (hit >= 0) {
    if (hit > i) parts.push(<React.Fragment key={k++}>{renderWithMention(text.slice(i, hit), selfName)}</React.Fragment>);
    // Slice from the ORIGINAL text to keep display casing (match is case-insensitive).
    parts.push(<mark key={k++} className="room-chat-search-hit">{text.slice(hit, hit + query.length)}</mark>);
    i = hit + query.length;
    hit = lower.indexOf(query, i);
  }
  if (i < text.length) parts.push(<React.Fragment key={k++}>{renderWithMention(text.slice(i), selfName)}</React.Fragment>);
  return parts;
};

// One chat message body, split into text / fenced-code segments, with a copy
// button for anything multiline (pasted scripts etc.).
const RoomChatBody: React.FC<{ text: string; copyLabel: string; copiedLabel: string; selfName?: string; query?: string }> = ({ text, copyLabel, copiedLabel, selfName, query }) => {
  const segments = useMemo(() => parseChatSegments(text), [text]);
  const toast = useHostToast(); // same realm rule as the rest of the chat subtree
  const copy = (e: React.MouseEvent) => {
    // Use the clicked element's OWN realm: in the detached chat window the main
    // document is unfocused and ITS clipboard would reject ('not focused').
    const win = (e.currentTarget as HTMLElement).ownerDocument.defaultView ?? window;
    win.navigator.clipboard.writeText(
      // Copy the CODE when the message is a single fence, else the whole body.
      segments.length === 1 && segments[0].kind === 'code' ? segments[0].text : text,
    ).then(() => toast.success(copiedLabel)).catch((err) => toast.error(String(err instanceof Error ? err.message : err)));
  };
  return (
    <div className="room-chat-bubble">
      {segments.map((s, i) => s.kind === 'code'
        ? <pre key={i} className="room-chat-code">{s.text}</pre>
        : (
          <span key={i} className="room-chat-text">
            {/* http(s)-only linkify; main routes target=_blank to the system
                browser (setWindowOpenHandler), incl. from the detached window. */}
            {splitLinks(s.text).map((r, j) => r.kind === 'link'
              ? <a key={j} className="room-chat-link" href={r.href} target="_blank" rel="noreferrer" title={r.href}>{highlightRun(r.text, undefined, query)}</a>
              : <React.Fragment key={j}>{highlightRun(r.text, selfName, query)}</React.Fragment>)}
          </span>
        ))}
      {isCopyworthy(text) && (
        <button type="button" className="room-chat-copy" onClick={copy} title={copyLabel}>
          <Icon name="copy" size={12} />
        </button>
      )}
    </div>
  );
};

/**
 * The chat panel. It is an ordinary dock panel now: detaching it is
 * `Move to ▸ New window` on its tab, exactly like every other panel, and the
 * right-hand column collapsing while it is away is the ordinary empty-zone
 * rendering rather than a flag of its own. The bespoke `usePopout('havvn-room-chat')`
 * and the `onPoppedChange` contract it needed are GONE — two mechanisms for one job
 * is how a panel ends up open in two windows at once.
 */
export const RoomChat: React.FC<{
  room: RoomState;
  /** False when the dock strip above already names this panel. */
  showTitle?: boolean;
  onAttachRequest?: () => void;
  /**
   * The dock's move affordance when chat is ALONE in a docked zone. It lands in the
   * CHAT | HISTORY row, which is the eyebrow a one-tab strip above it would
   * duplicate — so the strip hides and this takes over the gesture.
   */
  soloHandle?: React.ReactNode;
}> = ({ room, showTitle = true, onAttachRequest, soloHandle }) => {
  const { t } = useTranslation();
  // Realm-routed toasts — chat is the panel most likely to be on another monitor.
  const toast = useHostToast();
  const { composer, state: composeState } = useRoomChatComposer(room.roomId);
  const text = composeState.draft.text, sending = composeState.phase === 'sending';
  const setText = (value: string) => composer.setText(value);
  const [zoneTab, setZoneTab] = useState<'chat' | 'history' | 'pins'>('chat');
  // Per-message reaction palette — PORTALED to the chat's document at fixed
  // coords (the log clips overflow, and the chat column can be 260px narrow).
  const [reactFor, setReactFor] = useState<{ msgId: string; x: number; y: number } | null>(null);
  useEffect(() => { setReactFor(null); }, [room.roomId]);
  const toggleChatReact = (msgId: string, emoji: string) => {
    window.api.rooms.reactChat(room.roomId, msgId, emoji)
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
  };
  // Local chat search: filters the persisted log (no protocol involved).
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const searchId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [chatQuery, setChatQuery] = useState('');
  const [filters, setFilters] = useState<RoomChatFilter>(EMPTY_CHAT_FILTER);
  const filterCount = Number(!!filters.author) + Number(filters.kind !== 'all') + Number(!!(filters.after || filters.before));
  const chatQueryRef = useRef('');
  chatQueryRef.current = chatFilterActive({ ...filters, query: chatQuery }) ? 'filtered' : '';
  useEffect(() => { setSearchOpen(false); setFiltersExpanded(false); setChatQuery(''); setFilters(EMPTY_CHAT_FILTER); setZoneTab('chat'); }, [room.roomId]);
  // Reply/edit targets. `editing` swaps the composer into edit mode (prefilled);
  // `replyingTo` prepends a quote to the next send. Both belong to the room draft.
  const replyingTo = composeState.draft.reply;
  const editing = composeState.draft.editId ? { id: composeState.draft.editId } : null;
  // Author avatar click → info-only profile card (actions live in the rail).
  // Reset on room switch AND on detach/reattach — the card's anchor element
  // belongs to the previous document and dies with it.
  const [chatCardFor, setChatCardFor] = useState<{ memberId: string; anchor: HTMLElement } | null>(null);
  const chatCardMember = chatCardFor ? room.members.find((m) => m.memberId === chatCardFor.memberId) : undefined;
  useEffect(() => { setChatCardFor(null); }, [room.roomId]);
  // A zone tab switch remounts the log DOM — the card's anchor element is gone, so
  // a surviving card would pin to the window corner. (Detach/reattach is covered
  // too: the dock unmounts this panel when it changes realm.)
  useEffect(() => { setChatCardFor(null); }, [zoneTab]);
  const selfId = room.members.find((m) => m.isSelf)?.memberId;
  const selfName = room.members.find((m) => m.isSelf)?.name;
  const messages = room.chat;
  const searchFilter = useMemo(() => ({ ...filters, query: chatQuery }), [filters, chatQuery]);
  const search = useRoomChatSearch(room.roomId, searchFilter, JSON.stringify([messages.at(-1)?.id, room.chatEdits]));
  const isOwner = !!selfId && room.ownerId === selfId;
  const [pinBusy, setPinBusy] = useState(false);
  const pinPending = useRef(false);
  const pins = room.chatPins ?? [];
  const togglePin = async (id: string, on: boolean) => {
    if (pinPending.current) return;
    pinPending.current = true; setPinBusy(true);
    try { await window.api.rooms.pinChat(room.roomId, id, on); }
    catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
    finally { pinPending.current = false; setPinBusy(false); }
  };
  const listRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const unreadSession = useRef({ roomId: room.roomId, id: firstUnreadMessage(messages, room.chatLastReadAt ?? 0, selfId)?.id });
  if (unreadSession.current.roomId !== room.roomId) unreadSession.current = { roomId: room.roomId, id: firstUnreadMessage(messages, room.chatLastReadAt ?? 0, selfId)?.id };
  const unreadId = unreadSession.current.id;
  const [jump, setJump] = useState<{ roomId: string; id: string } | null>(unreadId ? { roomId: room.roomId, id: unreadId } : null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [historyAnchor, setHistoryAnchor] = useState<{ room: string; id?: string }>({ room: room.roomId });
  const prependScroll = useRef<{ height: number; top: number } | null>(null);
  const anchor = historyAnchor.room === room.roomId ? historyAnchor.id : undefined;
  const anchorIndex = anchor ? messages.findIndex(m => m.id === anchor) : -1;
  // A pruned anchor exposes the remaining window, rather than jumping to the end.
  const visibleMessages = anchor ? messages.slice(Math.max(0, anchorIndex)) : roomChatPage(messages).messages;
  const showEarlier = () => {
    const page = roomChatPage(messages, visibleMessages[0]?.id);
    if (!page.messages.length) return;
    const el = listRef.current;
    prependScroll.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    setHistoryAnchor({ room: room.roomId, id: page.messages[0].id });
  };
  const revealMessage = (id: string) => {
    setZoneTab('chat'); setChatQuery(''); setFilters(EMPTY_CHAT_FILTER); setSearchOpen(false);
    setHistoryAnchor({ room: room.roomId, id });
    setJump({ roomId: room.roomId, id });
  };
  useLayoutEffect(() => {
    setHistoryAnchor({ room: room.roomId, id: unreadId });
    setJump(unreadId ? { roomId: room.roomId, id: unreadId } : null);
  }, [room.roomId, unreadId]);
  useLayoutEffect(() => {
    if (!jump || jump.roomId !== room.roomId || zoneTab !== 'chat') return;
    const el = listRef.current, row = el && [...el.querySelectorAll<HTMLElement>('[data-chat-id]')].find(r => r.dataset.chatId === jump.id);
    if (!row || !el) return;
    const target = row.previousElementSibling?.classList.contains('room-chat-unread-marker') ? row.previousElementSibling : row;
    el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
    setHighlightId(jump.id); setJump(null);
  }, [jump, historyAnchor, zoneTab, room.roomId]);
  useEffect(() => { if (highlightId) { const timer = setTimeout(() => setHighlightId(null), 2500); return () => clearTimeout(timer); } }, [highlightId]);
  useRoomChatRead(room.roomId, messages, room.chatLastReadAt ?? 0, listRef, zoneTab === 'chat' && !search.active);
  useLayoutEffect(() => {
    const before = prependScroll.current, el = listRef.current;
    prependScroll.current = null;
    if (before && el) el.scrollTop = before.top + el.scrollHeight - before.height;
  }, [historyAnchor]);
  useEffect(() => { prependScroll.current = null; }, [room.roomId]);

  // Pin to the newest message only while the user is already near the bottom —
  // reading older history must not be yanked down by new arrivals (those feed
  // the "N new ↓" pill instead). The retained log is capped, so
  // arrivals are counted by the previous last-id's position, not length delta.
  const atBottomRef = useRef(true);
  const [newCount, setNewCount] = useState(0);
  const prevLogRef = useRef<{ room: string; lastId: string | null }>({ room: room.roomId, lastId: null });
  const scrollToNewest = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setNewCount(0);
  }, []);
  const onLogScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    atBottomRef.current = nearBottom;
    if (nearBottom) setNewCount(0);
  };
  useEffect(() => {
    const prev = prevLogRef.current;
    const last = messages.length ? messages[messages.length - 1] : null;
    prevLogRef.current = { room: room.roomId, lastId: last?.id ?? null };
    // Room switch FIRST: the reset effect clears the query only on the next
    // commit, and skipping here would eat the one-shot room-change evidence
    // (prevLogRef already advanced) — the new room would keep the old scroll.
    if (prev.room !== room.roomId || !prev.lastId) { if (!unreadId) scrollToNewest(); return; }
    if (chatQueryRef.current) return; // a filtered view scrolls freely
    if (!last || last.id === prev.lastId) return; // state push without new chat
    const idx = prev.lastId ? messages.findIndex((m) => m.id === prev.lastId) : -1;
    const arrived = idx >= 0 ? messages.length - 1 - idx : messages.length;
    if (atBottomRef.current || last.memberId === selfId) scrollToNewest();
    else setNewCount((c) => c + arrived);
  }, [room.roomId, messages, selfId, scrollToNewest, unreadId]);
  // A zone tab switch REMOUNTS the log DOM (fresh node, scrollTop=0) without the
  // messages changing — force a re-pin.
  const previousZone = useRef(zoneTab);
  useEffect(() => {
    const changed = previousZone.current !== zoneTab;
    previousZone.current = zoneTab;
    if (changed && zoneTab === 'chat' && !unreadId && !jump) scrollToNewest();
    if (changed) setReactFor(null);
  }, [zoneTab, scrollToNewest, unreadId, jump]);

  // The reaction palette closes on outside click — in the CHAT's document
  // (the zone may live in the detached window).
  useEffect(() => {
    if (!reactFor) return;
    const doc = listRef.current?.ownerDocument ?? document;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      // Exclude the palette AND the action cluster (the '+' trigger lives there now,
      // renamed from .room-chat-react-add) so re-clicking the trigger toggles cleanly.
      if (el && !el.closest('.room-chat-react-pop') && !el.closest('.room-chat-actions')) setReactFor(null);
    };
    doc.addEventListener('mousedown', onDown);
    return () => doc.removeEventListener('mousedown', onDown);
  }, [reactFor]);

  // Typing liveness. Outbound: at most one ping per 2.5s while composing (the
  // engine rate-limits the broadcast further). Inbound: mirror the engine's
  // typingMemberIds, restarting a 4s local TTL on every state push that still
  // carries ids — the engine drops stale typists itself, so the TTL only has
  // to cover the case where pushes stop arriving entirely.
  const typingSentAtRef = useRef(0);
  const [typingIds, setTypingIds] = useState<string[]>([]);
  useEffect(() => {
    const ids = room.typingMemberIds || [];
    setTypingIds(ids);
    if (ids.length === 0) return;
    const timer = window.setTimeout(() => setTypingIds([]), 4000);
    return () => window.clearTimeout(timer);
  }, [room]);
  const typingNames = typingIds
    .map((id) => room.members.find((m) => m.memberId === id))
    .filter((m): m is RoomMember => !!m && !m.isSelf && !m.muted)
    .map((m) => m.name || '?');
  const pingTyping = (value: string) => {
    if (!value.trim()) return;
    const now = Date.now();
    if (now - typingSentAtRef.current < 2500) return;
    typingSentAtRef.current = now;
    window.api.rooms.typing(room.roomId);
  };

  const focusCompose = () => {
    const el = composeRef.current;
    if (!el) return;
    const win = el.ownerDocument.defaultView ?? window;
    win.requestAnimationFrame(() => { el.focus(); const n = el.value.length; el.selectionStart = el.selectionEnd = n; });
  };
  const startReply = (m: RoomChatMessage) => { const body = room.chatEdits?.[m.id]?.text ?? search.page.edits[m.id]?.text ?? m.text; composer.reply({ id: m.id, name: m.name, text: parseFileRequest(body)?.title ?? body }); focusCompose(); };
  const startEdit = (m: RoomChatMessage) => {
    composer.edit(m.id, room.chatEdits?.[m.id]?.text ?? m.text);
    focusCompose();
  };
  // Canceling an edit restores the composed message and its reply context.
  const cancelCompose = () => composer.cancel();
  const send = () => composer.send();

  // @mention autocomplete: track a trailing "@word" at the caret; the popup
  // intercepts Enter/Tab/arrows while open (send/indent resume when closed).
  const [mention, setMention] = useState<null | { query: string; start: number; caret: number }>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  useEffect(() => { setMention(null); }, [room.roomId, zoneTab]);
  const mentionCandidates = useMemo(() => {
    if (!mention) return [];
    const seen = new Set<string>();
    return room.members.filter((m) => {
      if (m.isSelf || !m.name) return false;
      const k = m.name.toLowerCase();
      if (!k.startsWith(mention.query) || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 6);
  }, [mention, room.members]);
  // The candidate list recomputes on every room push — a stale index must
  // clamp, not dereference past the end.
  const mentionActiveIdx = Math.min(mentionIdx, Math.max(0, mentionCandidates.length - 1));
  const insertMention = (name: string) => {
    if (!mention) return;
    const next = `${text.slice(0, mention.start)}@${name} ${text.slice(mention.caret)}`;
    setMention(null);
    if (next.length > 2000) return;
    setText(next);
    const el = composeRef.current;
    if (el) {
      const pos = mention.start + name.length + 2;
      const win = el.ownerDocument.defaultView ?? window;
      win.requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = pos; });
    }
  };
  const trackMention = (value: string, caret: number) => {
    const upto = value.slice(0, caret);
    const mm = /(^|\s)@([\p{L}\p{N}_-]{0,24})$/u.exec(upto);
    setMention(mm ? { query: mm[2].toLowerCase(), start: caret - mm[2].length - 1, caret } : null);
    setMentionIdx(0);
  };

  // Tab inserts an indent at the caret (scripts!) instead of moving focus.
  const onComposeKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return; // IME: Enter confirms the composition, not send
    if (mention && mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionCandidates.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(mentionCandidates[mentionActiveIdx].name); return; }
      if (e.key === 'Escape') { setMention(null); return; }
    }
    if (e.key === 'Escape' && (editing || replyingTo)) { e.preventDefault(); cancelCompose(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: s, selectionEnd: en } = el;
      const next = text.slice(0, s) + '\t' + text.slice(en);
      if (next.length <= 2000) {
        setText(next);
        // Restore the caret via the textarea's OWN window — the main window's rAF
        // is throttled while it is minimized behind a detached chat.
        const win = el.ownerDocument.defaultView ?? window;
        win.requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 1; });
      }
    }
  };

  // ONE class list wherever this panel is docked. The room's stacking rules are
  // `@container room` queries, which cannot reach a child window (it has no `room`
  // ancestor), and the dock window's own body supplies the fill-the-window layout —
  // so there is nothing left for a detached variant to undo.
  const zone = (
    <div className="room-section room-chat-section">
      <div className="room-chat-zone-tabs">
        {showTitle && <span className="room-zone-name">{t('rooms.chat')}</span>}
        {/* A VIEW SWITCH, not an action — so it sits at the START of the row, where
            the eye looks for "what am I looking at", and the actions keep the end.
            Labelled rather than a bare glyph: it was indistinguishable from search
            sitting next to it, and the two do entirely different things. */}
        <button
          type="button"
          className={`room-zone-switch${zoneTab === 'history' ? ' active' : ''}`}
          aria-pressed={zoneTab === 'history'}
          onClick={() => setZoneTab((v) => (v === 'history' ? 'chat' : 'history'))}
        >
          <Icon name="list" size={12} />
          {t('rooms.history')}
        </button>
        <button
          type="button"
          className={`room-zone-action room-zone-search${searchOpen ? ' active' : ''}`}
          title={t('rooms.chatSearch')}
          onClick={() => { setZoneTab('chat'); setSearchOpen((o) => { if (o) { setChatQuery(''); setFilters(EMPTY_CHAT_FILTER); setFiltersExpanded(false); } return !o; }); }}
        >
          <Icon name="search" size={13} />
        </button>
        <button type="button" className={`room-zone-action${zoneTab === 'pins' ? ' active' : ''}`} title={t('rooms.chatPins')} aria-label={t('rooms.chatPins')}
          aria-pressed={zoneTab === 'pins'} onClick={() => setZoneTab(v => v === 'pins' ? 'chat' : 'pins')}><Icon name="pin" size={13} />{pins.length > 0 && <span>{pins.length}</span>}</button>
        {/* No detach button here: the tab's "Move to ▸ New window" is the ONE way
            a panel leaves the room, for every panel — and when this zone holds only
            chat its strip is hidden, so the handle below IS that tab's menu. */}
        {soloHandle}
      </div>
      {zoneTab === 'history' ? (
        <div className="room-chat room-zone-history">
          {room.history.length === 0 ? (
            <div className="room-files-empty">{t('rooms.historyEmpty')}</div>
          ) : (
            <div className="room-history room-history-zone">
              {room.history.slice().reverse().map((ev) => (
                <div key={ev.id} className="room-history-item">
                  <span className="room-history-actor">{ev.actorName}</span>
                  <span className="room-history-text">{eventText(t, ev)}</span>
                  <span className="room-history-time">{shortTime(ev.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : zoneTab === 'pins' ? (
        <div className="room-chat room-chat-pins">
          <div className="room-chat-pins-intro">
            <h3>{t('rooms.chatPins')}</h3>
            <p className="room-chat-tools-hint">{t('rooms.chatPinsHint')}</p>
          </div>
          {pins.length === 0 ? <div className="room-files-empty">{t('rooms.chatPinsEmpty')}</div> : <div className="room-chat-pin-list">{pins.map(pin => {
            const m = pin.message, body = room.chatEdits?.[m.id]?.text ?? pin.edit?.text ?? m.text;
            const request = parseFileRequest(body);
            return <article key={m.id} className="room-chat-pin-card">
              <header className="room-chat-pin-author"><Icon name="pin" size={12} /><strong>{room.members.find(member => member.memberId === m.memberId)?.name ?? m.name}</strong><time>{shortTime(m.at)}</time></header>
              <div className="room-chat-pin-body">
                {request ? <RoomFileRequestCard request={request} message={m} roomId={room.roomId} files={room.files} canEdit={false} />
                  : <RoomChatBody text={body} copyLabel={t('rooms.chatCopy')} copiedLabel={t('rooms.chatCopied')} selfName={selfName} />}
              </div>
              <footer className="room-chat-pin-buttons">{messages.some(message => message.id === m.id) && <Button variant="ghost" size="sm" onClick={() => revealMessage(m.id)}>{t('rooms.chatGoTo')}</Button>}
                {isOwner && <Button variant="ghost" size="sm" disabled={pinBusy} onClick={() => void togglePin(m.id, false)}>{t('rooms.chatUnpin')}</Button>}</footer>
            </article>;
          })}</div>}
        </div>
      ) : (
      <div className="room-chat">
        {chatCardMember && chatCardFor && (
          <ProfileCard
            member={chatCardMember}
            totalFiles={room.files.length}
            anchor={chatCardFor.anchor}
            canManage={false}
            onClose={() => setChatCardFor(null)}
          />
        )}
        {searchOpen && (
          <div className="room-chat-search-panel">
            <div className="room-chat-search">
              <Icon name="search" size={14} />
              <input
                ref={searchInputRef} type="text" autoFocus placeholder={t('rooms.chatSearch')} value={chatQuery}
                maxLength={200} aria-label={t('rooms.chatSearch')}
                onChange={(e) => setChatQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setChatQuery(''); setFilters(EMPTY_CHAT_FILTER); setSearchOpen(false); setFiltersExpanded(false); } }}
              />
              {chatQuery && <button type="button" className="room-chat-search-clear" aria-label={t('rooms.chatSearchClearQuery')}
                title={t('rooms.chatSearchClearQuery')} onClick={() => { setChatQuery(''); searchInputRef.current?.focus(); }}><Icon name="x" size={14} /></button>}
            </div>
            <div className="room-chat-search-toolbar">
              <button type="button" className={`room-chat-filter-toggle${filtersExpanded ? ' active' : ''}`} aria-expanded={filtersExpanded}
                aria-controls={filtersExpanded ? `${searchId}-filters` : undefined} onClick={() => setFiltersExpanded(v => !v)}>
                <Icon name="sliders" size={13} />{t('rooms.chatFilters')}
                {filterCount > 0 && <span className="room-chat-filter-count">{filterCount}</span>}
                <Icon name={filtersExpanded ? 'chevron-up' : 'chevron-down'} size={12} />
              </button>
              {search.active && <button type="button" className="room-chat-search-reset" onClick={() => { setChatQuery(''); setFilters(EMPTY_CHAT_FILTER); searchInputRef.current?.focus(); }}>{t('rooms.chatFilterClear')}</button>}
            </div>
            {filtersExpanded && <div className="room-chat-search-filters" id={`${searchId}-filters`}>
              <div className="room-chat-search-field">
                <label htmlFor={`${searchId}-author`}>{t('rooms.chatAuthorLabel')}</label>
                <Select id={`${searchId}-author`} ariaLabel={t('rooms.chatFilterAuthor')} value={filters.author} onChange={author => setFilters(f => ({ ...f, author }))}
                  options={[{ value: '', label: t('rooms.chatFilterAuthor') }, ...Array.from(new Map([...room.members.map(m => [m.memberId, m.name] as const), ...messages.map(m => [m.memberId, m.name] as const), ...search.page.messages.map(m => [m.memberId, m.name] as const)]).entries()).map(([value, label]) => ({ value, label }))]} />
              </div>
              <div className="room-chat-search-field">
                <label htmlFor={`${searchId}-kind`}>{t('rooms.chatFilterKind')}</label>
                <Select id={`${searchId}-kind`} ariaLabel={t('rooms.chatFilterKind')} value={filters.kind} onChange={kind => setFilters(f => ({ ...f, kind: kind as RoomChatFilter['kind'] }))}
                  options={(['all', 'links', 'requests', 'mentions'] as const).map(value => ({ value, label: t(`rooms.chatFilter.${value}`) }))} />
              </div>
              <fieldset className="room-chat-search-period">
                <legend>{t('rooms.chatPeriodLabel')}</legend>
                <div className="room-chat-search-dates">
                  <div className="room-chat-search-field"><label htmlFor={`${searchId}-from`}>{t('rooms.chatDateFrom')}</label>
                    <input id={`${searchId}-from`} type="date" value={filters.after} max={filters.before || undefined} onChange={e => setFilters(f => ({ ...f, after: e.target.value }))} /></div>
                  <div className="room-chat-search-field"><label htmlFor={`${searchId}-to`}>{t('rooms.chatDateTo')}</label>
                    <input id={`${searchId}-to`} type="date" value={filters.before} min={filters.after || undefined} onChange={e => setFilters(f => ({ ...f, before: e.target.value }))} /></div>
                </div>
              </fieldset>
            </div>}
            <div className={`room-chat-search-meta${search.error ? ' error' : ''}`} role="status" title={search.error || t('rooms.chatSearchLocal')}>
              {search.busy ? t('common.loading') : search.error || (search.active
                ? t('rooms.chatSearchResults').replace('{n}', `${search.page.messages.length}${search.page.next ? '+' : ''}`)
                : t('rooms.chatSearchScope'))}
            </div>
          </div>
        )}
        {firstUnreadMessage(messages, room.chatLastReadAt ?? 0, selfId) && <div className="room-chat-unread-nav">
          <Button variant="ghost" size="sm" onClick={() => revealMessage(firstUnreadMessage(messages, room.chatLastReadAt ?? 0, selfId)!.id)}><Icon name="arrow-down" size={12} />{t('rooms.chatFirstUnread')}</Button>
          <button type="button" className="room-zone-action" title={t('rooms.chatMarkRead')} aria-label={t('rooms.chatMarkRead')} onClick={() => window.api.rooms.markRead(room.roomId, messages.at(-1)?.id).catch(e => toast.error(String(e)))}><Icon name="check" size={13} /></button>
        </div>}
        <div className="room-chat-log" ref={listRef} onScroll={onLogScroll}>
          {search.active && search.page.next && <Button variant="ghost" size="sm" disabled={search.busy} onClick={() => void search.more()}>{t('rooms.chatSearchMore')}</Button>}
          {!search.active && messages.length > 0 && (
            <div className="room-chat-history-window">
              {visibleMessages.length < messages.length ? (
                <Button variant="ghost" size="sm" onClick={showEarlier}>{t('rooms.chatShowEarlier')}</Button>
              ) : <span>{t('rooms.chatHistoryWindow').replace('{n}', String(ROOM_CHAT_LIMIT))}</span>}
            </div>
          )}
          {(search.active ? search.page.messages : messages).length === 0 ? (
            <div className="room-files-empty">{t(search.busy ? 'common.loading' : search.active ? 'rooms.chatSearchEmpty' : 'rooms.chatEmpty')}</div>
          ) : (() => {
            const q = chatQuery.trim().toLowerCase();
            const shown = search.active ? search.page.messages : visibleMessages;
            if (q && shown.length === 0) return <div className="room-files-empty">{t('rooms.chatSearchEmpty')}</div>;
            return shown.map((m, i) => {
              const mine = m.memberId === selfId;
              // Live member (if still around) carries the rich profile: custom
              // avatar, name color, and the click-through card. The message's
              // own name/seed snapshot is the fallback for departed members.
              const live = room.members.find((mm) => mm.memberId === m.memberId);
              const prev = i > 0 ? shown[i - 1] : null;
              const newDay = !prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString();
              // Continuation: same author within 5 min on the same day —
              // collapse the avatar/name so bursts read as one block.
              const cont = !!prev && !newDay && prev.memberId === m.memberId && m.at >= prev.at && m.at - prev.at < 5 * 60_000;
              // An author edit overlays the original text (the stored message is
              // never mutated); `edit` present → show an "edited" marker.
              const liveMessage = messages.some(message => message.id === m.id);
              const edit = room.chatEdits?.[m.id] ?? search.page.edits[m.id];
              const body = edit?.text ?? m.text;
              return (
                <React.Fragment key={m.id}>
                  {newDay && (
                    <div className="room-chat-day" aria-hidden="true"><span>{dayLabel(m.at, t)}</span></div>
                  )}
                  {m.id === unreadId && !search.active && <div className="room-chat-unread-marker" role="separator">{t('rooms.chatUnread')}</div>}
                  <div data-chat-id={m.id} className={`room-chat-msg ${mine ? 'mine' : ''}${cont ? ' cont' : ''}${highlightId === m.id ? ' highlighted' : ''}`}>
                    {!mine && (cont ? (
                      <span className="room-chat-gutter" aria-hidden="true" />
                    ) : live ? (
                      <button
                        type="button"
                        className="room-member-open"
                        title={t('rooms.profileCardHint')}
                        aria-haspopup="dialog"
                        aria-expanded={chatCardFor?.memberId === m.memberId}
                        onClick={(e) => {
                          // React clears currentTarget after dispatch; state updaters may run later.
                          const anchor = e.currentTarget;
                          setChatCardFor((cur) => (cur?.memberId === m.memberId ? null : { memberId: m.memberId, anchor }));
                        }}
                      >
                        <Avatar seed={live.avatarSeed} img={live.avatarImg} size={28} />
                      </button>
                    ) : (
                      <Identicon seed={m.avatarSeed} size={28} />
                    ))}
                    <div className="room-chat-bubble-wrap">
                      {!mine && !cont && <span className="room-chat-author" style={live?.color ? { color: live.color } : undefined}>{live?.name || m.name || '?'}</span>}
                      {/* Reply quote — resolve the live parent by id (edited text
                          wins), fall back to the carried snapshot for a parent that
                          scrolled out of the capped window or never arrived. */}
                      {m.replyTo && (() => {
                        const parent = messages.find((p) => p.id === m.replyTo);
                        const pName = parent?.name || m.replyName;
                        const rawQuote = (parent ? (room.chatEdits?.[parent.id]?.text ?? parent.text) : m.replyText) || '';
                        const pText = parseFileRequest(rawQuote)?.title ?? rawQuote;
                        return (
                          <span className="room-chat-quote" title={pText.replace(/^🙋\s*/, '')}>
                            <span className="room-chat-quote-name">{pName || t('rooms.chatReplyUnknown')}</span>
                            {m.chatV !== 2 && <span className="room-chat-quote-legacy" title={t('rooms.chatLegacyQuoteHint')}>{t('rooms.chatLegacyQuote')}</span>}
                            {pText && <span className="room-chat-quote-text">{pText.replace(/^🙋\s*/, '')}</span>}
                          </span>
                        );
                      })()}
                      {parseFileRequest(body) ? (
                        <RoomFileRequestCard key={m.id} request={parseFileRequest(body)!} message={m} roomId={room.roomId} files={room.files}
                          canEdit={mine && liveMessage} onAttach={!mine ? onAttachRequest : undefined} />
                      ) : (
                        <RoomChatBody text={body} copyLabel={t('rooms.chatCopy')} copiedLabel={t('rooms.chatCopied')} selfName={mine ? undefined : selfName} query={q} />
                      )}
                      {/* Reaction pills — the row exists only when reactions do
                          (an always-present row would pad EVERY message). */}
                      {(() => {
                        const reacts = room.chatReacts?.[m.id];
                        const present = CHAT_REACT_EMOJIS.filter((e) => (reacts?.[e] || []).length > 0);
                        if (!present.length) return null;
                        return (
                          <span className="room-chat-reacts">
                            {present.map((emoji) => {
                              const ids = reacts?.[emoji] || [];
                              const own = !!selfId && ids.includes(selfId);
                              return (
                                <button
                                  key={emoji}
                                  type="button"
                                  className={`room-chat-react${own ? ' mine' : ''}`}
                                  aria-pressed={own}
                                  title={ids.map((id) => room.members.find((mm) => mm.memberId === id)?.name || '?').join(', ')}
                                  onClick={() => toggleChatReact(m.id, emoji)}
                                >
                                  {emoji}<span className="room-chat-react-n">{ids.length}</span>
                                </button>
                              );
                            })}
                          </span>
                        );
                      })()}
                      <span className="room-chat-time">{timeOnly(m.at)}{edit && <span className="room-chat-edited"> · {t('rooms.chatEdited')}</span>}</span>
                    </div>
                    {/* Hover actions: reply / edit(own) / react. Absolutely
                        positioned as a cluster — costs no layout height. */}
                    <div className="room-chat-actions">
                      <button type="button" className="room-chat-act" disabled={!liveMessage} title={t('rooms.chatReply')} onClick={() => startReply(m)}>
                        <Icon name="reply" size={11} />
                      </button>
                      {isOwner && liveMessage && <button type="button" className="room-chat-act" disabled={pinBusy || !pins.some(p => p.message.id === m.id) && pins.length >= 10}
                        title={t(pins.some(p => p.message.id === m.id) ? 'rooms.chatUnpin' : 'rooms.chatPin')} aria-pressed={pins.some(p => p.message.id === m.id)}
                        onClick={() => void togglePin(m.id, !pins.some(p => p.message.id === m.id))}><Icon name="pin" size={11} /></button>}
                      {mine && liveMessage && !parseFileRequest(body) && (
                        <button type="button" className="room-chat-act" title={t('rooms.chatEdit')} onClick={() => startEdit(m)}>
                          <Icon name="edit-2" size={11} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="room-chat-act"
                        disabled={!liveMessage} title={t('rooms.chatReact')}
                        onClick={(e) => {
                          const btn = e.currentTarget as HTMLElement;
                          const win = btn.ownerDocument.defaultView ?? window;
                          const r = btn.getBoundingClientRect();
                          setReactFor((cur) => {
                            if (cur?.msgId === m.id) return null;
                            const w = 8 * 26 + 12; // palette width approximation
                            const x = Math.max(4, Math.min(r.left, win.innerWidth - w - 4));
                            const y = r.top - 38 < 4 ? r.bottom + 4 : r.top - 38;
                            return { msgId: m.id, x, y };
                          });
                        }}
                      >
                        <Icon name="plus" size={11} />
                      </button>
                    </div>
                  </div>
                </React.Fragment>
              );
            });
          })()}
          {newCount > 0 && !search.active && (
            <button type="button" className="room-chat-newpill" onClick={scrollToNewest}>
              <Icon name="arrow-down" size={12} /> {t('rooms.newMsgs').replace('{n}', String(newCount))}
            </button>
          )}
        </div>
        {reactFor && createPortal(
          <span className="room-chat-react-pop" style={{ position: 'fixed', left: reactFor.x, top: reactFor.y }}>
            {CHAT_REACT_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="room-chat-react-opt"
                // mousedown-preventDefault: keep composer focus intact.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { const id = reactFor.msgId; setReactFor(null); toggleChatReact(id, emoji); }}
              >
                {emoji}
              </button>
            ))}
          </span>,
          (listRef.current?.ownerDocument ?? document).body,
        )}
        <div className={`room-chat-typing${typingNames.length > 0 ? ' on' : ''}`} aria-live="polite">
          {typingNames.length > 0 && (
            <>
              <span className="room-chat-typing-text">
                {typingNames.length === 1
                  ? `${typingNames[0]} ${t('rooms.typingOne')}`
                  : `${typingNames[0]} ${t('rooms.typingAnd')} ${typingNames.length - 1} ${t('rooms.typingMany')}`}
              </span>
              <span className="room-chat-typing-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
            </>
          )}
          {/* Near-limit counter only — silence until 1800 keeps the row calm.
              aria-hidden: this sits inside the typing row's polite live region,
              and a per-keystroke announcement would bury the screen reader. */}
          {text.length >= 1800 && (
            <span className={`room-chat-count${text.length >= 1950 ? ' warn' : ''}`} aria-hidden="true">{text.length}/2000</span>
          )}
        </div>
        <div className="room-chat-compose">
          {(editing || replyingTo) && (
            <div className="room-chat-compose-ctx">
              <Icon name={editing ? 'edit-2' : 'reply'} size={12} />
              <span className="room-chat-compose-ctx-label">
                {editing ? t('rooms.chatEditing') : t('rooms.chatReplyingTo')}
                {replyingTo && <b> {replyingTo.name || '?'}</b>}
              </span>
              {replyingTo && <span className="room-chat-compose-ctx-quote">{(room.chatEdits?.[replyingTo.id]?.text ?? replyingTo.text).replace(/^🙋\s*/, '')}</span>}
              <button type="button" className="room-chat-compose-ctx-x" onClick={cancelCompose} title={t('rooms.chatCancel')}>
                <Icon name="x" size={12} />
              </button>
            </div>
          )}
          {mention && mentionCandidates.length > 0 && (
            <div className="room-chat-mention-pop">
              {mentionCandidates.map((m, i) => (
                <button
                  key={m.memberId}
                  type="button"
                  className={`room-chat-mention-item${i === mentionActiveIdx ? ' active' : ''}`}
                  // mousedown, not click — a click would blur the textarea first.
                  onMouseDown={(e) => { e.preventDefault(); insertMention(m.name); }}
                >
                  <Identicon seed={m.avatarSeed} size={18} />
                  <span style={m.color ? { color: m.color } : undefined}>{m.name}</span>
                </button>
              ))}
            </div>
          )}
          <div className="room-chat-compose-row">
            <textarea
              ref={composeRef}
              className="rooms-input room-chat-input"
              placeholder={t('rooms.chatPlaceholder')}
              value={text}
              disabled={sending || !composeState.ready}
              maxLength={2000}
              rows={1}
              onChange={(e) => {
                setText(e.target.value);
                pingTyping(e.target.value);
                trackMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyDown={onComposeKeyDown}
            />
            <Button variant="primary" size="sm" onClick={send} loading={sending} disabled={!text.trim() || !composeState.ready} icon={<Icon name="send" size={14} />}>
              {t(composeState.phase === 'error' ? 'rooms.chatRetry' : 'rooms.chatSend')}
            </Button>
          </div>
          {composeState.phase !== 'idle' && (
            <div className={`room-chat-send-state ${composeState.phase}`} role="status">
              {t(`rooms.chatDelivery.${composeState.phase}`)}{composeState.error ? `: ${composeState.error}` : ''}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );

  // ONE tree, docked or detached. When the dock moves this panel into a torn-off
  // group, DockWindowHost portals the whole zone (strip + panels) into that window
  // and mounts HostWindowProvider around it, so everything below resolves `document`
  // to the CHILD window without this component knowing which realm it is in.
  return zone;
};
