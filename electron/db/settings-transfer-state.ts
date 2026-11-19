import { randomUUID } from "node:crypto";
import { planWorkingProfile, validateWorkingRequest } from '../../shared/working-profiles';
import { readProfileNotifications, WorkingProfileError } from '../../shared/working-profile-schema';
import {
  createSettingsExport,
  planSettingsImport,
  validateSettingsTransfer,
  type SettingsImportState,
  type SettingsTransfer,
} from "../../shared/settings-transfer";
import {
  TRANSFER_SECTIONS,
  interfaceAppearance,
  selectInterfacePreferences,
  validateInterfacePreferences,
  type InterfacePreferences,
  type TransferSection,
  type SettingsTransferStatus,
} from "../../shared/interface-preferences";

type MainState = SettingsImportState;
interface Backup {
  at: string;
  before: MainState;
  after: MainState;
  preferences: InterfacePreferences | null;
}
export interface TransferPlan {
  id: string;
  kind: "import" | "restore" | "profile";
  at: string;
  before: MainState;
  after: MainState;
  beforeInterface: InterfacePreferences | null;
  afterInterface: InterfacePreferences | null;
}
interface Pending extends TransferPlan {
  phase: "prepared" | "recover-interface";
}
interface Journal {
  version: 1;
  pending: Pending | null;
  backup: Backup | null;
}
interface Backend {
  read(): unknown;
  write(record: Journal): void;
  readMain(): MainState;
  writeMain(next: MainState, expected: MainState): void;
  categoryReferences(): Set<string>;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const empty = (): Journal => ({ version: 1, pending: null, backup: null });
function withoutSecrets(state: MainState): MainState {
  const settings = { ...state.settings };
  for (const key of [
    "proxyPassword",
    "customTurnCredential",
    "webRemoteToken",
  ] as const)
    delete (settings as Partial<MainState["settings"]>)[key];
  return { ...state, settings };
}
const sameMain = (a: MainState, b: MainState) =>
  same(withoutSecrets(a), withoutSecrets(b));
function keepCurrentSecrets(target: MainState, current: MainState): MainState {
  const settings = { ...target.settings };
  for (const key of [
    "proxyPassword",
    "customTurnCredential",
    "webRemoteToken",
  ] as const) {
    const value = current.settings[key];
    if (typeof value === "string") settings[key] = value;
    else delete (settings as Partial<MainState["settings"]>)[key];
  }
  return { ...target, settings };
}

export function selectSettingsTransfer(
  input: unknown,
  sections: TransferSection[],
): SettingsTransfer {
  const source = validateSettingsTransfer(input);
  const available = source.sections ?? [
    "settings",
    ...(source.categories ? ["categories"] : []),
    ...(source.scheduler ? ["scheduler"] : []),
    ...(source.privacyConfig ? ["privacyConfig"] : []),
  ];
  sections = sections.filter((section) => available.includes(section));
  if (!sections.length)
    throw new Error("The file contains none of the selected sections");
  return {
    version: source.version,
    settings: sections.includes("settings") ? source.settings : {},
    ...(source.sections ? { sections } : {}),
    ...(sections.includes("categories") && source.categories
      ? { categories: source.categories }
      : {}),
    ...(sections.includes("scheduler") && source.scheduler
      ? { scheduler: source.scheduler }
      : {}),
    ...(sections.includes("privacyConfig") && source.privacyConfig
      ? { privacyConfig: source.privacyConfig }
      : {}),
    ...(source.interfacePreferences
      ? { interfacePreferences: source.interfacePreferences }
      : {}),
  };
}

/** The journal is separate from config.json, so images are not rewritten on every setting change. */
export class SettingsTransferState {
  constructor(private backend: Backend) {}

  private save(record: Journal): void {
    // Transfers never change credentials; recovery can always keep the current ones.
    // Do not duplicate even legacy plaintext credentials in a new journal/backup.
    this.backend.write({
      ...record,
      pending: record.pending
        ? {
            ...record.pending,
            before: withoutSecrets(record.pending.before),
            after: withoutSecrets(record.pending.after),
          }
        : null,
      backup: record.backup
        ? {
            ...record.backup,
            before: withoutSecrets(record.backup.before),
            after: withoutSecrets(record.backup.after),
          }
        : null,
    });
  }

