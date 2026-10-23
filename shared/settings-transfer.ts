import type {
  AppSettings,
  Category,
  DohTemplate,
  PrivacyConfig,
  SchedulerConfig,
} from "./types";
import { validateRoomResources } from "./room-resources";
import { validateCategory } from './category-defaults';
import { validateNotificationPolicy } from './notification-policy';
import {
  validateInterfacePreferences,
  transferSections,
  type TransferSection,
  type InterfacePreferences,
} from "./interface-preferences";

export const SETTINGS_TRANSFER_MAX_BYTES = 32 * 1024 * 1024;
export const SETTINGS_CATEGORY_LIMIT = 2000;

// Credentials and installation-specific identity never belong in plain JSON.
type PortableSettings = Omit<
  AppSettings,
  | "id"
  | "updatedAt"
  | "proxyPassword"
  | "customTurnCredential"
  | "webRemoteToken"
>;
export interface SettingsTransfer {
  version: 1 | 2;
  exportedAt?: string;
  settings: Partial<PortableSettings>;
  categories?: Category[];
  scheduler?: SchedulerConfig;
  privacyConfig?: Partial<PrivacyConfig>;
  interfacePreferences?: InterfacePreferences;
  sections?: TransferSection[];
}

/** Internal main-process snapshot. Never return this through IPC: secrets remain sealed. */
export interface SettingsImportState {
  settings: AppSettings;
  categories: Category[];
  scheduler: SchedulerConfig;
  privacyConfig: PrivacyConfig;
  nativeAppearance?: { acrylic: boolean; material: "acrylic" | "mica" };
}

export interface CategoryImportChange {
  before?: Category;
  after: Category;
}

type Rule = (value: unknown) => unknown;
// eslint-disable-next-line no-control-regex -- Control characters are invalid in user-facing fields.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- Multiline tracker lists still must not contain NUL.
const TRACKER_CONTROLS = /[\u0000\u007f]/;
function invalid(field: string): never {
  throw new Error(`Invalid settings file: ${field}`);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid(field);
  return value as Record<string, unknown>;
}
function text(max: number, nonempty = false): Rule {
  return (value) => {
    if (
      typeof value !== "string" ||
      value.length > max ||
      CONTROL_CHARACTERS.test(value) ||
      (nonempty && !value.trim())
    )
      invalid("text");
    return value;
  };
}
const bool: Rule = (value) => {
  if (typeof value !== "boolean") invalid("boolean");
  return value;
};
function number(min = 0, max = Number.MAX_SAFE_INTEGER, integer = true): Rule {
  return (value) => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isSafeInteger(value))
    )
      invalid("number");
    return value;
  };
}
function choice(...values: string[]): Rule {
  return (value) => {
    if (typeof value !== "string" || !values.includes(value)) invalid("choice");
    return value;
  };
}
function project<T>(
  value: unknown,
  rules: Record<string, Rule>,
  field: string,
): T {
  const source = object(value, field),
    result: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    if (!Object.hasOwn(source, key)) continue;
    try {
      result[key] = rule(source[key]);
    } catch {
      invalid(`${field}.${key}`);
    }
  }
  return result as T;
}
function dohTemplates(value: unknown): DohTemplate[] {
  if (!Array.isArray(value) || value.length > 100) invalid("DoH templates");
  const ids = new Set<string>();
  return value.map((item) => {
    const source = object(item, "DoH template");
    const id = text(128, true)(source.id) as string,
      name = text(256, true)(source.name) as string;
    const url = text(4096, true)(source.url) as string;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      invalid("DoH URL");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      ids.has(id)
    )
      invalid("DoH URL/ID");
    ids.add(id);
    return { id, name, url };
  });
}

