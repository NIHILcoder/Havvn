/**
 * WebTorrent-tracker WebSocket client + trickle:false data-channel peers.
 * Speaks the same announce/offer/answer JSON as bittorrent-tracker v9 so a
 * browser guest pairs with the desktop room-engine.
 */

import { hexToBinary, binaryToHex, randomHex } from '../shared/room-web-crypto';

export interface MeshWire {
  readonly connected: boolean;
  send(data: string): void;
  destroy(): void;
}

type DataFn = (data: string) => void;
type CloseFn = () => void;

export class DataWire implements MeshWire {
  connected = false;
  private channel: RTCDataChannel | null = null;
  private dataFn: DataFn | null = null;
  private closeFn: CloseFn | null = null;
  private closed = false;

  constructor(readonly pc: RTCPeerConnection) {
    this.pc.onconnectionstatechange = () => {
      if (this.closed) return;
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed') this.destroy();
    };
  }

  attachChannel(ch: RTCDataChannel): void {
    this.channel = ch;
    ch.binaryType = 'arraybuffer';
    ch.onopen = () => { this.connected = true; };
    ch.onclose = () => this.destroy();
    ch.onmessage = (e) => {
      if (!this.dataFn) return;
      if (typeof e.data === 'string') this.dataFn(e.data);
      else this.dataFn(new TextDecoder().decode(e.data as ArrayBuffer));
    };
  }

  onData(fn: DataFn): void { this.dataFn = fn; }
  onClose(fn: CloseFn): void { this.closeFn = fn; }

  send(data: string): void {
    if (!this.channel || this.channel.readyState !== 'open') return;
    try { this.channel.send(data); } catch { /* ignore */ }
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    try { this.channel?.close(); } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
    this.closeFn?.();
  }
}

async function waitGathering(pc: RTCPeerConnection, ms = 4000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); }
    };
  });
}

function sdpOf(pc: RTCPeerConnection): { type: string; sdp: string } {
  const d = pc.localDescription;
  return { type: d?.type || 'offer', sdp: d?.sdp || '' };
}

export interface RendezvousOpts {
  infoHashHex: string;
  peerIdHex: string;
  announce: string[];
  iceServers: RTCIceServer[];
  onPeer: (wire: DataWire) => void;
}

export function startRendezvous(opts: RendezvousOpts): { stop: () => void } {
  const infoBin = hexToBinary(opts.infoHashHex);
  const peerBin = hexToBinary(opts.peerIdHex);
  const sockets: WebSocket[] = [];
  const pending = new Map<string, DataWire>();
  let stopped = false;
  const timers: ReturnType<typeof setInterval>[] = [];

  const makeInitiator = async (): Promise<{ offer: { type: string; sdp: string }; id: string; wire: DataWire }> => {
    const pc = new RTCPeerConnection({ iceServers: opts.iceServers });
    const wire = new DataWire(pc);
    const ch = pc.createDataChannel('data');
    wire.attachChannel(ch);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitGathering(pc);
    return { offer: sdpOf(pc), id: randomHex(20), wire };
  };

  const answerOffer = async (offer: { type: string; sdp: string }): Promise<{ answer: { type: string; sdp: string }; wire: DataWire }> => {
    const pc = new RTCPeerConnection({ iceServers: opts.iceServers });
    const wire = new DataWire(pc);
    pc.ondatachannel = (e) => wire.attachChannel(e.channel);
    await pc.setRemoteDescription(offer as RTCSessionDescriptionInit);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitGathering(pc);
    return { answer: sdpOf(pc), wire };
  };

  const send = (ws: WebSocket, obj: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
    }
  };

  const announce = async (ws: WebSocket) => {
    if (stopped || ws.readyState !== WebSocket.OPEN) return;
    const offers: Array<{ offer: { type: string; sdp: string }; offer_id: string }> = [];
    for (let i = 0; i < 5; i++) {
      try {
        const o = await makeInitiator();
        pending.set(o.id, o.wire);
        setTimeout(() => {
          if (pending.delete(o.id)) o.wire.destroy();
        }, 50_000);
        offers.push({ offer: o.offer, offer_id: hexToBinary(o.id) });
      } catch { /* ICE failed — skip this offer slot */ }
    }
    send(ws, {
      action: 'announce',
      info_hash: infoBin,
      peer_id: peerBin,
      numwant: offers.length,
      offers,
    });
  };

  const onMessage = async (ws: WebSocket, raw: string) => {
    if (stopped) return;
    let data: any;
    try { data = JSON.parse(raw); } catch { return; }
    if (data.action !== 'announce') return;
    if (data.info_hash !== infoBin) return;
    if (data.peer_id && data.peer_id === peerBin) return;
    if (data.offer && data.peer_id) {
      try {
        const { answer, wire } = await answerOffer(data.offer);
        send(ws, {
          action: 'announce',
          info_hash: infoBin,
          peer_id: peerBin,
          to_peer_id: data.peer_id,
          answer,
          offer_id: data.offer_id,
        });
        opts.onPeer(wire);
      } catch { /* ignore */ }
    }
    if (data.answer && data.offer_id) {
      const id = binaryToHex(data.offer_id);
      const wire = pending.get(id);
      if (wire) {
        pending.delete(id);
        try {
          await wire.pc.setRemoteDescription(data.answer as RTCSessionDescriptionInit);
          opts.onPeer(wire);
        } catch { wire.destroy(); }
      }
    }
  };

  const openOne = (url: string) => {
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { return; }
    sockets.push(ws);
    ws.onopen = () => { void announce(ws); };
    ws.onmessage = (e) => { void onMessage(ws, String(e.data)); };
    ws.onclose = () => {
      if (stopped) return;
      setTimeout(() => { if (!stopped) openOne(url); }, 8000 + Math.random() * 4000);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    timers.push(setInterval(() => { void announce(ws); }, 30_000));
  };

  for (const url of opts.announce) openOne(url);

  return {
    stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      for (const ws of sockets) { try { ws.close(); } catch { /* ignore */ } }
      for (const w of pending.values()) w.destroy();
      pending.clear();
    },
  };
}