  private journal(): Journal {
    const value = this.backend.read() as Journal | null;
    if (!value) return empty();
    const checkState = (state: MainState) => {
      if (
        !state ||
        !Array.isArray(state.categories) ||
        !state.scheduler ||
        !state.privacyConfig ||
        typeof state.privacyConfig !== "object" ||
        Array.isArray(state.privacyConfig)
      )
        throw new Error("Incomplete settings snapshot");
      createSettingsExport(state);
      if (
        !state.settings ||
        ["proxyPassword", "customTurnCredential", "webRemoteToken"].some(
          (key) =>
            (state.settings as unknown as Record<string, unknown>)[key] !==
              undefined &&
            typeof (state.settings as unknown as Record<string, unknown>)[
              key
            ] !== "string",
        )
      )
        throw new Error("Invalid protected settings snapshot");
      if (
        state.nativeAppearance &&
        (typeof state.nativeAppearance.acrylic !== "boolean" ||
          !["acrylic", "mica"].includes(state.nativeAppearance.material))
      )
        throw new Error("Invalid native appearance snapshot");
    };
    if (value.version !== 1 || !("pending" in value) || !("backup" in value))
      throw new Error("Invalid settings recovery journal");
    if (value.pending) {
      const p = value.pending;
      if (
        !/^[\da-f-]{36}$/i.test(p.id) ||
        typeof p.at !== "string" ||
        !["import", "restore", "profile"].includes(p.kind) ||
        !["prepared", "recover-interface"].includes(p.phase) ||
        p.beforeInterface === undefined ||
        p.afterInterface === undefined
      )
        throw new Error("Invalid settings recovery operation");
      checkState(p.before);
      checkState(p.after);
      if (p.beforeInterface) validateInterfacePreferences(p.beforeInterface);
      if (p.afterInterface) validateInterfacePreferences(p.afterInterface);
    }
    if (value.backup) {
      checkState(value.backup.before);
      checkState(value.backup.after);
      if (
        typeof value.backup.at !== "string" ||
        value.backup.preferences === undefined
      )
        throw new Error("Invalid settings backup");
      if (value.backup.preferences)
        validateInterfacePreferences(value.backup.preferences);
    }
    return value;
  }

  status(): SettingsTransferStatus {
    try {
      const record = this.journal();
      return {
        backupAt: record.backup?.at ?? null,
        recoveryNeeded: !!record.pending,
      };
    } catch {
      return { backupAt: null, recoveryNeeded: true, error: true };
    }
  }

  private plan(
    kind: TransferPlan["kind"],
    before: MainState,
    after: MainState,
    beforeInterface: InterfacePreferences | null,
    afterInterface: InterfacePreferences | null,
  ): TransferPlan {
    if (this.journal().pending)
      throw new Error("Recover the interrupted settings transfer first");
    after.settings = { ...after.settings, updatedAt: new Date() };
    return {
      id: randomUUID(),
      kind,
      at: new Date().toISOString(),
      before,
      after,
      beforeInterface,
      afterInterface,
    };
  }

  planImport(
    input: unknown,
    currentInterface: InterfacePreferences | null,
    sections: TransferSection[],
  ): TransferPlan {
    const before = this.backend.readMain(),
      source = selectSettingsTransfer(input, sections);
    if (currentInterface)
      currentInterface = validateInterfacePreferences(currentInterface);
    if (source.interfacePreferences && !currentInterface)
      throw new Error("Interface preferences require the current app window");
    const afterInterface =
      currentInterface && source.interfacePreferences
        ? selectInterfacePreferences(
            currentInterface,
            source.interfacePreferences,
            source.sections ?? sections,
          )
        : currentInterface;
    const after = planSettingsImport(before, source).next;
    if (
      source.interfacePreferences &&
      (source.sections ?? sections).includes("appearance") &&
      afterInterface
    ) {
      const appearance = interfaceAppearance(afterInterface);
      after.nativeAppearance = {
        acrylic: appearance.acrylic,
        material: appearance.nativeMaterial,
      };
    }
    return this.plan("import", before, after, currentInterface, afterInterface);
  }

  planWorkingProfile(currentInterface: InterfacePreferences, input: unknown): TransferPlan {
    currentInterface = validateInterfacePreferences(currentInterface);
    const request = validateWorkingRequest(input), before = this.backend.readMain();
    if (!same(currentInterface, request.expected) || !same(readProfileNotifications(before.settings), request.notifications)) throw new WorkingProfileError('stale');
    const result = planWorkingProfile(currentInterface, request.notifications, request.id, `work-${randomUUID()}`);
    const appearance = interfaceAppearance(result.preferences);
    const changesAppearance = request.id === null || result.after.values.appearanceName !== null;
    return this.plan('profile', before, { ...before, settings: { ...before.settings, ...result.after.values.notifications },
      nativeAppearance: changesAppearance ? { acrylic: appearance.acrylic, material: appearance.nativeMaterial } : before.nativeAppearance }, currentInterface, result.preferences);
  }