const settingsRules: Record<keyof PortableSettings, Rule> = {
  resourceMode: choice('normal', 'economy', 'auto'),
  engine: choice("native", "webtorrent"),
  defaultDownloadDir: text(32768),
  maxDownKbps: number(),
  maxUpKbps: number(),
  altSpeedEnabled: bool,
  altDownKbps: number(),
  altUpKbps: number(),
  maxActiveDownloads: number(1),
  minimizeToTray: bool,
  closeToTray: bool,
  autoLaunch: bool,
  autoUpdate: bool,
  updateChannel: choice("stable", "beta"),
  enableDHT: bool,
  enablePEX: bool,
  enableLSD: bool,
  enableUtp: bool,
  encryption: choice("required", "preferred", "tolerated"),
  maxConnections: number(),
  maxConnectionsGlobal: number(),
  portMin: number(1, 65535),
  portMax: number(1, 65535),
  portForwarding: bool,
  adaptiveUpload: bool,
  dohEnabled: bool,
  dohTemplateId: text(128),
  dohCustomTemplates: dohTemplates,
  networkProfilesEnabled: bool,
  proxyEnabled: bool,
  proxyType: choice("http", "https", "socks5"),
  proxyHost: text(1024),
  proxyPort: number(0, 65535),
  proxyUsername: text(1024),
  watchFolderEnabled: bool,
  watchFolderPath: text(32768),
  watchFolderDeleteAfterAdd: bool,
  clipboardWatchEnabled: bool,
  autoMoveEnabled: bool,
  autoMovePath: text(32768),
  webRemoteEnabled: bool,
  webRemotePort: number(1, 65535),
  defaultSeedRatioLimit: number(0, Number.MAX_SAFE_INTEGER, false),
  defaultSeedTimeLimitMinutes: number(),
  enableNotifications: bool,
  enableSounds: bool,
  notifyOnComplete: bool,
  notifyOnError: bool,
  notificationPolicy: validateNotificationPolicy,
  diskGuardEnabled: bool,
  diskGuardMinFreeMB: number(),
  roomResources: validateRoomResources,
  shareUseTurn: bool,
  customTurnUrl: text(4096),
  customTurnUsername: text(1024),
  customTrackers: (value) => {
    // Tracker lists may legitimately contain newlines.
    if (
      typeof value !== "string" ||
      value.length > 16384 ||
      TRACKER_CONTROLS.test(value)
    )
      invalid("trackers");
    return value;
  },
  lanRelayEnabled: bool,
};
const privacyRules: Record<keyof PrivacyConfig, Rule> = {
  anonymousMode: bool,
  encryptStorage: bool,
  disableLogs: bool,
  vpnCheck: bool,
  clearDataOnExit: bool,
  ephemeralPeerId: bool,
  sanitizeLogs: bool,
  vpnKillSwitch: bool,
  vpnBindEngine: bool,
};

function categories(value: unknown): Category[] {
  if (!Array.isArray(value) || value.length > SETTINGS_CATEGORY_LIMIT)
    invalid("categories");
  const ids = new Set<string>();
  return value.map((item) => {
    const source = object(item, "category");
    const id = text(128, true)(source.id) as string;
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id) ||
      ["__proto__", "constructor", "prototype"].includes(id) ||
      ids.has(id)
    )
      invalid("category ID");
    ids.add(id);
    const name = text(256, true)(source.name) as string,
      icon = text(128, true)(source.icon) as string;
    const color = text(32, true)(source.color) as string;
    if (
      !/^[a-zA-Z0-9-]+$/.test(icon) ||
      !/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color)
    )
      invalid("category appearance");
    try { return validateCategory({ id, name, icon, color, ...(source.downloadDefaults !== undefined ? { downloadDefaults: source.downloadDefaults } : {}),
      ...(source.notificationRule !== undefined ? { notificationRule: source.notificationRule } : {}) }); }
    catch { invalid('category defaults'); }
  });
}
function scheduler(value: unknown): SchedulerConfig {
  const source = object(value, "scheduler");
  bool(source.enabled);
  if (!Array.isArray(source.schedules) || source.schedules.length > 1000)
    invalid("schedules");
  const ids = new Set<string>();
  const schedules = source.schedules.map((item) => {
    const entry = object(item, "schedule"),
      id = text(128, true)(entry.id) as string;
    if (ids.has(id)) invalid("schedule ID");
    ids.add(id);
    if (
      !Array.isArray(entry.days) ||
      entry.days.length > 7 ||
      entry.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    )
      invalid("schedule days");
    const time = (value: unknown) => {
      if (
        typeof value !== "string" ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
      )
        invalid("schedule time");
      return value;
    };
    return {
      id,
      days: [...new Set(entry.days as number[])],
      startTime: time(entry.startTime),
      endTime: time(entry.endTime),
      ...(Object.hasOwn(entry, "speedLimit")
        ? { speedLimit: number()(entry.speedLimit) as number }
        : {}),
    };
  });
  return { enabled: source.enabled as boolean, schedules };
}

