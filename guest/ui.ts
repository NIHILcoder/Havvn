import { watchReadiness, type WatchReadiness } from '../shared/room-watch-host';
/**
 * Guest page UI — Blaze HUD, three regions (People+Voice | Stage | Chat).
 * The room shell is mounted once; subsequent gossip only patches dirty panes
 * so a VAD tick cannot remount the video or wipe the composer.
 */

import { RoomPlaybackController, watchQueueDriver, observeWatchPlayback } from '../shared/room-playback';
import { classifyMediaKind } from '../shared/media';
import { GuestRoom, type GuestSnapshot, type GuestFile, type SyncEvent } from './mesh';
import { identiconSvg, makeAvatarSeed, randomAvatarBase } from './identicon';
import { t, detectLang, persistLang, type GuestLang, type GuestKey } from './i18n';
import { parseGuestLocation, PUBLIC_STUN_SERVERS } from '../shared/room-guest-url';
import { generateIdentityWeb, type GuestIdentity } from '../shared/room-web-crypto';
import { parseChatSegments, splitLinks, isCopyworthy } from '../shared/chat-format';
import { CHAT_REACT_EMOJIS } from '../shared/reactions';
import { roomChatPage } from '../shared/room-chat-history';
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
  private readiness: WatchReadiness = 'buffering';
  private hostStamp = '';
  private requests: Array<SyncEvent & { receivedAt: number }> = [];
  private playback = new RoomPlaybackController();
  private mediaCleanup: (() => void) | null = null;
  private watchSession = false;
  private watchResume: { position: number; rate: number; playing: boolean } | undefined;
  private replyTo: string | null = null;
  private historyAnchor: string | undefined;
  private tab: 'people' | 'watch' | 'chat' = 'chat';
  private watchers: Record<string, { name: string; avatarSeed: string; at: number; together: boolean; readiness?: WatchReadiness }> = {};
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
      const media = $('#media', this.root) as HTMLMediaElement | null;
      if (media && this.watching) this.watchResume = { position: media.currentTime, rate: this.playback.rate, playing: !media.paused };
      this.stopMedia();
      this.view = null;
      this.mountRoom(this.room.snapshot());
      this.syncRoom();
    } else if (this.view === 'kicked') this.kicked();
    else this.gate();
  }

  private stopMedia(): void {
    this.mediaCleanup?.(); this.mediaCleanup = null;
    if (this.beatTimer) clearInterval(this.beatTimer); this.beatTimer = null;
    const media = $('#media', this.root) as HTMLMediaElement | null;
    if (media) { media.pause(); media.removeAttribute('src'); media.load(); }
    this.watch?.destroy(); this.watch = null;
  }

  private endWatching(): void {
    if (this.watchSession && this.watching && this.room) void this.room.sendSync({ ...this.playback.snapshot('leave'), fileId: this.watching.fileId });
    this.watchSession = false; this.stopMedia(); this.playback.dispose();
    this.watching = null; this.watchers = {}; this.requests = []; this.hostStamp = ''; this.watchResume = undefined;
  }

  private shutdown(): void {
    this.endWatching();
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
          <p class="hint">${this.L('browserCapabilities')}</p>
          <p class="hint">${this.L('inviteTrust')}</p>
          <p class="hint">${this.L('inviteAccess')}</p>
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
      this.historyAnchor = undefined;
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
      this.endWatching();
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
      const version = m.protocolVersion ? this.L('protocolVersion', { n: m.protocolVersion }) : this.L('protocolLegacy');
      const presence = !m.online ? this.L('offline') : m.relayed ? this.L('relayed') : this.L('direct');
      return `<div class="member ${m.online ? '' : 'off'}" title="${esc(presence + ' · ' + version)}">
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
        ${p.waitingForSlot ? '<small>'+this.L('voiceWaitingForSlot')+'</small>' : p.connection === 'connecting' || p.connection === 'reconnecting' && !p.reconnectAttempts ? '<small>'+this.L('connecting')+'</small>' : p.connection === 'reconnecting' ? '<small>'+this.L('voiceRetryAttempt', { n: p.reconnectAttempts ?? 0 })+'</small>' : p.connection === 'failed' ? '<small>'+this.L('voiceLinkLost')+'</small>' : ''}
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
      ${v.inVoice && v.participants.some(p => p.memberId === this.room?.identity.memberId && p.waitingForSlot) ? `<p class="hint" role="status">${this.L('voiceWaitingForSlot')}</p>` : ''}
      ${v.inVoice && (v.micUnavailable || v.participants.some(p => p.connection === 'failed')) ? `<p class="hint error" role="status">${this.L(v.micUnavailable ? 'micUnavailable' : 'voiceLinkFailed')}</p><button type="button" class="ghost" data-act="vretry">${this.L('voiceRetry')}</button>` : ''}
      ${this.voiceNote ? `<p class="hint error">${esc(this.voiceNote)}</p>` : ''}
      ${s.members.some(m => !m.isSelf && m.online && !m.capabilities?.includes('voice-state-v2')) ? `<p class="hint">${this.L('voiceLegacy')}</p>` : ''}
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
    const policy = this.room?.snapshot().watchPolicy;
    const hostId = policy?.hostId || '';
    const stamp = `${policy?.by || ''}:${policy?.at || 0}:${policy?.ownerAt || 0}`;
    if (stamp !== this.hostStamp) { this.hostStamp = stamp; this.requests = this.requests.filter(r => r.policyBy === policy?.by && r.policyAt === policy?.at && r.policyOwnerAt === policy?.ownerAt); }
    this.playback.setHost(hostId, this.room?.identity.memberId || '', stamp);
    const self = this.room?.identity.memberId || '';
    const names = [this.room?.name || this.L('you'), ...Object.values(this.watchers).map(w => `${w.name} · ${this.L(!w.together ? 'watchLocal' : w.readiness === 'ready' ? 'watchReady' : w.readiness === 'error' ? 'watchMediaError' : w.readiness === 'buffering' ? 'watchBuffering' : 'watchUnknown')}`)].join(', ');
    const legacy = this.room?.snapshot().members.some(m => m.online && !m.isSelf && m.watchSync !== true);
    const watchSig = stamp + JSON.stringify(this.requests) + this.readiness + String(legacy) + names + '|' + this.together + '|' + (this.watching?.fileId || '');
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
          <p class="hint" id="watch-host" role="status"></p>
          <div id="watch-requests" class="watch-requests"></div>
          <p class="hint" id="watch-compat" role="status" hidden></p>
          <p class="hint" id="watch-phase" role="status" hidden></p>
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
      if (el) el.textContent = `${this.L('watching')}: ${names} · ${this.L(!this.together ? 'watchLocal' : this.readiness === 'ready' ? 'watchReady' : this.readiness === 'error' ? 'watchMediaError' : 'watchBuffering')}`;
      const hostStatus = $('#watch-host', this.root);
      if (hostStatus) hostStatus.textContent = !hostId ? this.L('watchShared') : hostId === self ? this.L('watchYouLead') : !this.watchers[hostId]?.together ? this.L('watchHostAbsent') : `${this.L('watchHost')}: ${this.watchers[hostId].name}. ${this.L('watchFollowHint')}`;
      const requestList = $('#watch-requests', this.root);
      if (requestList) requestList.innerHTML = hostId === self ? this.requests.map(r => `<div class="watch-request"><span>${esc(r.name)}: ${esc(this.L(r.requested === 'play' ? 'watchRequestPlay' : r.requested === 'pause' ? 'watchRequestPause' : r.requested === 'seek' ? 'watchRequestSeek' : r.requested === 'rate' ? 'watchRequestRate' : 'watchRequestTrack'))} ${r.requested === 'track' ? esc(this.room?.snapshot().files.find(f => f.fileId === r.fileId)?.name || '?') : r.requested === 'seek' ? Math.floor(r.position) + 's' : r.requested === 'rate' ? r.rate + '×' : ''}</span><button type="button" class="ghost" data-act="watch-accept" data-who="${esc(r.memberId)}" ${this.together ? '' : 'disabled'}>${this.L('watchAccept')}</button><button type="button" class="ghost" data-act="watch-dismiss" data-who="${esc(r.memberId)}">${this.L('watchDismiss')}</button></div>`).join('') : '';
      const compat = $('#watch-compat', this.root);
      if (compat) { const unsupported = !!hostId && this.room?.snapshot().members.some(m => m.online && !m.isSelf && !m.capabilities?.includes('watch-host-v1')); compat.hidden = !legacy && !unsupported; compat.textContent = this.L(unsupported ? 'watchHostLegacy' : 'watchLegacy'); }
    }
  }

  private reportReadiness(ready: WatchReadiness): void {
    if (ready === this.readiness) return;
    this.readiness = ready;
    if (this.watching) void this.room?.sendSync({ ...this.playback.snapshot('beat'), readiness: ready });
    this.last.watchers = ''; this.queuePaint();
  }

  private startWatch(f: GuestFile, media: HTMLMediaElement | null): void {
    if (!media) return;
    if (!webtorrentOk()) {
      this.reportReadiness('error');
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
      this.watch = null; this.reportReadiness('error');
    }
  }

  private patchChat(s: GuestSnapshot): void {
    const sig = JSON.stringify(s.chat.map((m) => [m.id, s.chatEdits[m.id] || m.text, s.chatReacts[m.id], m.replyTo, m.replyName, m.replyText, m.chatV])) + this.lang + this.historyAnchor;
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
    const index = this.historyAnchor ? s.chat.findIndex(m => m.id === this.historyAnchor) : -1;
    const shown = this.historyAnchor ? s.chat.slice(Math.max(0, index)) : roomChatPage(s.chat).messages;
    if (shown.length < s.chat.length) parts.push(`<button type="button" class="ghost history-earlier" data-act="earlier">${esc(this.L('showEarlier'))}</button>`);
    else parts.push(`<p class="hint history-window">${esc(this.L('historyWindow'))}</p>`);
    for (const m of shown) {
      const day = dayLabel(m.at, this.lang);
      if (day !== lastDay) { parts.push(`<div class="day">${esc(day)}</div>`); lastDay = day; lastAuthor = ''; }
      const text = s.chatEdits[m.id] || m.text;
      const group = m.memberId === lastAuthor && m.at >= lastAt && m.at - lastAt < 5 * 60_000;
      lastAuthor = m.memberId;
      lastAt = m.at;
      const reacts = s.chatReacts[m.id] || {};
      const pills = Object.entries(reacts).filter(([, ids]) => ids.length).map(([em, ids]) =>
        `<button type="button" class="pill ${ids.includes(selfId) ? 'mine' : ''}" data-react="${esc(m.id)}" data-emoji="${em}">${em} ${ids.length}</button>`
      ).join('');
      const parent = s.chat.find(p => p.id === m.replyTo);
      const quoteName = parent?.name || m.replyName || '';
      const quoteText = parent ? (s.chatEdits[parent.id] ?? parent.text) : (m.replyText || '');
      parts.push(`<article class="msg ${group ? 'grp' : ''} ${m.memberId === selfId ? 'self' : ''}" data-id="${esc(m.id)}">
        ${group ? '' : identiconSvg(m.avatarSeed, 26)}
        <div class="bubble">
          ${group ? '' : `<header><b>${esc(m.name)}</b><time>${esc(timeLabel(m.at))}</time></header>`}
          ${m.replyTo ? `<div class="quote">${esc(quoteName)}: ${esc(quoteText.slice(0, 80))}${m.chatV !== 2 ? `<small class="quote-legacy" title="${esc(this.L('legacyQuoteHint'))}">${esc(this.L('legacyQuote'))}</small>` : ''}</div>` : ''}
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
    const html = `<span class="reply-q">${esc(c?.name || '')}: ${esc(text)}</span><button type="button" data-act="reply-x" aria-label="×">×</button>`;
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
    if (t.dataset.act === 'vretry') { this.room?.voice.reconnect(); return; }
    if (t.dataset.act === 'vmute') { this.room?.voice.setMuted(!this.room.voice.muted); return; }
    if (t.dataset.act === 'vdeaf') { this.room?.voice.setDeafened(!this.room.voice.deafened); return; }
    if (t.dataset.act === 'watch-accept' || t.dataset.act === 'watch-dismiss') {
      const request = this.requests.find(r => r.memberId === t.dataset.who);
      const policy = this.room?.snapshot().watchPolicy;
      if (request && t.dataset.act === 'watch-accept' && this.together && policy?.hostId === this.room?.identity.memberId && request.policyBy === policy?.by && request.policyAt === policy?.at && request.policyOwnerAt === policy?.ownerAt && Date.now() - request.receivedAt < 20_000) {
        if (request.requested === 'track') { const f = this.room?.snapshot().files.find(x => x.fileId === request.fileId && x.playable); if (f) this.openFile(f); }
        else if (request.fileId === this.watching?.fileId && request.requested) this.playback.execute({ ...request, action: request.requested });
      }
      this.requests = this.requests.filter(r => r !== request); this.last.watchers = ''; this.patchPlayer(); return;
    }
    if (t.dataset.act === 'together') { this.together = !this.together; this.playback.setTogether(this.together); if (this.watching) void this.room?.sendSync({ ...this.playback.snapshot('beat'), readiness: this.readiness }); this.last.watchers = ''; this.patchPlayer(); return; }
    if (t.dataset.act === 'reply-x') { this.replyTo = null; if (this.room) this.patchReply(this.room.snapshot()); return; }
    if (t.dataset.act === 'earlier' && this.room) {
      const snapshot = this.room.snapshot(), log = $('#log', this.root);
      const index = this.historyAnchor ? snapshot.chat.findIndex(m => m.id === this.historyAnchor) : -1;
      const shown = this.historyAnchor ? snapshot.chat.slice(Math.max(0, index)) : roomChatPage(snapshot.chat).messages;
      const page = roomChatPage(snapshot.chat, shown[0]?.id);
      if (!page.messages.length) return;
      const height = log?.scrollHeight || 0, top = log?.scrollTop || 0;
      this.historyAnchor = page.messages[0].id;
      this.patchChat(snapshot);
      if (log) log.scrollTop = top + log.scrollHeight - height;
      return;
    }
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
    if (!this.watching) return;
    this.playback.setTogether(this.together);
    this.playback.beginSource(this.watching.fileId, this.watchResume); this.watchResume = undefined;
    this.readiness = 'buffering';
    const detach = this.playback.attach(media, input => { void this.room?.sendSync({ ...input, readiness: this.readiness }); });
    const stopStatus = observeWatchPlayback(media, phase => {
      this.reportReadiness(watchReadiness(phase));
      const status = $('#watch-phase', this.root);
      if (status) {
        status.hidden = phase === 'playing' || phase === 'ended';
        status.textContent = this.L(phase === 'paused' ? 'watchPaused' : phase === 'seeking' ? 'watchSeeking'
          : phase === 'decodeError' || phase === 'networkError' ? 'watchMediaError' : 'watchBuffering');
      }
    });
    const ended = () => {
      if (!this.watching || !this.room || this.playback.applying || classifyMediaKind(this.watching.name) !== 'audio') return;
      const viewers = Object.entries(this.watchers).map(([memberId, w]) => ({ memberId, together: w.together, lastSeen: w.at }));
      const host = this.room.snapshot().watchPolicy?.hostId;
      if (this.together && host && host !== this.room.identity.memberId) return;
      if (this.together && !host && watchQueueDriver(this.room.identity.memberId, viewers) !== this.room.identity.memberId) return;
      const queue = this.room.snapshot().files.filter(f => f.playable && classifyMediaKind(f.name) === 'audio');
      const index = queue.findIndex(f => f.fileId === this.watching?.fileId);
      if (index >= 0 && queue[index + 1]) this.openFile(queue[index + 1]);
    };
    media.addEventListener('ended', ended);
    this.mediaCleanup = () => { detach(); stopStatus(); media.removeEventListener('ended', ended); };
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.beatTimer = setInterval(() => {
      if (!this.watching || !this.room) return;
      for (const [id, watcher] of Object.entries(this.watchers)) {
        if (Date.now() - watcher.at > 16_000) { delete this.watchers[id]; this.last.watchers = ''; this.queuePaint(); }
      }
      this.requests = this.requests.filter(r => Date.now() - r.receivedAt < 20_000); this.last.watchers = ''; this.queuePaint();
      void this.room.sendSync({ ...this.playback.snapshot('beat'), readiness: this.readiness });
    }, 5000);
    if (!this.watchSession) {
      this.watchSession = true;
      void this.room?.sendSync({ ...this.playback.snapshot('join'), readiness: this.readiness });
    }
  }

  private openFile(f: GuestFile, announce = true): void {
    if (announce && this.watching && this.playback.followingHost) {
      void this.room?.sendSync({ fileId: f.fileId, action: 'request', requested: 'track', position: 0, rate: this.playback.rate, together: true, readiness: this.readiness }); return;
    }
    if (this.watching?.fileId === f.fileId) { this.tab = 'watch'; this.syncRoom(); return; }
    if (announce && this.watching && this.together) void this.room?.sendSync({
      fileId: f.fileId, action: 'track', position: 0, rate: this.playback.rate, playing: true, together: true,
    });
    this.stopMedia();
    if (announce) this.playback.chooseSource(f.fileId);
    this.watching = f; this.watchResume = undefined;
    this.watchers = {}; this.tab = 'watch';
    const host = $('#player-host', this.root);
    if (host) host.innerHTML = '';
    this.last.files = ''; this.last.watchers = '';
    this.syncRoom();
  }

  private onSync(ev: SyncEvent): void {
    if (!this.watching || ev.memberId === this.room?.identity.memberId) return;
    if (ev.action === 'request') {
      if (this.room?.snapshot().watchPolicy?.hostId === this.room?.identity.memberId && this.together) this.requests = [...this.requests.filter(r => r.memberId !== ev.memberId && Date.now() - r.receivedAt < 20_000).slice(-7), { ...ev, receivedAt: Date.now() }];
      this.last.watchers = ''; this.queuePaint(); return;
    }
    if (ev.action === 'track' || this.room?.snapshot().watchPolicy?.hostId === ev.memberId && ev.fileId !== this.watching.fileId && ['beat', 'join', 'state'].includes(ev.action)) {
      const f = this.room?.snapshot().files.find(x => x.fileId === ev.fileId && x.playable);
      if (f && this.playback.receive(ev)) { this.openFile(f, false); this.watchers[ev.memberId] = { name: ev.name, avatarSeed: ev.avatarSeed || ev.memberId, at: Date.now(), together: ev.together, readiness: ev.v === 3 ? ev.readiness : undefined }; }
      return;
    }
    if (ev.fileId !== this.watching.fileId) {
      delete this.watchers[ev.memberId]; this.last.watchers = ''; this.queuePaint(); return;
    }
    if (ev.action === 'leave') delete this.watchers[ev.memberId];
    else this.watchers[ev.memberId] = { name: ev.name, avatarSeed: ev.avatarSeed || ev.memberId, at: Date.now(), together: ev.together, readiness: ev.v === 3 ? ev.readiness : undefined };
    this.playback.receive(ev);
    this.last.watchers = ''; this.queuePaint();
  }
}
