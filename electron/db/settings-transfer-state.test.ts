import { describe, expect, it } from "vitest";
import { WORKING_PROFILES_KEY, emptyWorkingProfiles, readProfileNotifications } from '../../shared/working-profile-schema';
import type { AppSettings, PrivacyConfig } from "../../shared/types";
import {
  TRANSFER_SECTIONS,
  captureInterfacePreferences,
  type InterfacePreferences,
} from "../../shared/interface-preferences";
import type { SettingsImportState } from "../../shared/settings-transfer";
import {
  SettingsTransferState,
  selectSettingsTransfer,
} from "./settings-transfer-state";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const category = (id: string, name = id) => ({
  id,
  name,
  icon: "folder",
  color: "#123456",
});
export function preferences(theme = "dark"): InterfacePreferences {
  return captureInterfacePreferences({
    getItem: (key) => (key === "theme" ? theme : null),
  });
}
function fixture() {
  let main: SettingsImportState = {
    settings: {
      id: 1,
      maxDownKbps: 10,
      portMin: 6881,
      portMax: 6889,
      proxyPassword: "enc:v1:proxy",
      customTurnCredential: "enc:v1:turn",
      webRemoteToken: "local",
      updatedAt: new Date(0),
    } as AppSettings,
    categories: [category("movies")],
    scheduler: { enabled: false, schedules: [] },
    privacyConfig: { vpnCheck: true } as PrivacyConfig,
    nativeAppearance: { acrylic: false, material: "acrylic" },
  };
  main = clone(main);
  let record: unknown = null,
    mainFailure = false,
    journalFailures = 0;
  const references = new Set<string>();
  const backend = {
    read: () => clone(record),
    write: (value: unknown) => {
      if (journalFailures > 0) {
        journalFailures--;
        throw new Error("journal full");
      }
      record = clone(value);
    },
    readMain: () => clone(main),
    writeMain: (next: SettingsImportState, expected: SettingsImportState) => {
      if (mainFailure) throw new Error("config full");
      if (JSON.stringify(main) !== JSON.stringify(expected))
        throw new Error("stale");
      main = clone(next);
    },
    categoryReferences: () => references,
  };
  return {
    controller: new SettingsTransferState(backend),
    backend,
    references,
    get main() {
      return clone(main);
    },
    set main(value: SettingsImportState) {
      main = clone(value);
    },
    get record() {
      return clone(record);
    },
    set record(value: unknown) {
      record = clone(value);
    },
    set failMain(value: boolean) {
      mainFailure = value;
    },
    set failJournal(value: number) {
      journalFailures = value;
    },
  };
}
const incoming = () => ({
  version: 2,
  sections: [...TRANSFER_SECTIONS],
  settings: { maxDownKbps: 777 },
  categories: [category("movies", "Фильмы"), category("new")],
  interfacePreferences: preferences("light"),
});
function commit(f: ReturnType<typeof fixture>) {
  const plan = f.controller.planImport(incoming(), preferences(), [
    ...TRANSFER_SECTIONS,
  ]);
  f.controller.begin(plan);
  f.controller.finish(plan.id, plan.afterInterface);
  return plan;
}

function profileRequest(f: ReturnType<typeof fixture>, current = preferences()) {
  const notifications = readProfileNotifications(f.main.settings);
  current.values[WORKING_PROFILES_KEY] = JSON.stringify({ ...emptyWorkingProfiles(), profiles: [{ id: 'p1', name: 'Quiet', values: {
    startPage: 'rooms', viewId: null, appearanceName: null, panels: { sidebar: false, statusBar: true }, notifications: { ...notifications, enableSounds: false },
  } }] });
  return { current, request: { id: 'p1', expected: current, notifications } };
}

describe('working profiles in the durable settings journal', () => {
  it('changes only profile-owned settings and keeps the settings-import backup available', () => {
    const f = fixture(), imported = commit(f), backupAt = f.controller.status().backupAt;
    const { current, request } = profileRequest(f, imported.afterInterface!);
    const before = f.main, plan = f.controller.planWorkingProfile(current, request);
    f.controller.begin(plan); f.controller.finish(plan.id, plan.afterInterface);
    expect(f.main.settings.enableSounds).toBe(false); expect(f.main.settings.maxDownKbps).toBe(before.settings.maxDownKbps);
    expect(f.main.categories).toEqual(before.categories); expect(f.main.privacyConfig).toEqual(before.privacyConfig); expect(f.main.scheduler).toEqual(before.scheduler);
    expect(f.main.settings.proxyPassword).toBe(before.settings.proxyPassword);
    expect(f.controller.status().backupAt).toBe(backupAt);
    const restore = f.controller.planRestore(plan.afterInterface, ['settings']); f.controller.begin(restore); f.controller.finish(restore.id, restore.afterInterface);
    expect(f.main.settings.maxDownKbps).toBe(10);
  });
  it('rejects stale notifications and interface previews before writing either store', () => {
    const f = fixture(), { current, request } = profileRequest(f);
    expect(() => f.controller.planWorkingProfile({ ...current, values: { ...current.values, startPage: 'rooms' } }, request)).toThrow('stale');
    f.main = { ...f.main, settings: { ...f.main.settings, enableSounds: false } };
    expect(() => f.controller.planWorkingProfile(current, request)).toThrow('stale'); expect(f.record).toBeNull();
  });
  it('recovers a crash between the two stores and retains all non-profile data', () => {
    const f = fixture(), before = f.main, { current, request } = profileRequest(f), plan = f.controller.planWorkingProfile(current, request);
    f.controller.begin(plan);
    const restarted = new SettingsTransferState(f.backend), recovery = restarted.recoverMain()!;
    expect(f.main).toEqual(before); expect(recovery.preferences).toEqual(current);
    restarted.finishRecovery(recovery.id, recovery.preferences); expect(restarted.status().recoveryNeeded).toBe(false);
  });
  it('does not create an operation when the settings write fails', () => {
    const f = fixture(), { current, request } = profileRequest(f), plan = f.controller.planWorkingProfile(current, request); f.failMain = true;
    expect(() => f.controller.begin(plan)).toThrow('config full'); expect(f.controller.status().recoveryNeeded).toBe(false);
  });
});