/** v1 remains readable. Unknown versions fail before any state is written. */
export function validateSettingsTransfer(value: unknown): SettingsTransfer {
  const source = object(value, "root");
  if (source.version !== 1 && source.version !== 2)
    invalid("unsupported version");
  const result: SettingsTransfer = {
    version: source.version,
    settings: project(source.settings, settingsRules, "settings"),
  };
  if (source.version === 2) {
    if (!Array.isArray(source.sections)) invalid("sections");
    result.sections = transferSections({
      sections: source.sections as TransferSection[],
    });
    if (
      result.sections.some((section) =>
        ["appearance", "hotkeys", "layout"].includes(section),
      ) &&
      source.interfacePreferences === undefined
    )
      invalid("missing interface preferences");
  }
  if (source.exportedAt !== undefined)
    result.exportedAt = text(64)(source.exportedAt) as string;
  if (source.categories !== undefined)
    result.categories = categories(source.categories);
  if (source.scheduler !== undefined)
    result.scheduler = scheduler(source.scheduler);
  if (source.privacyConfig !== undefined)
    result.privacyConfig = project(
      source.privacyConfig,
      privacyRules,
      "privacyConfig",
    );
  if (source.interfacePreferences !== undefined) {
    if (source.version !== 2)
      invalid("interface preferences require version 2");
    result.interfacePreferences = validateInterfacePreferences(
      source.interfacePreferences,
    );
  }
  return result;
}

export function createSettingsExport(
  state: SettingsImportState,
): SettingsTransfer {
  return validateSettingsTransfer({
    version: 1,
    exportedAt: new Date().toISOString(),
    ...state,
  });
}

/** Merge by ID, preserving unrelated categories and every existing reference to an ID. */
export function planSettingsImport(
  state: SettingsImportState,
  value: unknown,
): {
  next: SettingsImportState;
  changes: CategoryImportChange[];
} {
  const bundle = validateSettingsTransfer(value);
  const merged = new Map(
    state.categories.map((category) => [category.id, { ...category }]),
  );
  const changes: CategoryImportChange[] = [];
  for (const category of bundle.categories ?? []) {
    const before = merged.get(category.id);
    if (
      !before ||
      before.name !== category.name ||
      before.icon !== category.icon ||
      before.color !== category.color ||
      JSON.stringify(before.downloadDefaults ?? {}) !== JSON.stringify(category.downloadDefaults ?? {}) ||
      JSON.stringify(before.notificationRule ?? {}) !== JSON.stringify(category.notificationRule ?? {})
    ) {
      changes.push({ ...(before ? { before } : {}), after: category });
    }
    merged.set(category.id, category);
  }
  if (merged.size > SETTINGS_CATEGORY_LIMIT)
    invalid("too many merged categories");
  const settings = { ...state.settings, ...bundle.settings };
  if (settings.portMin > settings.portMax) invalid("port range");
  return {
    next: {
      ...state,
      settings,
      categories: [...merged.values()],
      scheduler: bundle.scheduler ?? state.scheduler,
      privacyConfig: { ...state.privacyConfig, ...bundle.privacyConfig },
    },
    changes,
  };
}
