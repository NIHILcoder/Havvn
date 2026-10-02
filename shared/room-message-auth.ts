import { chatCanonical, chatContextCanonical, editCanonical, voiceStateCanonical, voiceStateV2Canonical, voiceSignalCanonical,
  rekeyCanonical, kickedCanonical, renameCanonical, topicCanonical, profileCanonical } from './room-canonicals';
import { banSnapshotCanonical } from './room-bans';
import { keyMetadataCanonical, keyPageCanonical } from './room-keyring';
import { watchCanonical, watchHostCanonical, type WatchMessage } from './room-watch-sync';
import { watchPolicyCanonical, type WatchPolicy } from './room-watch-host';
import type { GossipMessage } from './room-protocol';

export interface GossipProof { memberId: string; pub: string; sig: string; bytes: Uint8Array; chainLink?: boolean }
/** A persisted proof may belong to an earlier key epoch. Clean only the outgoing
 * snapshot; never delete local history or rewrite another author's signature. */
export function currentHelloProofs(m: GossipMessage, topic: string, root: string, verify: (p: GossipProof) => boolean): GossipMessage {
  const valid = (frame: GossipMessage) => gossipProofs(frame, topic, root).every(verify);
  const out = { ...m };
  if (out.files) out.files = out.files.map((f: any) => {
    if (!f.revSig || valid({ t: 'add', file: f })) return f;
    const clean = { ...f };
    delete clean.revBy; delete clean.revAt; delete clean.revPub; delete clean.revSig;
    return clean;
  });
  if (out.tombSigs) out.tombSigs = Object.fromEntries(Object.entries(out.tombSigs)
    .filter(([fileId, p]) => valid({ t: 'hello', tombSigs: { [fileId]: p } })));
  if (out.chatEdits) out.chatEdits = Object.fromEntries(Object.entries(out.chatEdits)
    .filter(([msgId, p]) => valid({ t: 'hello', chatEdits: { [msgId]: p } })));
  if (out.topicMsg && !valid({ t: 'topic', ...out.topicMsg })) delete out.topicMsg;
  if (out.banState && !valid({ t: 'hello', banState: out.banState })) delete out.banState;
  if (out.cfg && !valid({ t: 'hello', cfg: out.cfg })) delete out.cfg;
  if (out.watchPolicy && !valid({ t: 'watch-policy-v1', ...out.watchPolicy })) delete out.watchPolicy;
  return out;
}
/** Called only after validateGossip. Historical canonical field order is preserved. */
export function gossipProofs(m: GossipMessage, topic: string, rootOwnerId: string): GossipProof[] {
  const out: GossipProof[] = [];
  const json = (fields: unknown[]) => new TextEncoder().encode(JSON.stringify(fields));
  const add = (p: any, memberId: string, bytes: Uint8Array, sig = p.sig) => out.push({ memberId, pub: p.pub, sig, bytes });
  const chat = (c: any) => {
    add(c, c.memberId, chatCanonical(topic, c));
    if (c.chatV === 2) add(c, c.memberId, chatContextCanonical(topic, c), c.contextSig);
  };
  const revive = (f: any) => {
    if (f.revSig) add({ pub: f.revPub, sig: f.revSig }, f.revBy, json(['revive', topic, f.fileId, f.revAt, f.revBy]));
  };
  const transfer = (p: any, root: string) => add(p, p.by, json(['th-room-transfer:v1', root, p.by, p.newOwnerId, p.at]));
  switch (m.t) {
    case 'e2e-keys': add(m, m.ownerId, keyPageCanonical(topic, m as any)); break;
    case 'chat': chat(m); break;
    case 'chat-log': m.msgs.forEach(chat); break;
    case 'chat-edit': add(m, m.memberId, editCanonical(topic, m as any)); break;
    case 'sync-v2':
      add(m, m.memberId, watchCanonical(topic, m as unknown as WatchMessage));
      if (m.v === 3) add(m, m.memberId, watchHostCanonical(topic, m as unknown as WatchMessage), m.hostSig);
      break;
    case 'watch-policy-v1': add(m, m.by, watchPolicyCanonical(topic, m as unknown as WatchPolicy)); break;
    case 'del': add(m, m.memberId, json(['del', topic, m.fileId, m.memberId, m.at])); break;
    case 'rekey': add(m, m.by, rekeyCanonical(topic, m as any)); break;
    case 'kicked': add(m, m.by, kickedCanonical(topic, m as any)); break;
    case 'rename': add(m, m.by, renameCanonical(topic, m as any)); break;
    case 'topic': add(m, m.by, topicCanonical(topic, m as any)); break;
    case 'transfer':
      transfer(m, rootOwnerId || m.by);
      if (m.banState) add(m.banState, m.banState.ownerId, banSnapshotCanonical(topic, m.banState));
      break;
    case 'profile': add(m, m.memberId, profileCanonical(topic, m as any)); break;
    case 'voice-state':
      add(m, m.memberId, voiceStateCanonical(topic, m as any));
      if (m.voiceV === 2) add(m, m.memberId, voiceStateV2Canonical(topic, m as any), m.stateSig);
      break;
    case 'voice-signal': add(m, m.memberId, voiceSignalCanonical(topic, m as any)); break;
    case 'voice-share': add(m, m.memberId, json(['voice-share', topic, m.memberId, m.at, m.sharing, m.streamId])); break;
    case 'srv-mirror': add(m, m.hostId, json(['srv-mirror', topic, m.hostId, m.at, m.body])); break;
    case 'srv-cmd': add(m, m.by, json(['srv-cmd', topic, m.by, m.instanceId, m.command, m.at])); break;
    case 'lan-genesis': add(m, m.by, json(['th-lan-genesis:v1', m.sessionId, m.by, m.at])); break;
    case 'lan-admit': case 'lan-evict': add(m, m.by, json([m.t === 'lan-admit' ? 'th-lan-admit:v1' : 'th-lan-evict:v1', m.sessionId, m.by, m.member, m.at])); break;
    case 'lan-state': add(m, m.memberId, json(['th-lan-state:v1', topic, m.memberId, m.sessionId, m.at, m.vip, m.gen])); break;
    case 'lan-signal': add(m, m.memberId, json(['th-lan-signal:v1', topic, m.memberId, m.to, m.kind, m.data])); break;
    case 'lan-reach': add(m, m.memberId, json(['th-lan-reach:v1', topic, m.memberId, m.sessionId, m.at, m.relay, m.reach])); break;
    case 'add': revive(m.file); break;
    case 'hello': case 'ping': {
      for (const f of m.files || []) revive(f);
      for (const [fileId, p] of Object.entries(m.tombSigs || {}) as [string, any][]) {
        add(p, p.by, json(['del', topic, fileId, p.by, p.at]));
      }
      for (const [msgId, p] of Object.entries(m.chatEdits || {}) as [string, any][]) {
        add(p, p.by, editCanonical(topic, { msgId, memberId: p.by, at: p.at, text: p.text }));
      }
      if (m.topicMsg) add(m.topicMsg, m.topicMsg.by, topicCanonical(topic, m.topicMsg));
      const c = m.cfg;
      if (c) {
        add(c, c.ownerId, json(['th-room-e2e:v1', topic, c.ownerId, c.e2e, c.secret]));
        if (c.keys) add(c, c.ownerId, keyMetadataCanonical(topic, c, c.keys), c.keys.sig);
        if (c.prevSig) add(c, c.ownerId, json(['th-room-e2e-prev:v1', topic, c.ownerId, c.prevSecrets]), c.prevSig);
      }
      if (m.banState) add(m.banState, m.banState.ownerId, banSnapshotCanonical(topic, m.banState));
      if (m.watchPolicy) add(m.watchPolicy, m.watchPolicy.by, watchPolicyCanonical(topic, m.watchPolicy));
      const chain = m.transferChain || [];
      for (const p of chain) { transfer(p, chain[0].by); out[out.length - 1].chainLink = true; }
      break;
    }
  }
  return out;
}
