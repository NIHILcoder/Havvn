import type { RoomChatAck, RoomChatDraft } from '../../shared/types';
import { normalizeRoomChatDraft } from '../../shared/room-chat-delivery';

type ComposerApi = {
  chatDraft: (roomId: string) => Promise<RoomChatDraft>;
  saveChatDraft: (roomId: string, draft: RoomChatDraft) => Promise<{ ok: boolean }>;
  sendChat: (roomId: string, text: string, replyTo?: string, id?: string) => Promise<RoomChatAck>;
  editChat: (roomId: string, id: string, text: string) => Promise<{ ok: boolean }>;
};
export type ComposerState = { draft: RoomChatDraft; phase: 'idle' | 'sending' | 'saved' | 'error'; error?: string; ready: boolean };

/** Room-scoped controller: a late send/load can never overwrite another room. */
export class RoomChatComposer {
  private state: ComposerState = { draft: { text: '' }, phase: 'idle', ready: false };
  private listeners = new Set<() => void>();
  private revision = 0;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<unknown> = Promise.resolve();
  private loading: Promise<void>;
  constructor(private roomId: string, private api: ComposerApi, private makeId = () => crypto.randomUUID().replace(/-/g, '')) {
    this.loading = api.chatDraft(roomId).then(draft => {
      if (!this.disposed && !this.revision) this.state = { ...this.state, draft: normalizeRoomChatDraft(draft) };
    }).catch(error => { if (!this.disposed) this.state = { ...this.state, phase: 'error', error: String(error instanceof Error ? error.message : error) }; }).finally(() => {
      if (this.disposed) return;
      this.state = { ...this.state, ready: true }; this.emit();
      if (this.revision && this.state.phase !== 'sending') this.schedule();
    });
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private emit() { for (const fn of this.listeners) fn(); }
  dispose() {
    this.disposed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.state = { draft: { text: '' }, phase: 'idle', ready: true }; this.emit();
  }
  private change(draft: RoomChatDraft) {
    if (this.disposed || this.state.phase === 'sending') return;
    this.revision++;
    this.state = { draft: normalizeRoomChatDraft(draft), phase: 'idle', ready: this.state.ready };
    this.emit(); this.schedule();
  }
  setText(text: string) {
    this.change({ ...this.state.draft, text, messageId: text.trim() === this.state.draft.text.trim() ? this.state.draft.messageId : undefined });
  }
  reply(reply: NonNullable<RoomChatDraft['reply']>) {
    if (!this.state.ready) return;
    const draft = this.state.draft.editId ? this.state.draft.compose ?? { text: '' } : this.state.draft;
    this.change({ ...draft, reply, editId: undefined, compose: undefined, messageId: undefined });
  }
  edit(id: string, text: string) {
    if (!this.state.ready) return;
    const compose = this.state.draft.editId ? this.state.draft.compose : this.state.draft;
    this.change({ text, editId: id, compose });
  }
  cancel() {
    const draft = this.state.draft;
    this.change(draft.editId ? draft.compose ?? { text: '' } : { ...draft, reply: undefined, messageId: undefined });
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (this.state.ready) this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}); }, 300);
  }
  private write(draft: RoomChatDraft) {
    const snapshot = normalizeRoomChatDraft(draft);
    const job = this.writes.catch(() => {}).then(async () => {
      if (this.disposed) throw new Error('Chat composer closed');
      if (!(await this.api.saveChatDraft(this.roomId, snapshot)).ok) throw new Error('Could not save the chat draft');
    });
    this.writes = job;
    return job;
  }
  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.loading;
    if (this.disposed || this.state.phase === 'sending') return; // send owns backup/cleanup ordering
    try { await this.write(this.state.draft); }
    catch (error) {
      if (!this.disposed && this.getSnapshot().phase !== 'sending') { this.state = { ...this.state, phase: 'error', error: String(error instanceof Error ? error.message : error) }; this.emit(); }
      throw error;
    }
  }
  async send() {
    if (this.disposed || this.state.phase === 'sending' || !this.state.draft.text.trim()) return;
    const draft = { ...this.state.draft, messageId: this.state.draft.editId ? undefined : this.state.draft.messageId ?? this.makeId() };
    this.revision++;
    this.state = { ...this.state, draft, phase: 'sending', error: undefined }; this.emit();
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    try {
      await this.loading;
      await this.write(draft); // backup including the stable retry ID before sending
      if (this.disposed) return;
      if (draft.editId) {
        if (!(await this.api.editChat(this.roomId, draft.editId, draft.text.trim())).ok) throw new Error('Chat edit was not accepted');
      } else {
        const ack = await this.api.sendChat(this.roomId, draft.text.trim(), draft.reply?.id, draft.messageId);
        if (!ack.ok || ack.id !== draft.messageId || ack.state !== 'saved-locally') throw new Error('Chat message was not acknowledged');
      }
      const next = draft.editId ? draft.compose ?? { text: '' } : { text: '' };
      await this.write(next);
      if (this.disposed) return;
      this.state = { draft: next, phase: 'saved', ready: true }; this.emit();
    } catch (error) {
      if (this.disposed) return;
      this.state = { draft, phase: 'error', ready: true, error: String(error instanceof Error ? error.message : error) }; this.emit();
    }
  }
}
