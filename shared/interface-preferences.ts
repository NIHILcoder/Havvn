import {
  DEFAULT_APPEARANCE,
  validateAppearance,
  type Appearance,
} from "./appearance";
import { validateAppearanceProfile } from "./appearance-profile";
import { FONT_OPTIONS, validateTheme } from "./theme";
import { DOWNLOAD_VIEWS_KEY, validateDownloadViews } from "./download-views";
import { NAVIGATION_KEY, NAVIGATION_MAX_CHARS, validateNavigation } from './navigation';
import { PANELS_KEY, WORKING_PROFILES_KEY, WORKING_PROFILES_MAX_CHARS, validatePanels, validateWorkingProfiles } from './working-profile-schema';

export const INTERFACE_KEYS = [
  "theme",
  "accentColor",
  "fontChoice",
  "havvn.theme.library",
  "havvn.theme.active",
  "havvn.appearance.v1",
  "havvn.appearance.wallpaper.v1",
  "havvn.appearance.profiles.v1",
  "hotkeys",
  "roomLayout",
  "uiScale",
  "reduceMotion",
  "density",
  "startPage",
  "speedUnits",
  "language",
  DOWNLOAD_VIEWS_KEY,
  NAVIGATION_KEY,
  PANELS_KEY,
  WORKING_PROFILES_KEY,
] as const;
const OPTIONAL_INTERFACE_KEYS: readonly string[] = [DOWNLOAD_VIEWS_KEY, NAVIGATION_KEY, PANELS_KEY, WORKING_PROFILES_KEY];
export type InterfaceKey = (typeof INTERFACE_KEYS)[number];
export interface InterfacePreferences {
  version: 1;
  values: Record<InterfaceKey, string | null>;
}
export const TRANSFER_SECTIONS = [
  "settings",
  "categories",
  "scheduler",
  "privacyConfig",
  "appearance",
  "hotkeys",
  "layout",
] as const;
export type TransferSection = (typeof TRANSFER_SECTIONS)[number];
export interface SettingsTransferOptions {
  sections?: TransferSection[];
}
export interface SettingsTransferStatus {
  backupAt: string | null;
  recoveryNeeded: boolean;
  error?: boolean;
}
export interface SettingsTransferStep {
  success: boolean;
  id?: string;
  preferences?: InterfacePreferences;
}
export const INTERFACE_MAX_BYTES = 16 * 1024 * 1024;

const appearanceKeys = new Set<InterfaceKey>(INTERFACE_KEYS.slice(0, 8));
export function interfaceSection(
  key: InterfaceKey,
): "appearance" | "hotkeys" | "layout" {
  return appearanceKeys.has(key)
    ? "appearance"
    : key === "hotkeys"
      ? "hotkeys"
      : "layout";
}
export function transferSections(
  options?: SettingsTransferOptions,
): TransferSection[] {
  const sections: unknown = options?.sections ?? [...TRANSFER_SECTIONS];
  if (
    !Array.isArray(sections) ||
    !sections.length ||
    sections.length > TRANSFER_SECTIONS.length ||
    sections.some((section) => !TRANSFER_SECTIONS.includes(section)) ||
    new Set(sections).size !== sections.length
  ) {
    throw new Error("Choose at least one valid settings section");
  }
  return [...sections] as TransferSection[];
}
function fail(key: string): never {
  throw new Error(`Invalid interface preferences: ${key}`);
}
function parse(value: string | null, key: string): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    fail(key);
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function interfaceAppearance(
  preferences: InterfacePreferences,
): Appearance {
  const raw = parse(preferences.values["havvn.appearance.v1"], "appearance");
  const image = preferences.values["havvn.appearance.wallpaper.v1"] ?? "";
  const combined =
    raw === null
      ? { ...DEFAULT_APPEARANCE, wallpaper: image }
      : object(raw)
        ? { ...raw, wallpaper: raw.wallpaper || image }
        : null;
  const result = validateAppearance(combined);
  if (!result) fail("appearance");
  return result;
}