  planRestore(
    currentInterface: InterfacePreferences | null,
    sections: TransferSection[],
  ): TransferPlan {
    const backup = this.journal().backup;
    if (!backup) throw new Error("No previous settings import to restore");
    const before = this.backend.readMain();
    if (currentInterface)
      currentInterface = validateInterfacePreferences(currentInterface);
    const portable = createSettingsExport(backup.before);
    const source = selectSettingsTransfer(
      backup.preferences
        ? {
            ...portable,
            version: 2,
            sections: [...TRANSFER_SECTIONS],
            interfacePreferences: backup.preferences,
          }
        : portable,
      sections,
    );
    const after = planSettingsImport(before, source).next;
    if (sections.includes("categories")) {
      const prior = new Set(
        backup.before.categories.map((category) => category.id),
      );
      const imported = new Map(
        backup.after.categories
          .filter((category) => !prior.has(category.id))
          .map((category) => [category.id, category]),
      );
      const references = this.backend.categoryReferences();
      after.categories = [
        ...backup.before.categories,
        ...before.categories.filter(
          (category) =>
            !prior.has(category.id) &&
            (!imported.has(category.id) ||
              references.has(category.id) ||
              !same(category, imported.get(category.id))),
        ),
      ];
    }
    const afterInterface =
      currentInterface && backup.preferences
        ? selectInterfacePreferences(
            currentInterface,
            backup.preferences,
            sections,
          )
        : currentInterface;
    if (
      backup.preferences &&
      sections.includes("appearance") &&
      afterInterface
    ) {
      const appearance = interfaceAppearance(afterInterface);
      after.nativeAppearance = {
        acrylic: appearance.acrylic,
        material: appearance.nativeMaterial,
      };
    }
    return this.plan(
      "restore",
      before,
      after,
      currentInterface,
      afterInterface,
    );
  }

  begin(plan: TransferPlan): void {
    const record = this.journal();
    if (record.pending || !sameMain(this.backend.readMain(), plan.before))
      throw new Error(
        "Settings changed during the import preview. Open the file again to review the latest changes.",
      );
    const kept = new Set(plan.after.categories.map((category) => category.id));
    const references = this.backend.categoryReferences();
    if (
      plan.before.categories.some(
        (category) => !kept.has(category.id) && references.has(category.id),
      )
    )
      throw new Error("Category assignments changed during the preview");
    this.save({ ...record, pending: { ...plan, phase: "prepared" } });
    try {
      this.backend.writeMain(plan.after, plan.before);
    } catch (error) {
      if (sameMain(this.backend.readMain(), plan.before)) this.save(record);
      throw error;
    }
  }

  finish(id: string, preferences: InterfacePreferences | null): void {
    const record = this.journal(),
      pending = record.pending;
    if (
      !pending ||
      pending.id !== id ||
      pending.phase !== "prepared" ||
      !sameMain(this.backend.readMain(), pending.after) ||
      !same(
        preferences && validateInterfacePreferences(preferences),
        pending.afterInterface,
      )
    )
      throw new Error("Settings transfer confirmation is stale");
    this.save({
      version: 1,
      pending: null,
      backup:
        pending.kind === 'profile' ? record.backup : pending.kind === "import"
          ? {
              at: pending.at,
              before: pending.before,
              after: pending.after,
              preferences: pending.beforeInterface,
            }
          : null,
    });
  }

  /** Called before main startup reads settings and again on an explicit retry. */
  recoverMain(): {
    id: string;
    preferences: InterfacePreferences | null;
  } | null {
    const record = this.journal(),
      pending = record.pending;
    if (!pending) return null;
    const current = this.backend.readMain();
    if (!sameMain(current, pending.before)) {
      if (!sameMain(current, pending.after))
        throw new Error(
          "Settings changed after an interrupted transfer; recovery needs review",
        );
      this.backend.writeMain(
        keepCurrentSecrets(pending.before, current),
        current,
      );
    }
    this.save({
      ...record,
      pending: { ...pending, phase: "recover-interface" },
    });
    return { id: pending.id, preferences: pending.beforeInterface };
  }

  abort(
    id: string,
    preserveInterface?: InterfacePreferences,
  ): { id: string; preferences: InterfacePreferences | null } {
    const record = this.journal();
    if (record.pending?.id !== id) throw new Error("Stale settings transfer");
    if (preserveInterface)
      this.save({
        ...record,
        pending: {
          ...record.pending,
          beforeInterface: validateInterfacePreferences(preserveInterface),
        },
      });
    return this.recoverMain()!;
  }

  finishRecovery(id: string, preferences: InterfacePreferences | null): void {
    const record = this.journal(),
      pending = record.pending;
    if (
      !pending ||
      pending.phase !== "recover-interface" ||
      pending.id !== id ||
      !sameMain(this.backend.readMain(), pending.before) ||
      !same(
        preferences && validateInterfacePreferences(preferences),
        pending.beforeInterface,
      )
    )
      throw new Error("Settings recovery is incomplete");
    this.save({ ...record, pending: null });
  }
}
