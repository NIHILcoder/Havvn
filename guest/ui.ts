/**
 * Guest page UI — Blaze HUD, three regions (People+Voice | Stage | Chat).
 * The room shell is mounted once; subsequent gossip only patches dirty panes
 * so a VAD tick cannot remount the video or wipe the composer.
 */

import { GuestRoom, type GuestSnapshot, type GuestFile, type SyncEvent } from './mesh';
import { identiconSvg, makeAvatarSeed, randomAvatarBase } from './identicon';
import { t, detectLang, persistLang, type GuestLang, type GuestKey } from './i18n';
import { parseGuestLocation, PUBLIC_STUN_SERVERS } from '../shared/room-guest-url';
import { generateIdentityWeb, type GuestIdentity } from '../shared/room-web-crypto';
import { parseChatSegments, splitLinks, isCopyworthy } from '../shared/chat-format';
import { CHAT_REACT_EMOJIS } from '../shared/reactions';
import { playMagnet, webtorrentOk, type WatchHandle } from './watch';

const ID_KEY = 'havvn.guest.identity.v1';
const NAME_KEY = 'havvn.guest.name';
const SEED_KEY = 'havvn.guest.avatarSeed';

const MARK = `<svg class="mk" viewBox="0 0 512 295.8" aria-hidden="true"><path fill="#161311" d="M6.2 6.3L217 147.9L223.9 161.8L256 127.7L288.1 161.8L295 147.9L505.8 6.3L366.7 222.8L369.2 232.2L330.5 289.6L256 204.6L181.5 289.6L142.8 232.2L145.3 222.8Z"/><path fill="#e25117" d="M478.1 34.8L358.2 221.2L360.4 230.9L329.7 276.6L256 192.5L182.3 276.6L151.6 230.9L154.1 221.8L153.8 221.2L33.9 34.8L211 153.4L221.7 175.9L256 139.3L290.3 175.9L301 153.4Z"/></svg>`;
const WORDMARK = `<svg class="wmh" viewBox="0 0 440 100" role="img" aria-label="Havvn"><path fill="#f2efe9" d="M11.5 18.0L40.0 0.0L26.0 100.0L0.0 100.0ZM60.0 0.0L86.0 0.0L74.5 82.0L46.0 100.0ZM28.7 38.0L60.7 38.0L57.5 61.0L25.5 61.0ZM138.0 0.0L133.8 30.0L111.0 100.0L85.0 100.0ZM138.0 0.0L163.0 100.0L137.0 100.0L133.8 30.0ZM110.3 62.0L148.3 62.0L145.2 84.0L107.2 84.0ZM364.0 0.0L390.0 0.0L376.0 100.0L350.0 100.0ZM411.5 18.0L440.0 0.0L426.0 100.0L400.0 100.0ZM364.0 0.0L390.0 0.0L426.0 100.0L400.0 100.0Z"/><path fill="#e25117" d="M190.0 0.0L218.0 0.0L218.9 72.0L215.0 100.0ZM268.0 0.0L240.0 0.0L218.9 72.0L215.0 100.0ZM273.0 0.0L301.0 0.0L301.9 72.0L298.0 100.0ZM351.0 0.0L323.0 0.0L301.9 72.0L298.0 100.0Z"/></svg>`;

function $(sel: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector(sel);
}