/** An exact, bounded snapshot of selected keys, never a dump of localStorage. */
export function validateInterfacePreferences(
  input: unknown,
): InterfacePreferences {
  if (
    !object(input) ||
    input.version !== 1 ||
    !object(input.values) ||
    Object.keys(input).some((key) => key !== "version" && key !== "values") ||
    Object.keys(input.values).length > INTERFACE_KEYS.length ||
    INTERFACE_KEYS.some(
      (key) =>
        !OPTIONAL_INTERFACE_KEYS.includes(key) &&
        !Object.hasOwn(input.values as object, key),
    ) ||
    Object.keys(input.values).some(
      (key) => !INTERFACE_KEYS.includes(key as InterfaceKey),
    )
  )
    fail("schema");
  const values = {} as InterfacePreferences["values"];
  for (const key of INTERFACE_KEYS) {
    // Older exports/journals predate views, navigation and working profiles. Omission
    // preserves that preference; an explicit null in a new snapshot clears it.
    if (OPTIONAL_INTERFACE_KEYS.includes(key) && !Object.hasOwn(input.values, key))
      continue;
    const value = input.values[key];
    if (value !== null && typeof value !== "string") fail(key);
    values[key] = value;
  }
  const result: InterfacePreferences = { version: 1, values };
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    INTERFACE_MAX_BYTES
  )
    fail("size");
  const enums: Partial<Record<InterfaceKey, string[]>> = {
    theme: ["dark", "light", "system"],
    density: ["normal", "compact"],
    reduceMotion: ["0", "1"],
    startPage: ["downloads", "rooms"],
    speedUnits: ["binary", "si", "bits"],
    language: ["en", "ru"],
    uiScale: ["90", "100", "110", "125"],
    fontChoice: FONT_OPTIONS.map((font) => font.id),
  };
  for (const [key, allowed] of Object.entries(enums)) {
    const value = values[key as InterfaceKey];
    if (value !== null && !allowed.includes(value)) fail(key);
  }
  if (values.accentColor !== null && !/^#[\da-f]{6}$/i.test(values.accentColor))
    fail("accentColor");
  interfaceAppearance(result);
  const library = parse(values["havvn.theme.library"], "themes") ?? [];
  if (!Array.isArray(library) || library.length > 64) fail("themes");
  const themeIds = new Set<string>();
  for (const theme of library) {
    const checked = validateTheme(theme);
    if (
      !checked.ok ||
      checked.warnings.length ||
      !checked.theme.id ||
      themeIds.has(checked.theme.id)
    )
      fail("theme");
    themeIds.add(checked.theme.id);
  }
  if (
    values["havvn.theme.active"] !== null &&
    !themeIds.has(values["havvn.theme.active"])
  )
    fail("active theme");
  const profiles =
    parse(values["havvn.appearance.profiles.v1"], "profiles") ?? [];
  if (
    !Array.isArray(profiles) ||
    profiles.length > 8 ||
    profiles.some((p) => !validateAppearanceProfile(p))
  )
    fail("profiles");
  const hotkeys = parse(values.hotkeys, "hotkeys");
  if (hotkeys !== null) {
    if (!Array.isArray(hotkeys) || hotkeys.length > 64) fail("hotkeys");
    const ids = new Set<string>();
    for (const entry of hotkeys) {
      if (
        !object(entry) ||
        Object.keys(entry).some((key) => key !== "id" && key !== "keys") ||
        typeof entry.id !== "string" ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(entry.id) ||
        ids.has(entry.id) ||
        !Array.isArray(entry.keys) ||
        entry.keys.length > 5 ||
        entry.keys.some(
          (key) =>
            typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(key),
        ) ||
        new Set(entry.keys).size !== entry.keys.length
      )
        fail("hotkeys");
      ids.add(entry.id);
    }
  }
  const layout = parse(values.roomLayout, "roomLayout");
  const views = parse(values[DOWNLOAD_VIEWS_KEY] ?? null, DOWNLOAD_VIEWS_KEY);
  if (views !== null) validateDownloadViews(views);
  if ((values[NAVIGATION_KEY]?.length ?? 0) > NAVIGATION_MAX_CHARS) fail(NAVIGATION_KEY);
  const navigation = parse(values[NAVIGATION_KEY] ?? null, NAVIGATION_KEY);
  if (navigation !== null) validateNavigation(navigation);
  const panels = parse(values[PANELS_KEY] ?? null, PANELS_KEY);
  if (panels !== null) validatePanels(panels);
  if ((values[WORKING_PROFILES_KEY]?.length ?? 0) > WORKING_PROFILES_MAX_CHARS) fail(WORKING_PROFILES_KEY);
  const working = parse(values[WORKING_PROFILES_KEY] ?? null, WORKING_PROFILES_KEY);
  if (working !== null) validateWorkingProfiles(working);
  if (
    layout !== null &&
    (!object(layout) ||
      Object.keys(layout).some((key) => key !== "railW" && key !== "chatW") ||
      typeof layout.railW !== "number" ||
      !Number.isFinite(layout.railW) ||
      (layout.railW as number) < 180 ||
      (layout.railW as number) > 360 ||
      typeof layout.chatW !== "number" ||
      !Number.isFinite(layout.chatW) ||
      (layout.chatW as number) < 260 ||
      (layout.chatW as number) > 460)
  )
    fail("roomLayout");
  return result;
}