describe("durable settings transfer journal", () => {
  it("retains the previous main/UI snapshot only after both stores confirm success", () => {
    const f = fixture(),
      before = f.main,
      plan = f.controller.planImport(incoming(), preferences(), [
        ...TRANSFER_SECTIONS,
      ]);
    f.controller.begin(plan);
    expect(f.main.settings.maxDownKbps).toBe(777);
    expect(f.controller.status()).toMatchObject({
      backupAt: null,
      recoveryNeeded: true,
    });
    expect(() => f.controller.finish(plan.id, preferences("dark"))).toThrow(
      "stale",
    );
    f.controller.finish(plan.id, plan.afterInterface);
    expect(f.controller.status()).toMatchObject({
      recoveryNeeded: false,
      backupAt: expect.any(String),
    });
    expect(
      (f.record as { backup: { before: SettingsImportState } }).backup.before
        .categories,
    ).toEqual(before.categories);
    for (const secret of [
      "proxyPassword",
      "customTurnCredential",
      "webRemoteToken",
      "enc:v1:",
    ])
      expect(JSON.stringify(f.record)).not.toContain(secret);
  });
  it("honours both the selected mask and the sections declared in the file", () => {
    const f = fixture();
    f.main = {
      ...f.main,
      nativeAppearance: { acrylic: true, material: "mica" },
    };
    const input = {
      version: 2,
      sections: ["hotkeys"],
      settings: { maxDownKbps: 999 },
      interfacePreferences: preferences("light"),
    };
    const plan = f.controller.planImport(input, preferences(), [
      ...TRANSFER_SECTIONS,
    ]);
    expect(plan.after.settings.maxDownKbps).toBe(10);
    expect(plan.afterInterface?.values.theme).toBe("dark");
    expect(plan.after.nativeAppearance).toEqual({
      acrylic: true,
      material: "mica",
    });
    expect(() =>
      selectSettingsTransfer({ version: 1, settings: {} }, ["appearance"]),
    ).toThrow("none");
  });
  it("reads legacy files without changing interface preferences", () => {
    const f = fixture(),
      ui = preferences();
    const plan = f.controller.planImport(
      { version: 1, settings: { maxDownKbps: 100 } },
      ui,
      [...TRANSFER_SECTIONS],
    );
    expect(plan.afterInterface).toEqual(ui);
    expect(plan.after.settings.maxDownKbps).toBe(100);
  });
  it("does not duplicate even legacy plaintext credentials in its recovery journal", () => {
    const f = fixture();
    f.main = {
      ...f.main,
      settings: {
        ...f.main.settings,
        proxyPassword: "legacy-plaintext-secret",
      },
    };
    commit(f);
    expect(JSON.stringify(f.record)).not.toContain("legacy-plaintext-secret");
    const restore = f.controller.planRestore(preferences("light"), [
      ...TRANSFER_SECTIONS,
    ]);
    expect(restore.after.settings.proxyPassword).toBe(
      "legacy-plaintext-secret",
    );
  });
  it("restores only a UI section without requiring any main section", () => {
    const f = fixture();
    commit(f);
    const plan = f.controller.planRestore(preferences("light"), ["hotkeys"]);
    expect(plan.after.settings.maxDownKbps).toBe(777);
    expect(plan.afterInterface?.values.theme).toBe("light");
  });
  it("writes no config if the journal cannot be prepared, and keeps the previous backup on a config failure", () => {
    const f = fixture();
    commit(f);
    const backup = f.record,
      before = f.main;
    let plan = f.controller.planImport(incoming(), preferences("light"), [
      ...TRANSFER_SECTIONS,
    ]);
    f.failJournal = 1;
    expect(() => f.controller.begin(plan)).toThrow("journal full");
    expect(f.main).toEqual(before);
    expect(f.record).toEqual(backup);
    plan = f.controller.planImport(incoming(), preferences("light"), [
      ...TRANSFER_SECTIONS,
    ]);
    f.failMain = true;
    expect(() => f.controller.begin(plan)).toThrow("config full");
    expect(f.main).toEqual(before);
    expect(f.record).toEqual(backup);
  });
  it("recovers a prepared operation both before and after its main write", () => {
    for (const mainWasWritten of [false, true]) {
      const f = fixture(),
        before = f.main,
        plan = f.controller.planImport(incoming(), preferences(), [
          ...TRANSFER_SECTIONS,
        ]);
      f.record = {
        version: 1,
        pending: { ...plan, phase: "prepared" },
        backup: null,
      };
      if (mainWasWritten) f.main = plan.after;
      const restarted = new SettingsTransferState(f.backend),
        recovery = restarted.recoverMain()!;
      expect(f.main).toEqual(before);
      expect(recovery.preferences).toEqual(preferences());
      expect(restarted.status().recoveryNeeded).toBe(true);
      restarted.finishRecovery(recovery.id, recovery.preferences);
      expect(restarted.status().recoveryNeeded).toBe(false);
    }
  });
  it("recovers if final journal confirmation fails and keeps the original snapshot", () => {
    const f = fixture(),
      before = f.main,
      plan = f.controller.planImport(incoming(), preferences(), [
        ...TRANSFER_SECTIONS,
      ]);
    f.controller.begin(plan);
    f.failJournal = 1;
    expect(() => f.controller.finish(plan.id, plan.afterInterface)).toThrow(
      "journal full",
    );
    const recovery = f.controller.recoverMain()!;
    expect(f.main).toEqual(before);
    expect(() =>
      f.controller.finishRecovery("wrong-id", recovery.preferences),
    ).toThrow();
    expect(() =>
      f.controller.finishRecovery(recovery.id, preferences("light")),
    ).toThrow();
    f.controller.finishRecovery(recovery.id, recovery.preferences);
  });
  it("does not overwrite unrelated main changes after an interrupted transfer", () => {
    const f = fixture(),
      plan = f.controller.planImport(incoming(), preferences(), [
        ...TRANSFER_SECTIONS,
      ]);
    f.controller.begin(plan);
    f.main = { ...f.main, settings: { ...f.main.settings, maxUpKbps: 42 } };
    const record = f.record,
      current = f.main;
    expect(() => f.controller.recoverMain()).toThrow("needs review");
    expect(f.record).toEqual(record);
    expect(f.main).toEqual(current);
  });
  it("restores previous settings, preserves current credentials and consumes the single recovery copy", () => {
    const f = fixture();
    commit(f);
    f.main = {
      ...f.main,
      settings: { ...f.main.settings, proxyPassword: "enc:v1:new-secret" },
    };
    const restore = f.controller.planRestore(preferences("light"), [
      ...TRANSFER_SECTIONS,
    ]);
    expect(restore.after.settings.maxDownKbps).toBe(10);
    expect(restore.after.settings.proxyPassword).toBe("enc:v1:new-secret");
    expect(restore.after.categories).toEqual([category("movies")]);
    expect(restore.afterInterface).toEqual(preferences());
    f.controller.begin(restore);
    f.controller.finish(restore.id, restore.afterInterface);
    expect(f.controller.status().backupAt).toBeNull();
    expect(() =>
      f.controller.planRestore(preferences(), [...TRANSFER_SECTIONS]),
    ).toThrow("No previous");
  });
  it("preserves categories with new assignments, manual edits or categories created after importing", () => {
    const f = fixture();
    commit(f);
    f.references.add("new");
    f.main = {
      ...f.main,
      categories: [...f.main.categories, category("later")],
    };
    expect(
      f.controller
        .planRestore(preferences("light"), [...TRANSFER_SECTIONS])
        .after.categories.map((c) => c.id),
    ).toEqual(["movies", "new", "later"]);
    f.references.clear();
    f.main = {
      ...f.main,
      categories: f.main.categories.map((c) =>
        c.id === "new" ? { ...c, name: "Edited later" } : c,
      ),
    };
    expect(
      f.controller
        .planRestore(preferences("light"), [...TRANSFER_SECTIONS])
        .after.categories.find((c) => c.id === "new")?.name,
    ).toBe("Edited later");
  });
  it("refuses restoration if a category gains an assignment while its preview is open", () => {
    const f = fixture();
    commit(f);
    const restore = f.controller.planRestore(preferences("light"), [
      ...TRANSFER_SECTIONS,
    ]);
    f.references.add("new");
    expect(() => f.controller.begin(restore)).toThrow("assignments changed");
    expect(f.controller.status().recoveryNeeded).toBe(false);
  });
  it("keeps corrupt recovery data untouched", () => {
    const f = fixture();
    f.record = { version: 99, pending: null, backup: null };
    const original = f.record;
    expect(f.controller.status()).toEqual({
      backupAt: null,
      recoveryNeeded: true,
      error: true,
    });
    expect(() => f.controller.recoverMain()).toThrow();
    expect(f.record).toEqual(original);
  });
});
