/**
 * Minecraft server log → structured GameEvents. Pure, table-driven, no JVM.
 *
 * The supervisor never pattern-matches game text itself; it reacts only to what
 * this returns. Two consequences worth stating:
 *
 *   • ORDER MATTERS. Chat is matched BEFORE joins and leaves, because a player
 *     can type "Alex joined the game" in chat and must not be able to forge a
 *     join event (or, more importantly, a fatal error) by saying it out loud.
 *   • FATAL IS A PROMISE. Flagging an event fatal tells the FSM that restarting
 *     will hit the same wall, so it goes terminal instead of spending its restart
 *     budget. Only conditions that are genuinely deterministic across a restart
 *     belong in FATAL_PATTERNS — a transient network blip must not be in there.
 */
import type { GameEvent } from '../../../../shared/gameserver-types';

/**
 * Strip the log prefix and return the level + message.
 *
 * Three shapes exist in the wild and all three appear on servers people actually
 * run, so all three are handled rather than assuming the newest:
 *   [12:34:56] [Server thread/INFO]: msg                      vanilla 1.13+
 *   [12:34:56] [Server thread/INFO] [minecraft/MinecraftServer]: msg   1.20.5+
 *   [12:34:56 INFO]: msg                                       older Paper/Spigot
 */
const PREFIX_MODERN = /^\[\d{1,2}:\d{2}:\d{2}\]\s*\[([^\]]*?)\/(INFO|WARN|ERROR|FATAL|TRACE|DEBUG)\](?:\s*\[[^\]]*\])*:\s?(.*)$/;
const PREFIX_LEGACY = /^\[\d{1,2}:\d{2}:\d{2}\s+(INFO|WARN|ERROR|FATAL)\]:\s?(.*)$/;

export interface ParsedLine {
  level: 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'TRACE' | 'DEBUG';
  thread: string;
  message: string;
}

export function stripPrefix(line: string): ParsedLine | null {
  const modern = PREFIX_MODERN.exec(line);
  if (modern) {
    return { thread: modern[1], level: modern[2] as ParsedLine['level'], message: modern[3] };
  }
  const legacy = PREFIX_LEGACY.exec(line);
  if (legacy) {
    return { thread: 'Server thread', level: legacy[1] as ParsedLine['level'], message: legacy[2] };
  }
  return null;
}

/** `Done (12.345s)! For help, type "help"` — the readiness signal. */
const DONE = /^Done\s*\(([\d.]+)s\)!/;

/** Chat. Matched first so a player cannot forge other events by typing them. */
const CHAT = /^<([^>]{1,32})>\s?(.*)$/;

/** Minecraft usernames are 3–16 of [A-Za-z0-9_]; a Bedrock/Geyser name may carry
 *  a prefix, so a leading '.' or '*' is tolerated. Keeping this tight is what
 *  stops a mod's own log chatter from registering as a player. */
const NAME = String.raw`[.*]?[A-Za-z0-9_]{1,16}`;
const JOINED = new RegExp(String.raw`^(${NAME}) joined the game$`);
const LEFT = new RegExp(String.raw`^(${NAME}) left the game$`);
const LOST_CONNECTION = new RegExp(String.raw`^(${NAME}) lost connection: `);

/** `Preparing spawn area: 42%` and the mod-loading equivalents. The label part
 *  is greedy so a dimension id containing its own colon (`minecraft:overworld`)
 *  stays in the label instead of being mistaken for the separator. */
const PROGRESS = /^(Preparing spawn area|Preparing start region for dimension .*|Loading mods.*|Constructing mods.*):\s*(\d{1,3})%$/;

/**
 * Conditions that WILL recur on restart. Each entry costs the user three
 * pointless restarts if it is wrong in the other direction, and a real crash
 * loop if it is missing — so the bar is "deterministic given the same config".
 */
const FATAL_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /java\.lang\.OutOfMemoryError/, why: 'out of memory — raise the memory limit for this server' },
  { re: /\*+ FAILED TO BIND TO PORT!/i, why: 'the port is already in use' },
  { re: /Address already in use/i, why: 'the port is already in use' },
  { re: /You need to agree to the EULA/i, why: 'the Minecraft EULA has not been accepted' },
  { re: /Failed to load eula\.txt/i, why: 'the Minecraft EULA file could not be read' },
  { re: /Encountered an unexpected exception[\s\S]*?UnsupportedClassVersionError/, why: 'this server needs a newer Java version' },
  { re: /UnsupportedClassVersionError/, why: 'this server needs a newer Java version' },
  { re: /Incompatible magic value/, why: 'the server jar is corrupt — reinstall it' },
  { re: /Invalid or corrupt jarfile/, why: 'the server jar is corrupt — reinstall it' },
  { re: /Could not find or load main class/, why: 'the server jar is not runnable — reinstall it' },
];

/** Lines the JVM prints before Minecraft's logger exists, so they carry no
 *  prefix at all and would otherwise be invisible to the fatal check. */
function checkFatal(text: string): GameEvent | null {
  for (const { re, why } of FATAL_PATTERNS) {
    if (re.test(text)) return { t: 'error', text: `${why} (${text.slice(0, 200)})`, fatal: true };
  }
  return null;
}

/**
 * Parse one already-normalised console line into zero or more events.
 */
export function parseMinecraftLine(line: string): GameEvent[] {
  const parsed = stripPrefix(line);

  // Un-prefixed output is the JVM itself (heap errors, "Error: Invalid or
  // corrupt jarfile"). It never carries player or chat content, so only the
  // fatal check applies — and it must, since these are exactly the failures that
  // happen before the server logger starts.
  if (!parsed) return checkFatal(line) ? [checkFatal(line) as GameEvent] : [];

  const { level, message } = parsed;

  // CHAT IS MATCHED BEFORE EVERYTHING ELSE, including the fatal check. A chat
  // line is the one kind of log content an untrusted party authors verbatim, so
  // any check that runs first is a check a player can trigger by typing at it —
  // and the fatal check stops the server, which makes that a remote shutdown.
  const chat = CHAT.exec(message);
  if (chat) return [{ t: 'chat', name: chat[1], text: chat[2] }];

  const fatal = checkFatal(message);
  if (fatal) return [fatal];

  const done = DONE.exec(message);
  if (done) {
    const seconds = Number.parseFloat(done[1]);
    return [{ t: 'ready', ...(Number.isFinite(seconds) ? { tookMs: Math.round(seconds * 1000) } : {}) }];
  }

  const joined = JOINED.exec(message);
  if (joined) return [{ t: 'player-join', name: joined[1] }];

  const left = LEFT.exec(message);
  if (left) return [{ t: 'player-leave', name: left[1] }];

  const lost = LOST_CONNECTION.exec(message);
  if (lost) return [{ t: 'player-leave', name: lost[1] }];

  const progress = PROGRESS.exec(message);
  if (progress) {
    const pct = Number.parseInt(progress[2], 10);
    if (Number.isFinite(pct)) return [{ t: 'progress', label: progress[1], pct: Math.min(100, pct) }];
  }

  if (level === 'ERROR' || level === 'FATAL') return [{ t: 'error', text: message }];
  if (level === 'WARN') return [{ t: 'warn', text: message }];
  return [];
}