export interface PreferencesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export function captureInterfacePreferences(
  storage: PreferencesStorage,
): InterfacePreferences {
  return validateInterfacePreferences({
    version: 1,
    values: Object.fromEntries(
      INTERFACE_KEYS.map((key) => [key, storage.getItem(key)]),
    ),
  });
}
export function selectInterfacePreferences(
  before: InterfacePreferences,
  incoming: InterfacePreferences,
  sections: TransferSection[],
): InterfacePreferences {
  const selected = validateInterfacePreferences({
    version: 1,
    values: Object.fromEntries(
      INTERFACE_KEYS.map((key) => [
        key,
        sections.includes(interfaceSection(key))
          ? Object.hasOwn(incoming.values, key)
            ? incoming.values[key]
            : (before.values[key] ?? null)
          : (before.values[key] ?? null),
      ]),
    ),
  });
  // A working-profile return point belongs to the current installation/session.
  // Do not copy its embedded prior appearance when only layout was selected.
  if (sections.includes('layout') && Object.hasOwn(incoming.values, WORKING_PROFILES_KEY) && selected.values[WORKING_PROFILES_KEY]) {
    const catalog = validateWorkingProfiles(JSON.parse(selected.values[WORKING_PROFILES_KEY]));
    if (catalog.previous !== null) selected.values[WORKING_PROFILES_KEY] = JSON.stringify({ ...catalog, previous: null });
  }
  return selected;
}

/** Remove only changing keys first, avoiding a temporary second copy of large images/fonts. */
export function writeInterfacePreferences(
  storage: PreferencesStorage,
  input: InterfacePreferences,
): void {
  const desired = validateInterfacePreferences(input);
  const changed = INTERFACE_KEYS.filter(
    (key) =>
      Object.hasOwn(desired.values, key) &&
      storage.getItem(key) !== desired.values[key],
  );
  for (const key of changed) storage.removeItem(key);
  for (const key of changed) {
    const value = desired.values[key];
    if (value !== null) storage.setItem(key, value);
  }
  const saved = captureInterfacePreferences(storage);
  if (
    Object.entries(desired.values).some(
      ([key, value]) => saved.values[key as InterfaceKey] !== value,
    )
  )
    throw new Error("Interface preferences were not saved");
}
