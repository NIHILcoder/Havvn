/**
 * Room data memory management utilities
 * Implements capping for unbounded collections to prevent memory leaks
 */

import { RoomEvent, RoomChatMessage } from '../../shared/types';

// Memory limits for room data
export const ROOM_LIMITS = {
  MAX_EVENTS: 1000,           // Room history events
  MAX_CHAT_MESSAGES: 5000,    // Chat messages per room
  MAX_REACTIONS: 100,         // Reactions per file/message
  MAX_MEMBERS_PER_REACTION: 50, // Members per emoji
  MAX_EDITS_PER_MESSAGE: 10,  // Edit history per message
} as const;

/**
 * Cap room events to prevent unbounded growth
 * Keeps the most recent events up to the limit
 */
export function capRoomEvents(events: RoomEvent[]): RoomEvent[] {
  if (events.length <= ROOM_LIMITS.MAX_EVENTS) {
    return events;
  }

  // Keep most recent events
  return events.slice(-ROOM_LIMITS.MAX_EVENTS);
}

/**
 * Cap chat messages to prevent unbounded growth
 * Keeps the most recent messages up to the limit
 */
export function capChatMessages(messages: RoomChatMessage[]): RoomChatMessage[] {
  if (messages.length <= ROOM_LIMITS.MAX_CHAT_MESSAGES) {
    return messages;
  }

  // Keep most recent messages
  return messages.slice(-ROOM_LIMITS.MAX_CHAT_MESSAGES);
}

/**
 * Cap reactions for a single target (file or message)
 * Limits both the number of emoji types and members per emoji
 */
export function capReactions(
  reactions: Record<string, string[]>
): Record<string, string[]> {
  const emojis = Object.keys(reactions);

  // If total emoji count is within limit, just cap member lists
  if (emojis.length <= ROOM_LIMITS.MAX_REACTIONS) {
    const capped: Record<string, string[]> = {};
    for (const emoji of emojis) {
      const members = reactions[emoji];
      capped[emoji] = members.slice(0, ROOM_LIMITS.MAX_MEMBERS_PER_REACTION);
    }
    return capped;
  }

  // Too many emoji types - sort by member count and keep top N
  const sorted = emojis
    .map(emoji => ({ emoji, count: reactions[emoji].length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, ROOM_LIMITS.MAX_REACTIONS);

  const capped: Record<string, string[]> = {};
  for (const { emoji } of sorted) {
    const members = reactions[emoji];
    capped[emoji] = members.slice(0, ROOM_LIMITS.MAX_MEMBERS_PER_REACTION);
  }

  return capped;
}

/**
 * Calculate memory usage estimate for room data (in bytes)
 */
export function estimateRoomMemory(data: {
  events?: RoomEvent[];
  messages?: RoomChatMessage[];
  reactions?: Record<string, Record<string, string[]>>;
}): number {
  let bytes = 0;

  // Rough estimates:
  // - Event: ~200 bytes average
  // - Message: ~300 bytes average (includes text, metadata)
  // - Reaction: ~50 bytes (emoji + memberId)

  if (data.events) {
    bytes += data.events.length * 200;
  }

  if (data.messages) {
    bytes += data.messages.length * 300;
  }

  if (data.reactions) {
    for (const target of Object.values(data.reactions)) {
      for (const members of Object.values(target)) {
        bytes += members.length * 50;
      }
    }
  }

  return bytes;
}

/**
 * Check if room data needs cleanup based on memory thresholds
 */
export function needsCleanup(data: {
  events?: RoomEvent[];
  messages?: RoomChatMessage[];
  reactions?: Record<string, Record<string, string[]>>;
}): boolean {
  if (data.events && data.events.length > ROOM_LIMITS.MAX_EVENTS * 1.2) {
    return true;
  }

  if (data.messages && data.messages.length > ROOM_LIMITS.MAX_CHAT_MESSAGES * 1.2) {
    return true;
  }

  // Check total reaction count across all targets
  if (data.reactions) {
    let totalReactions = 0;
    for (const target of Object.values(data.reactions)) {
      for (const members of Object.values(target)) {
        totalReactions += members.length;
      }
    }
    if (totalReactions > ROOM_LIMITS.MAX_REACTIONS * 100) {
      return true;
    }
  }

  return false;
}

/**
 * Prune old data from all room collections
 */
export function pruneRoomData(data: {
  events?: RoomEvent[];
  messages?: RoomChatMessage[];
  reactions?: Record<string, Record<string, string[]>>;
}): {
  events?: RoomEvent[];
  messages?: RoomChatMessage[];
  reactions?: Record<string, Record<string, string[]>>;
  pruned: { events: number; messages: number; reactions: number };
} {
  const pruned = { events: 0, messages: 0, reactions: 0 };

  const result: typeof data = {};

  if (data.events) {
    const before = data.events.length;
    result.events = capRoomEvents(data.events);
    pruned.events = before - result.events.length;
  }

  if (data.messages) {
    const before = data.messages.length;
    result.messages = capChatMessages(data.messages);
    pruned.messages = before - result.messages.length;
  }

  if (data.reactions) {
    result.reactions = {};
    for (const [targetId, targetReactions] of Object.entries(data.reactions)) {
      const before = Object.values(targetReactions).reduce((sum, m) => sum + m.length, 0);
      result.reactions[targetId] = capReactions(targetReactions);
      const after = Object.values(result.reactions[targetId]).reduce((sum, m) => sum + m.length, 0);
      pruned.reactions += before - after;
    }
  }

  return { ...result, pruned };
}
