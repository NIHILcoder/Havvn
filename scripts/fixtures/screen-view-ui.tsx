// Real ScreenView + real local WebRTC, rendering a generated canvas only.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ScreenView } from '../../renderer/components/ScreenShare';
import { I18nProvider } from '../../renderer/utils/i18nContext';
import '../../renderer/index.css';
localStorage.setItem('language', 'ru');
document.documentElement.dataset.theme = 'dark';
const extra = document.createElement('style');
extra.textContent = 'html,body,#root{height:100%;margin:0}#fixture-home{height:100%;display:flex;flex-direction:column;padding:16px;box-sizing:border-box}#fixture-home[hidden]{display:none}*{animation:none!important;transition:none!important}';
document.head.append(extra);
const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
const ctx = canvas.getContext('2d')!;
let frame = 0;
setInterval(() => {
  frame++; ctx.fillStyle = '#101217'; ctx.fillRect(0, 0, 960, 540);
  ctx.fillStyle = '#ff681e'; ctx.fillRect(36, 36, 8, 468);
  ctx.fillStyle = '#eeeeef'; ctx.font = 'bold 32px sans-serif'; ctx.fillText('HAVVN · SCREEN SHARE', 72, 106);
  ctx.font = '20px sans-serif'; ctx.fillStyle = '#a4a9b3'; ctx.fillText('Live synthetic video — no screen or microphone access', 72, 148);
  for (let i = 0; i < 4; i++) { ctx.fillStyle = ['#ff681e', '#9ca36b', '#4d83b8', '#786bb4'][i]; ctx.fillRect(72 + i * 205, 215, 180, 155); }
  ctx.fillStyle = '#eeeeef'; ctx.fillText(`Frame ${frame}`, 72, 450);
  ctx.fillStyle = '#ff681e'; ctx.fillRect(72, 482, frame % 790, 4);
}, 50);
const stream = canvas.captureStream(20), listeners = new Set<(value: any) => void>();
const peers = new Map<string, { pc: RTCPeerConnection; ice: RTCIceCandidateInit[] }>();
const fixture: any = { starts: 0, stops: 0, closed: 0, detached: false, settings: { height: 1080, fps: 30, bitrateKbps: 0 },
  playback: [], configured: [], failConfigure: false, holdConfigure: false, child: null, originalVideo: null };
Object.assign(window, { fixture });
const nativeOpen = window.open.bind(window);
window.open = (...args) => { fixture.child = nativeOpen(...args); return fixture.child; };
const emit = (memberId: string, kind: string, data?: unknown) => listeners.forEach(fn => fn({ roomId: 'room', memberId, kind, data }));
Object.assign(window, { api: {
  win: { popoutIsMaximized: async () => false, onPopoutMaximizeChange: () => () => {},
    popoutMinimize: () => { fixture.minimized = true; }, popoutToggleMaximize: () => { fixture.maximized = true; } },
  onRoomScreenSignal: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); },
  rooms: { screen: {
    watchStart: async (_room: string, memberId: string) => {
      fixture.starts++;
      if (fixture.holdWatch) await new Promise<void>(resolve => { fixture.finishWatch = resolve; });
      const pc = new RTCPeerConnection({ iceServers: [] }), record = { pc, ice: [] as RTCIceCandidateInit[] };
      peers.set(memberId, record); pc.addTrack(stream.getVideoTracks()[0], stream);
      pc.onicecandidate = event => { if (event.candidate) emit(memberId, 'ice', event.candidate.toJSON()); };
      await pc.setLocalDescription(); emit(memberId, 'offer', { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp });
      return { ok: true };
    },
    watchStop: async (_room: string, memberId: string) => { fixture.stops++; peers.get(memberId)?.pc.close(); peers.delete(memberId); return { ok: true }; },
    signal: async (_room: string, memberId: string, kind: string, data: any) => {
      const record = peers.get(memberId); if (!record) return { ok: false };
      if (kind === 'answer') { await record.pc.setRemoteDescription(data); for (const ice of record.ice.splice(0)) await record.pc.addIceCandidate(ice); }
      else if (record.pc.remoteDescription) await record.pc.addIceCandidate(data); else record.ice.push(data);
      return { ok: true };
    },
    configure: async (_room: string, settings: any) => {
      fixture.configured.push(settings);
      if (fixture.holdConfigure) await new Promise<void>(resolve => { fixture.finishConfigure = resolve; });
      if (fixture.failConfigure) throw new Error('Synthetic unsupported capture constraints');
      await stream.getVideoTracks()[0].applyConstraints({ frameRate: { max: settings.fps } });
      fixture.settings = settings; return { ok: true };
    },
    playback: async (_room: string, memberId: string, volume: number, muted: boolean) => { fixture.playback.push({ memberId, volume, muted }); return { ok: true }; },
    shareStop: async () => { fixture.sharingStopped = true; emit('self', 'end'); return { ok: true }; },
  } },
} });
const root = createRoot(document.querySelector('#root')!);
function Harness({ self }: { self: boolean }) {
  const [detached, setDetached] = useState(false);
  return <><div id="fixture-home" hidden={detached}>
    <ScreenView roomId="room" memberId={self ? 'self' : 'remote'} title={self ? 'Вы' : 'Участник'} isSelf={self}
      settings={fixture.settings} onClose={() => { fixture.closed++; root.render(null); }}
      onDetachedChange={value => { fixture.detached = value; setDetached(value); }} />
  </div>{detached && <p id="files-ready">Общие файлы доступны, пока демонстрация открыта отдельно.</p>}</>;
}
fixture.mount = (self = true) => flushSync(() => root.render(<I18nProvider><Harness self={self} /></I18nProvider>));