async function loadIdentity(): Promise<GuestIdentity> {
  try {
    const raw = localStorage.getItem(ID_KEY);
    if (raw) {
      const o = JSON.parse(raw) as GuestIdentity;
      if (o.pub && o.priv && o.memberId) return o;
    }
  } catch { /* mint */ }
  const id = await generateIdentityWeb();
  try { localStorage.setItem(ID_KEY, JSON.stringify(id)); } catch { /* ignore */ }
  return id;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function dayLabel(at: number, lang: GuestLang): string {
  const d = new Date(at);
  const now = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return t(lang, 'today');
  if (diff === 1) return t(lang, 'yesterday');
  try { return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' }); } catch { return ''; }
}

function timeLabel(at: number): string {
  try { return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function renderBody(text: string, lang: GuestLang): string {
  const segs = parseChatSegments(text);
  return segs.map((s) => {
    if (s.kind === 'code') {
      return `<pre class="code"><code>${esc(s.text)}</code></pre>`;
    }
    const runs = splitLinks(s.text);
    return `<span class="txt">${runs.map((r) => (
      r.kind === 'link'
        ? `<a href="${esc(r.href)}" target="_blank" rel="noopener noreferrer">${esc(r.text)}</a>`
        : esc(r.text)
    )).join('')}</span>`;
  }).join('') + (isCopyworthy(text) ? `<button type="button" class="copy-msg" data-copy="${esc(text)}">${t(lang, 'copy')}</button>` : '');
}

function hudTitle(lang: GuestLang): string {
  const raw = t(lang, 'title');
  const i = raw.indexOf('//');
  return i >= 0 ? raw.slice(i + 2).trim() : raw;
}

function langButtons(lang: GuestLang): string {
  return `<div class="lang">
    <button type="button" data-lang="en" class="${lang === 'en' ? 'on' : ''}" aria-pressed="${lang === 'en'}">EN</button>
    <button type="button" data-lang="ru" class="${lang === 'ru' ? 'on' : ''}" aria-pressed="${lang === 'ru'}">RU</button>
  </div>`;
}

export class GuestApp {
  private lang: GuestLang = detectLang();
  private room: GuestRoom | null = null;
  private watch: WatchHandle | null = null;
  private watching: GuestFile | null = null;
  private together = true;
  private applyingRemote = false;
  private replyTo: string | null = null;
  private tab: 'people' | 'watch' | 'chat' = 'chat';
  private watchers: Record<string, { name: string; avatarSeed: string; at: number }> = {};
  private view: 'gate' | 'room' | 'kicked' | null = null;
  private voiceNote = '';
  private hostWait = false;
  private hostTimer: ReturnType<typeof setTimeout> | null = null;
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private paintQueued = false;
  private last = { header: '', members: '', voice: '', files: '', chat: '', typing: '', reply: '', watchers: '' };
  private root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    document.documentElement.lang = this.lang;
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('submit', (e) => this.onSubmit(e));
    this.root.addEventListener('input', (e) => this.onInput(e));
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('pagehide', () => this.shutdown());
    window.addEventListener('beforeunload', () => this.shutdown());
    this.gate();
  }

  private L(key: GuestKey, vars?: Record<string, string | number>): string {
    return t(this.lang, key, vars);
  }

  private loc() {
    return parseGuestLocation(location.hash, location.search);
  }

  private setLang(lang: GuestLang): void {
    this.lang = lang;
    persistLang(lang);
    document.documentElement.lang = lang;
    this.last = { header: '', members: '', voice: '', files: '', chat: '', typing: '', reply: '', watchers: '' };
    if (this.view === 'room' && this.room) {
      this.view = null;
      this.mountRoom(this.room.snapshot());
      this.syncRoom();
    } else if (this.view === 'kicked') this.kicked();
    else this.gate();
  }

  private shutdown(): void {
    if (this.watching && this.room) {
      void this.room.sendSync({
        fileId: this.watching.fileId, action: 'leave',
        position: 0, rate: 1, at: Date.now(), playing: false, together: this.together,
      });
    }
    this.watch?.destroy();
    this.watch = null;
    this.room?.leave();
  }

  private gate(): void {
    this.view = 'gate';
    const loc = this.loc();
    let name = '';
    try { name = localStorage.getItem(NAME_KEY) || ''; } catch { /* ignore */ }
    this.root.innerHTML = `
      <div class="shell gate">
        <header class="top">
          ${MARK}
          <h1>${WORDMARK}<span class="hsep">//</span> ${esc(hudTitle(this.lang))}</h1>
          ${langButtons(this.lang)}
        </header>
        <div class="card">
          <p class="tag">${this.L('tagline')}</p>
          <label class="lbl">${this.L('name')}<input id="name" maxlength="64" placeholder="${esc(this.L('namePh'))}" value="${esc(name)}" autocomplete="nickname"/></label>
          <label class="lbl">${this.L('invite')}<input id="invite" placeholder="${esc(this.L('invitePh'))}" value="${esc(loc.invite)}" autocomplete="off" spellcheck="false"/></label>
          <button type="button" class="btn" data-act="join">${this.L('join')}</button>
          <p class="hint" id="hint">${this.L('needHost')}</p>
        </div>
      </div>`;
  }

  private kicked(): void {
    this.view = 'kicked';
    this.root.innerHTML = `
      <div class="shell gate">
        <header class="top">${MARK}<h1>${WORDMARK}<span class="hsep">//</span> ${esc(hudTitle(this.lang))}</h1></header>
        <div class="card">
          <p class="status error">${this.L('kicked')}</p>
          <p class="hint">${this.L('kickedHint')}</p>
        </div>
      </div>`;
  }

  private async doJoin(): Promise<void> {
    const nameEl = $('#name', this.root) as HTMLInputElement | null;
    const invEl = $('#invite', this.root) as HTMLInputElement | null;
    const hint = $('#hint', this.root);
    const name = (nameEl?.value || '').trim() || this.L('guest');
    const invite = (invEl?.value || '').trim();
    if (invite.length < 8) { if (hint) hint.textContent = this.L('badInvite'); return; }
    if (!globalThis.crypto?.subtle) { if (hint) hint.textContent = this.L('cryptoFail'); return; }
    if (!window.RTCPeerConnection) { if (hint) hint.textContent = this.L('webrtcFail'); return; }
    try { localStorage.setItem(NAME_KEY, name); } catch { /* ignore */ }
    if (hint) hint.textContent = this.L('joining');
    const joinBtn = this.root.querySelector('[data-act="join"]') as HTMLButtonElement | null;
    if (joinBtn) { joinBtn.disabled = true; joinBtn.textContent = this.L('joining'); }
    try {
      const identity = await loadIdentity();
      let seed = '';
      try { seed = localStorage.getItem(SEED_KEY) || ''; } catch { /* ignore */ }
      if (!seed) {
        seed = makeAvatarSeed('mirror', randomAvatarBase());
        try { localStorage.setItem(SEED_KEY, seed); } catch { /* ignore */ }
      }
      const loc = this.loc();
      const room = new GuestRoom({
        identity, name, avatarSeed: seed,
        iceServers: [...PUBLIC_STUN_SERVERS],
        trackers: loc.trackers,
        onChange: () => this.queuePaint(),
      });
      room.onSync = (ev) => this.onSync(ev);
      if (hint) hint.textContent = this.L('connecting');
      await room.join(invite);
      try {
        const hash = '#' + encodeURIComponent(invite);
        if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
      } catch { /* ignore */ }
      this.room = room;
      this.hostWait = false;
      if (this.hostTimer) clearTimeout(this.hostTimer);
      this.hostTimer = setTimeout(() => {
        if (this.room && !this.room.snapshot().connected) {
          this.hostWait = true;
          this.queuePaint();
        }
      }, 12_000);
      this.mountRoom(room.snapshot());
      this.syncRoom();
    } catch (e) {
      if (hint) hint.textContent = e instanceof Error && e.message === 'bad-invite' ? this.L('badInvite') : this.L('cryptoFail');
      if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = this.L('join'); }
    }
  }

  private queuePaint(): void {
    if (this.paintQueued) return;
    this.paintQueued = true;
    requestAnimationFrame(() => {
      this.paintQueued = false;
      this.syncRoom();
    });
  }

  private mountRoom(s: GuestSnapshot): void {
    this.view = 'room';
    this.last = { header: '', members: '', voice: '', files: '', chat: '', typing: '', reply: '', watchers: '' };
    this.root.innerHTML = `
      <div class="shell room" data-tab="${this.tab}">
        <header class="top" id="hdr"></header>
        <div class="banner" id="banner" hidden></div>
        <nav class="tabs" role="tablist">
          <button type="button" data-tab="people">${this.L('people')}</button>
          <button type="button" data-tab="watch">${this.L('watch')}</button>
          <button type="button" data-tab="chat">${this.L('chat')}</button>
        </nav>
        <div class="cols">
          <aside class="col people" data-pane="people">
            <div class="eyebrow">${this.L('people')}</div>
            <div class="members" id="members"></div>
            <div class="eyebrow">${this.L('voice')}</div>
            <div id="voice"></div>
          </aside>
          <section class="col stage" data-pane="watch">
            <div class="eyebrow">${this.L('files')}</div>
            <div id="player-host"></div>
            <div class="files" id="files"></div>
          </section>
          <section class="col chat" data-pane="chat">
            <div class="eyebrow">${this.L('chat')}</div>
            <div class="log" id="log"></div>
            <div class="typing" id="typing"></div>
            <div class="reply-bar" id="reply" hidden></div>
            <form class="composer" id="composer">
              <textarea id="box" rows="1" placeholder="${esc(this.L('chatPh'))}" maxlength="2000"></textarea>
              <button type="submit" class="btn">${this.L('send')}</button>
            </form>
          </section>
        </div>
      </div>`;
    this.patchHeader(s);
    this.patchBanner(s);
  }

  private syncRoom(): void {
    if (!this.room) return;
    const s = this.room.snapshot();
    if (s.kicked) {
      this.watch?.destroy();
      this.watch = null;
      this.watching = null;
      this.kicked();
      return;
    }
    if (this.view !== 'room') this.mountRoom(s);
    this.patchHeader(s);
    this.patchBanner(s);
    this.patchMembers(s);
    this.patchVoice(s);
    this.patchFiles(s);
    this.patchPlayer();
    this.patchChat(s);
    this.patchTyping(s);
    this.patchReply(s);
    this.root.querySelector('.shell.room')?.setAttribute('data-tab', this.tab);
    this.root.querySelectorAll('[data-tab]').forEach((b) => {
      (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.tab === this.tab);
    });
  }

  private patchHeader(s: GuestSnapshot): void {
    const conn = s.connected ? this.L('connected') : this.L('connecting');
    const wait = !s.connected && this.hostWait ? ` · ${this.L('needHost')}` : '';
    const sig = [s.roomName, s.topic, s.connected, s.peerCount, this.lang, wait].join('|');
    if (sig === this.last.header) return;
    this.last.header = sig;
    const hdr = $('#hdr', this.root);
    if (!hdr) return;
    hdr.innerHTML = `
      ${MARK}
      <div class="room-id">
        <h1>${WORDMARK}<span class="hsep">//</span> ${esc(s.roomName || hudTitle(this.lang))}</h1>
        ${s.topic ? `<p class="topic">${esc(s.topic)}</p>` : ''}
      </div>
      <div class="status ${s.connected ? 'ok' : ''}"><span class="dot ${s.connected ? 'live' : ''}"></span>${esc(conn)} · ${this.L('peers', { n: s.peerCount })}${esc(wait)}</div>
      ${langButtons(this.lang)}
      <button type="button" class="ghost" data-act="leave">${this.L('leave')}</button>`;
  }

  private patchBanner(s: GuestSnapshot): void {
    const banner = $('#banner', this.root);
    if (!banner) return;
    if (s.e2e) {
      banner.hidden = false;
      banner.textContent = this.L('e2eBanner');
    } else {
      banner.hidden = true;
      banner.textContent = '';
    }
  }

  private patchMembers(s: GuestSnapshot): void {
    const html = s.members.map((m) => {
      const presence = !m.online ? this.L('offline') : m.relayed ? this.L('relayed') : this.L('direct');
      return `<div class="member ${m.online ? '' : 'off'}" title="${esc(presence)}">
        ${identiconSvg(m.avatarSeed, 28, m.online)}
        <span class="nm">${esc(m.isSelf ? (m.name || this.L('you')) : m.name)}</span>
        ${m.role === 'owner' ? `<span class="tag">${this.L('owner')}</span>` : ''}
        ${m.guest ? `<span class="tag guest">${this.L('guest')}</span>` : ''}
      </div>`;
    }).join('') || `<p class="hint">${this.L('alone')}</p>`;
    if (html === this.last.members) return;
    this.last.members = html;
    const el = $('#members', this.root);
    if (el) el.innerHTML = html;
  }

  private patchVoice(s: GuestSnapshot): void {
    const v = s.voice;
    const tiles = v.participants.map((p) => {
      const m = s.members.find((x) => x.memberId === p.memberId);
      return `<div class="vtile ${p.speaking ? 'talk' : ''} ${p.muted ? 'muted' : ''}">
        ${identiconSvg(m?.avatarSeed || p.memberId, 36, true)}
        <span>${esc(m?.name || p.memberId.slice(0, 6))}</span>
      </div>`;
    }).join('');
    const html = `
      <div class="voice-acts">
        <button type="button" class="btn ${v.inVoice ? 'ghost' : ''}" data-act="vjoin">${v.inVoice ? this.L('voiceLeave') : this.L('voiceJoin')}</button>
        ${v.inVoice ? `
          <button type="button" class="ghost" data-act="vmute">${v.muted ? this.L('unmute') : this.L('mute')}</button>
          <button type="button" class="ghost" data-act="vdeaf">${v.deafened ? this.L('undeafen') : this.L('deafen')}</button>
        ` : ''}
      </div>
      ${this.voiceNote ? `<p class="hint error">${esc(this.voiceNote)}</p>` : ''}
      <div class="vtiles">${tiles}</div>`;
    if (html === this.last.voice) return;
    this.last.voice = html;
    const el = $('#voice', this.root);
    if (el) el.innerHTML = html;
  }

  private patchFiles(s: GuestSnapshot): void {
    const files = s.files.filter((f) => f.playable || f.enc);
    const html = files.map((f) => {
      const on = this.watching?.fileId === f.fileId;
      const why = f.enc ? this.L('e2eFile') : (!f.playable ? this.L('cantPlay') : '');
      return `<button type="button" class="file ${on ? 'on' : ''}" data-file="${esc(f.fileId)}" ${f.playable ? '' : 'disabled'}>
        <span class="fn">${esc(f.name)}</span>${why ? `<span class="why">${esc(why)}</span>` : ''}
      </button>`;
    }).join('') || `<p class="hint">${this.L('noFiles')}</p>`;
    if (html === this.last.files) return;
    this.last.files = html;
    const el = $('#files', this.root);
    if (el) el.innerHTML = html;
  }

  private patchPlayer(): void {
    const host = $('#player-host', this.root);
    if (!host) return;
    const names = Object.values(this.watchers).map((w) => w.name).join(', ');
    const watchSig = names + '|' + this.together + '|' + (this.watching?.fileId || '');
    if (!this.watching) {
      if (host.innerHTML) host.innerHTML = '';
      this.last.watchers = '';
      return;
    }
    if (!host.querySelector('#media')) {
      host.innerHTML = `
        <div class="player">
          <video id="media" controls playsinline></video>
          <div class="player-acts">
            <button type="button" class="ghost ${this.together ? 'on' : ''}" data-act="together">${this.together ? this.L('togetherOn') : this.L('togetherOff')}</button>
          </div>
          <div class="watchers" id="watchers"></div>
        </div>`;
      const media = $('#media', this.root) as HTMLMediaElement | null;
      if (media) this.bindMedia(media);
      this.startWatch(this.watching, media);
    } else {
      const btn = host.querySelector('[data-act="together"]');
      if (btn) {
        btn.classList.toggle('on', this.together);
        btn.textContent = this.together ? this.L('togetherOn') : this.L('togetherOff');
      }
    }
    if (watchSig !== this.last.watchers) {
      this.last.watchers = watchSig;
      const el = $('#watchers', this.root);
      if (el) el.textContent = names ? `${this.L('watching')}: ${names}` : '';
    }
  }

  private startWatch(f: GuestFile, media: HTMLMediaElement | null): void {
    if (!media) return;
    if (!webtorrentOk()) {
      const host = $('#player-host', this.root);
      if (host) host.insertAdjacentHTML('beforeend', `<p class="hint error">${esc(this.L('webtorrentFail'))}</p>`);
      return;
    }
    if (this.watch?.fileId === f.fileId) return;
    this.watch?.destroy();
    const loc = this.loc();
    try {
      this.watch = playMagnet(f.magnetURI, f.fileId, f.name, media, loc.trackers);
    } catch {
      this.watch = null;
    }
  }

  private patchChat(s: GuestSnapshot): void {
    const sig = JSON.stringify(s.chat.map((m) => [m.id, s.chatEdits[m.id] || m.text, s.chatReacts[m.id]])) + this.lang;
    if (sig === this.last.chat) return;
    this.last.chat = sig;
    const log = $('#log', this.root);
    if (!log) return;
    const stick = log.scrollHeight - log.scrollTop < log.clientHeight + 80;
    if (!s.chat.length) {
      log.innerHTML = `<p class="hint">${this.L('emptyChat')}</p>`;
      return;
    }
    let lastDay = '';
    let lastAuthor = '';
    let lastAt = 0;
    const parts: string[] = [];
    const selfId = this.room!.identity.memberId;
    for (const m of s.chat) {
      const day = dayLabel(m.at, this.lang);
      if (day !== lastDay) { parts.push(`<div class="day">${esc(day)}</div>`); lastDay = day; lastAuthor = ''; }
      const text = s.chatEdits[m.id] || m.text;
      const group = m.memberId === lastAuthor && m.at - lastAt < 5 * 60_000;
      lastAuthor = m.memberId;
      lastAt = m.at;
      const reacts = s.chatReacts[m.id] || {};
      const pills = Object.entries(reacts).filter(([, ids]) => ids.length).map(([em, ids]) =>
        `<button type="button" class="pill ${ids.includes(selfId) ? 'mine' : ''}" data-react="${esc(m.id)}" data-emoji="${em}">${em} ${ids.length}</button>`
      ).join('');
      parts.push(`<article class="msg ${group ? 'grp' : ''} ${m.memberId === selfId ? 'self' : ''}" data-id="${esc(m.id)}">
        ${group ? '' : identiconSvg(m.avatarSeed, 26)}
        <div class="bubble">
          ${group ? '' : `<header><b>${esc(m.name)}</b><time>${esc(timeLabel(m.at))}</time></header>`}
          ${m.replyTo ? `<div class="quote">${esc(m.replyName || '')}: ${esc((m.replyText || '').slice(0, 80))}</div>` : ''}
          <div class="body">${renderBody(text, this.lang)}</div>
          <div class="acts">
            <button type="button" class="reply" data-reply="${esc(m.id)}">${this.L('reply')}</button>
            ${CHAT_REACT_EMOJIS.map((e) => `<button type="button" class="re" data-react="${esc(m.id)}" data-emoji="${e}">${e}</button>`).join('')}
          </div>
          ${pills ? `<div class="pills">${pills}</div>` : ''}
        </div>
      </article>`);
    }
    log.innerHTML = parts.join('');
    if (stick) log.scrollTop = log.scrollHeight;
  }

  private patchTyping(s: GuestSnapshot): void {
    const names = s.typingIds.map((id) => s.members.find((m) => m.memberId === id)?.name || '').filter(Boolean).join(', ');
    const html = names ? `${esc(names)} ${this.L('typing')}` : '';
    if (html === this.last.typing) return;
    this.last.typing = html;
    const el = $('#typing', this.root);
    if (el) el.innerHTML = html;
  }

  private patchReply(s: GuestSnapshot): void {
    const el = $('#reply', this.root);
    if (!el) return;
    if (!this.replyTo) {
      if (this.last.reply) { el.hidden = true; el.innerHTML = ''; this.last.reply = ''; }
      return;
    }
    const c = s.chat.find((m) => m.id === this.replyTo);
    const text = (s.chatEdits[this.replyTo] || c?.text || '').slice(0, 80);
    const html = `${esc(c?.name || '')}: ${esc(text)}<button type="button" data-act="reply-x" aria-label="×">×</button>`;
    if (html === this.last.reply) return;
    this.last.reply = html;
    el.hidden = false;
    el.innerHTML = html;
  }

  private onClick(e: Event): void {
    const t = (e.target as HTMLElement).closest('[data-lang],[data-tab],[data-act],[data-file],[data-reply],[data-react],[data-copy]') as HTMLElement | null;
    if (!t) return;
    if (t.dataset.lang) { this.setLang(t.dataset.lang as GuestLang); return; }
    if (t.dataset.tab) { this.tab = t.dataset.tab as typeof this.tab; this.syncRoom(); return; }
    if (t.dataset.act === 'join') { void this.doJoin(); return; }
    if (t.dataset.act === 'leave') {
      this.shutdown();
      this.room = null;
      this.watching = null;
      if (this.hostTimer) { clearTimeout(this.hostTimer); this.hostTimer = null; }
      this.gate();
      return;
    }
    if (t.dataset.act === 'vjoin') {
      if (!this.room) return;
      if (this.room.voice.inVoice) { this.room.voice.leave(); this.voiceNote = ''; }
      else {
        void this.room.voice.join().then(() => { this.voiceNote = ''; this.queuePaint(); }).catch((err: unknown) => {
          this.voiceNote = err instanceof Error && err.message === 'no-mic' ? this.L('voiceNeedMic') : this.L('voiceFail');
          this.queuePaint();
        });
      }
      return;
    }
    if (t.dataset.act === 'vmute') { this.room?.voice.setMuted(!this.room.voice.muted); return; }
    if (t.dataset.act === 'vdeaf') { this.room?.voice.setDeafened(!this.room.voice.deafened); return; }
    if (t.dataset.act === 'together') { this.together = !this.together; this.last.watchers = ''; this.patchPlayer(); return; }
    if (t.dataset.act === 'reply-x') { this.replyTo = null; if (this.room) this.patchReply(this.room.snapshot()); return; }
    if (t.dataset.file) {
      const f = this.room?.snapshot().files.find((x) => x.fileId === t.dataset.file);
      if (f?.playable) this.openFile(f);
      return;
    }
    if (t.dataset.reply) { this.replyTo = t.dataset.reply; if (this.room) this.patchReply(this.room.snapshot()); return; }
    if (t.dataset.react && t.dataset.emoji) { void this.room?.toggleReact(t.dataset.react, t.dataset.emoji); return; }
    if (t.dataset.copy) {
      void navigator.clipboard.writeText(t.dataset.copy).then(() => {
        t.textContent = this.L('copied');
        setTimeout(() => { t.textContent = this.L('copy'); }, 1200);
      }).catch(() => { /* ignore */ });
    }
  }

  private onSubmit(e: Event): void {
    const form = e.target as HTMLElement;
    if (form.id !== 'composer') return;
    e.preventDefault();
    const box = $('#box', this.root) as HTMLTextAreaElement | null;
    const text = box?.value || '';
    if (!text.trim()) return;
    void this.room?.sendChat(text, this.replyTo || undefined);
    this.replyTo = null;
    if (box) box.value = '';
    if (this.room) this.patchReply(this.room.snapshot());
  }

  private onInput(e: Event): void {
    if ((e.target as HTMLElement).id === 'box') this.room?.sendTyping();
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).id === 'invite' && e.key === 'Enter') { void this.doJoin(); return; }
    if ((e.target as HTMLElement).id === 'box' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ($('#composer', this.root) as HTMLFormElement | null)?.requestSubmit();
    }
  }

  private bindMedia(media: HTMLMediaElement): void {
    const send = (action: string) => {
      if (!this.together || this.applyingRemote || !this.watching || !this.room) return;
      void this.room.sendSync({
        fileId: this.watching.fileId, action, position: media.currentTime,
        rate: media.playbackRate, at: Date.now(), playing: !media.paused, together: true,
      });
    };
    media.addEventListener('play', () => send('play'));
    media.addEventListener('pause', () => send('pause'));
    media.addEventListener('seeked', () => send('seek'));
    media.addEventListener('ratechange', () => send('rate'));
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.beatTimer = setInterval(() => {
      if (!this.watching || !this.room) return;
      void this.room.sendSync({
        fileId: this.watching.fileId, action: 'beat',
        position: media.currentTime, rate: media.playbackRate,
        at: Date.now(), playing: !media.paused, together: this.together,
      });
    }, 5000);
    void this.room?.sendSync({
      fileId: this.watching!.fileId, action: 'join',
      position: 0, rate: 1, at: Date.now(), playing: false, together: this.together,
    });
  }

  private openFile(f: GuestFile): void {
    if (this.watching?.fileId === f.fileId) { this.tab = 'watch'; this.syncRoom(); return; }
    if (this.watching && this.room) {
      void this.room.sendSync({
        fileId: this.watching.fileId, action: 'leave',
        position: 0, rate: 1, at: Date.now(), playing: false, together: this.together,
      });
    }
    this.watch?.destroy();
    this.watch = null;
    this.watching = f;
    this.tab = 'watch';
    const host = $('#player-host', this.root);
    if (host) host.innerHTML = '';
    this.last.files = '';
    this.last.watchers = '';
    this.syncRoom();
  }

  private onSync(ev: SyncEvent): void {
    if (ev.action === 'leave') {
      delete this.watchers[ev.memberId];
      this.last.watchers = '';
      this.queuePaint();
      return;
    }
    this.watchers[ev.memberId] = { name: ev.name, avatarSeed: ev.avatarSeed, at: Date.now() };
    if (ev.action === 'react') { this.queuePaint(); return; }
    const media = $('#media', this.root) as HTMLMediaElement | null;
    if (!media || !this.together || ev.memberId === this.room?.identity.memberId) {
      if (ev.action === 'join' || ev.action === 'beat') this.queuePaint();
      return;
    }
    if (this.watching && ev.fileId !== this.watching.fileId) {
      const f = this.room?.snapshot().files.find((x) => x.fileId === ev.fileId && x.playable);
      if (f && ev.action === 'track') this.openFile(f);
      return;
    }
    if ((ev.action === 'beat' || ev.action === 'join') && ev.together && ev.playing) {
      const ahead = ev.position + Math.max(0, (Date.now() - ev.at) / 1000);
      const joiner = media.paused && media.currentTime < 5;
      if (ahead - media.currentTime > 1.8 && (!media.paused || joiner)) {
        this.applyingRemote = true;
        try { media.currentTime = ahead; if (media.paused) void media.play().catch(() => {}); }
        finally { setTimeout(() => { this.applyingRemote = false; }, 250); }
      }
      this.queuePaint();
      return;
    }
    if (ev.action !== 'play' && ev.action !== 'pause' && ev.action !== 'seek' && ev.action !== 'rate') {
      this.queuePaint();
      return;
    }
    this.applyingRemote = true;
    const expected = ev.position + (ev.action === 'play' ? Math.max(0, (Date.now() - ev.at) / 1000) : 0);
    try {
      if (Number.isFinite(ev.rate) && ev.rate > 0) media.playbackRate = ev.rate;
      media.currentTime = expected;
      if (ev.action === 'play') void media.play().catch(() => {});
      if (ev.action === 'pause') media.pause();
    } finally {
      setTimeout(() => { this.applyingRemote = false; }, 250); }
    this.queuePaint();
  }
}
