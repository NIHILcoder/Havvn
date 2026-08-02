/**
 * server.properties — a java.util.Properties file. Pure, so it is exhaustively
 * unit-tested without a JVM.
 *
 * THE ROUND-TRIP REQUIREMENT IS THE WHOLE POINT. A naive "parse into an object,
 * write the object back" implementation silently destroys two things the user
 * cares about: comments (including the server-generated header) and any key our
 * schema does not know about — which is every key a plugin, a mod or a newer
 * Minecraft version added. Someone hand-edits a setting, opens our form, saves,
 * and their edit is gone with no error. So serialize() rewrites values IN PLACE
 * in the original text and only appends keys that were genuinely new.
 */

/** Decode the escapes java.util.Properties applies to a key or value. */
function unescape(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = raw[++i];
    if (next === undefined) break;
    switch (next) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'f': out += '\f'; break;
      case 'u': {
        const hex = raw.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += 'u';
        }
        break;
      }
      // '\:' '\=' '\ ' '\\' and anything else: the escape just drops away.
      default: out += next; break;
    }
  }
  return out;
}

/** Escape a VALUE for writing. Keys would additionally need ':' '=' and spaces
 *  escaped, but every key we write is a plain identifier, so this is value-only. */
function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Is this line a comment or blank? */
function isCommentOrBlank(line: string): boolean {
  const t = line.trimStart();
  return t === '' || t.startsWith('#') || t.startsWith('!');
}

/**
 * Split one logical line into key and value. Properties accepts '=', ':' or
 * whitespace as the separator, and the separator may itself be escaped.
 */
function splitEntry(line: string): { key: string; value: string } | null {
  let i = 0;
  // Skip leading whitespace.
  while (i < line.length && (line[i] === ' ' || line[i] === '\t' || line[i] === '\f')) i++;
  let key = '';
  let sepIndex = -1;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      key += ch + (line[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '=' || ch === ':') { sepIndex = i; break; }
    if (ch === ' ' || ch === '\t' || ch === '\f') {
      // Whitespace separates only if no '='/':' follows before the value.
      let j = i;
      while (j < line.length && (line[j] === ' ' || line[j] === '\t' || line[j] === '\f')) j++;
      sepIndex = (line[j] === '=' || line[j] === ':') ? j : i;
      break;
    }
    key += ch;
  }
  if (key === '') return null;
  const value = sepIndex >= 0 ? line.slice(sepIndex + 1).replace(/^[ \t\f]+/, '') : '';
  return { key: unescape(key), value: unescape(value) };
}

/**
 * Join physical lines ending in an odd number of backslashes into logical ones
 * (the Properties continuation rule).
 */
function logicalLines(text: string): string[] {
  const physical = text.split(/\r\n|\n|\r/);
  const out: string[] = [];
  let pending: string | null = null;
  for (const line of physical) {
    const current: string = pending === null ? line : pending + line.replace(/^[ \t\f]+/, '');
    const trailing = /\\*$/.exec(current)?.[0].length ?? 0;
    if (trailing % 2 === 1 && !isCommentOrBlank(current)) {
      pending = current.slice(0, -1);
    } else {
      out.push(current);
      pending = null;
    }
  }
  if (pending !== null) out.push(pending);
  return out;
}

export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of logicalLines(text)) {
    if (isCommentOrBlank(line)) continue;
    const entry = splitEntry(line);
    if (entry) out[entry.key] = entry.value;
  }
  return out;
}

/**
 * Write values back. With `previous`, existing lines are rewritten in place —
 * preserving comments, ordering and unknown keys — and only genuinely new keys
 * are appended. Without it, a fresh sorted file is produced.
 */
export function serializeProperties(
  values: Readonly<Record<string, string>>,
  previous?: string,
): string {
  if (previous === undefined) {
    const keys = Object.keys(values).sort();
    return `${keys.map((k) => `${k}=${escapeValue(values[k])}`).join('\n')}\n`;
  }

  const seen = new Set<string>();
  const lines = previous.split(/\r\n|\n|\r/);
  const rewritten = lines.map((line) => {
    if (isCommentOrBlank(line)) return line;
    const entry = splitEntry(line);
    if (!entry) return line;
    seen.add(entry.key);
    if (!(entry.key in values)) return line; // untouched by this save
    return `${entry.key}=${escapeValue(values[entry.key])}`;
  });

  const added = Object.keys(values).filter((k) => !seen.has(k)).sort();
  if (added.length) {
    // Keep exactly one blank line before appended keys, whatever the original
    // file ended with.
    while (rewritten.length && rewritten[rewritten.length - 1].trim() === '') rewritten.pop();
    rewritten.push('');
    for (const k of added) rewritten.push(`${k}=${escapeValue(values[k])}`);
  }

  const text = rewritten.join('\n');
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** Read an integer property with a fallback, since everything is a string here. */
export function propInt(values: Readonly<Record<string, string>>, key: string, fallback: number): number {
  const n = Number.parseInt(values[key] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Properties booleans are the literal strings 'true' / 'false'. */
export function propBool(values: Readonly<Record<string, string>>, key: string, fallback: boolean): boolean {
  const v = values[key];
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}
