/**
 * Search-plugin manifests.
 *
 * A script provider is added by typing a path to a .py file and nothing else —
 * the app can't say what the plugin is called, what version it is, which
 * categories it covers, or that it needs a login until a search fails. A plugin
 * can now declare that in a comment near the top of the file:
 *
 *   # th-plugin: {"name": "Example", "version": "1.0", "categories": ["2000"], "requires": ["username", "password"]}
 *
 * Entirely optional: a plugin without one keeps working exactly as before.
 *
 * The manifest is author-supplied data, not configuration we act on blindly —
 * every field is coerced and capped here before it reaches the UI, the same
 * trust boundary `search-parse.ts` draws around a plugin's stdout.
 */

export interface PluginManifest {
  name?: string;
  version?: string;
  description?: string;
  /** Torznab/newznab category ids the plugin can search. */
  categories: string[];
  /** Credential fields the plugin needs: "username", "password", "apikey". */
  requires: Array<'username' | 'password' | 'apikey'>;
}

/** Only the head of a file is scanned — a manifest belongs near the top. */
export const MANIFEST_SCAN_BYTES = 4096;

const MAX_STRING = 200;
const MAX_CATEGORIES = 40;

const KNOWN_REQUIREMENTS = ['username', 'password', 'apikey'] as const;

/**
 * Find and parse a manifest comment. Returns null when there is none, or when
 * what is there isn't usable — a malformed manifest must not stop the plugin
 * from being added.
 */
export function parsePluginManifest(source: string): PluginManifest | null {
  const head = source.slice(0, MANIFEST_SCAN_BYTES);
  const match = head.match(/^[ \t]*#[ \t]*th-plugin:[ \t]*(\{.*\})[ \t]*$/im);
  if (!match) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;
  return {
    name: str(obj.name),
    version: str(obj.version),
    description: str(obj.description),
    categories: categoryList(obj.categories),
    requires: requirementList(obj.requires),
  };
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_STRING ? trimmed.slice(0, MAX_STRING) : trimmed;
}

function categoryList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    // Numbers are the natural way to write a category id in JSON; accept both.
    const id = typeof entry === 'number' ? String(entry) : str(entry);
    if (id && /^\d{1,6}$/.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_CATEGORIES) break;
  }
  return out;
}

function requirementList(value: unknown): PluginManifest['requires'] {
  if (!Array.isArray(value)) return [];
  const out: PluginManifest['requires'] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const key = entry.trim().toLowerCase();
    const known = KNOWN_REQUIREMENTS.find(k => k === key);
    if (known && !out.includes(known)) out.push(known);
  }
  return out;
}
