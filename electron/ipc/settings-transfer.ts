import { BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as db from "../db/store";
import { t } from "../i18n";
import { recordAppEvent, resolveAppEvent } from '../services/app-events';
import { createOperationOwner } from '../../shared/operations';
import {
  INTERFACE_KEYS,
  TRANSFER_SECTIONS,
  selectInterfacePreferences,
  transferSections,
  validateInterfacePreferences,
  type InterfacePreferences,
  type SettingsTransferOptions,
} from "../../shared/interface-preferences";
import { selectSettingsTransfer } from "../db/settings-transfer-state";
import {
  createSettingsExport,
  planSettingsImport,
  validateSettingsTransfer,
  SETTINGS_TRANSFER_MAX_BYTES,
} from "../../shared/settings-transfer";

/** Bounded allocation even if the selected file grows after stat(). */
export async function readSettingsTransfer(
  filePath: string,
): Promise<ReturnType<typeof validateSettingsTransfer>> {
  const file = await fs.open(filePath, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > SETTINGS_TRANSFER_MAX_BYTES)
      throw new Error("Invalid or oversized settings file");
    const buffer = Buffer.alloc(SETTINGS_TRANSFER_MAX_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        used,
        buffer.length - used,
        used,
      );
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > SETTINGS_TRANSFER_MAX_BYTES)
      throw new Error("Settings file is too large");
    return validateSettingsTransfer(
      JSON.parse(buffer.subarray(0, used).toString("utf8")),
    );
  } finally {
    await file.close();
  }
}

/** A failed export leaves an existing backup intact. */
async function writeExport(filePath: string, content: string): Promise<void> {
  if (Buffer.byteLength(content) > SETTINGS_TRANSFER_MAX_BYTES)
    throw new Error("Settings export is too large");
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

export function notifyCategoriesChanged(): void {
  for (const target of BrowserWindow.getAllWindows()) {
    try {
      if (!target.isDestroyed()) target.webContents.send("categories:changed");
    } catch {
      /* A window can close after commit; invalidation must not turn a saved import into a failure. */
    }
  }
}

export function registerSettingsTransferIpc(
  getWindow: () => BrowserWindow,
): void {
  let busy = false;
  const trustedWindow = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const window = getWindow();
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new Error("Untrusted settings transfer request");
    }
    return window;
  };
  const acquire = () => {
    if (busy) throw new Error("A settings transfer is already in progress");
    busy = true;
  };
  const exportOperation = createOperationOwner(() => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('settings:export:changed');
  });
  ipcMain.handle('settings:export:operation', (event) => {
    trustedWindow(event);
    return exportOperation.snapshot();
  });

  ipcMain.handle(
    "settings:export",
    async (
      event,
      interfaceInput?: unknown,
      options?: SettingsTransferOptions,
    ) => {
      const window = trustedWindow(event);
      const sections = transferSections(options);
      const preferences =
        interfaceInput === undefined
          ? null
          : validateInterfacePreferences(interfaceInput);
      if (preferences && db.settingsTransfers.status().recoveryNeeded)
        throw new Error("Recover the interrupted settings transfer first");
      acquire();
      const attempt = exportOperation.start('choose-file', 'save-dialog', ['cancel-in-dialog']);
      try {
        const result = await dialog.showSaveDialog(window, {
          title: t("dialog.exportSettings"),
          defaultPath: "havvn-settings.json",
          filters: [{ name: t("dialog.filter.json"), extensions: ["json"] }],
        });
        if (result.canceled || !result.filePath) {
          exportOperation.finish(attempt, 'cancelled');
          return { success: false };
        }
        if (trustedWindow(event) !== window)
          throw new Error("Settings window changed");
        exportOperation.update(attempt, { stage: 'prepare-export', status: 'running', progress: null, waitingFor: null, actions: [] });
        const base = createSettingsExport(db.readSettingsImportState());
        let bundle;
        if (preferences) {
          const blank = {
            version: 1 as const,
            values: Object.fromEntries(
              INTERFACE_KEYS.map((key) => [key, null]),
            ),
          } as InterfacePreferences;
          const full = validateSettingsTransfer({
            ...base,
            version: 2,
            sections: [...TRANSFER_SECTIONS],
            interfacePreferences: preferences,
          });
          const selected = selectSettingsTransfer(full, sections);
          delete selected.interfacePreferences;
          bundle = validateSettingsTransfer({
            ...selected,
            version: 2,
            sections,
            ...(sections.some((section) =>
              ["appearance", "hotkeys", "layout"].includes(section),
            )
              ? {
                  interfacePreferences: selectInterfacePreferences(
                    blank,
                    preferences,
                    sections,
                  ),
                }
              : {}),
          });
        } else bundle = selectSettingsTransfer(base, sections);
        exportOperation.update(attempt, { stage: 'write-export', status: 'running', progress: null, waitingFor: null, actions: [] });
        await writeExport(result.filePath, JSON.stringify(bundle, null, 2));
        // Only the completed atomic write can confirm success, even if the UI closed.
        exportOperation.finish(attempt, 'succeeded');
        resolveAppEvent('settings-export-failed', { kind: 'system' });
        recordAppEvent('settings-exported', { kind: 'system' });
        return { success: true, path: result.filePath };
      } catch (error) {
        exportOperation.finish(attempt, 'failed');
        recordAppEvent('settings-export-failed', { kind: 'system' });
        throw error;
      } finally {
        busy = false;
      }
    },
  );

  ipcMain.handle(
    "settings:import",
    async (
      event,
      interfaceInput?: unknown,
      options?: SettingsTransferOptions,
    ) => {
      const window = trustedWindow(event);
      const sections = transferSections(options);
      const preferences =
        interfaceInput === undefined
          ? null
          : validateInterfacePreferences(interfaceInput);
      acquire();
      try {
        const result = await dialog.showOpenDialog(window, {
          title: t("dialog.importSettings"),
          properties: ["openFile"],
          filters: [{ name: t("dialog.filter.json"), extensions: ["json"] }],
        });
        if (result.canceled || !result.filePaths.length)
          return { success: false };
        const bundle = await readSettingsTransfer(result.filePaths[0]);
        if (trustedWindow(event) !== window)
          throw new Error("Settings window changed");
        const selected = selectSettingsTransfer(bundle, sections);
        if (selected.interfacePreferences && !preferences)
          throw new Error(
            "Use the current app window to import interface preferences",
          );
        const transaction = preferences
          ? db.settingsTransfers.planImport(bundle, preferences, sections)
          : null;
        const expected = transaction?.before ?? db.readSettingsImportState();
        const { changes } = planSettingsImport(expected, selected);
        const added = changes.filter((change) => !change.before).length,
          updated = changes.length - added;
        const display = (category: import('../../shared/types').Category) => {
          const defaults = category.downloadDefaults ?? {}, inherit = t('settings.transfer.inherit');
          const boolean = (value: boolean | undefined) => value === undefined ? inherit : t(value ? 'settings.transfer.yes' : 'settings.transfer.no');
          return `${category.name} [${category.id}] · ${category.icon} · ${category.color}\n  ${t('settings.transfer.categoryDefaults', {
            path: defaults.savePath ?? inherit, ratio: defaults.seedRatioLimit ?? inherit, minutes: defaults.seedTimeLimitMinutes ?? inherit,
            paused: boolean(defaults.paused), sequential: boolean(defaults.sequentialDownload),
            })}\n  ${t('settings.transfer.categoryNotifications', { popups: boolean(category.notificationRule?.popups), sound: boolean(category.notificationRule?.sound), content: boolean(category.notificationRule?.showContent) })}`;
        };
        const preview = changes
          .slice(0, 20)
          .map((change) =>
            change.before
              ? `${display(change.before)} → ${display(change.after)}`
              : `+ ${display(change.after)}`,
          )
          .join("\n");
        const detail = [
          t("settings.transfer.scope", {
            count: Object.keys(selected.settings).length,
            schedule: selected.scheduler
              ? t("settings.transfer.included")
              : t("settings.transfer.unchanged"),
            privacy: selected.privacyConfig
              ? t("settings.transfer.included")
              : t("settings.transfer.unchanged"),
          }),
          t("settings.transfer.categories", { added, updated }),
          t("settings.transfer.interface", {
            sections:
              (selected.sections ?? [])
                .filter((section) =>
                  ["appearance", "hotkeys", "layout"].includes(section),
                )
                .map((section) => t(`settings.transfer.section.${section}`))
                .join(", ") || t("settings.transfer.unchanged"),
          }),
          preview,
          changes.length > 20
            ? t("settings.transfer.more", { count: changes.length - 20 })
            : "",
          t("settings.transfer.notice"),
        ]
          .filter(Boolean)
          .join("\n\n");
        const confirmation = await dialog.showMessageBox(window, {
          type: "question",
          title: t("dialog.importSettings"),
          message: t("settings.transfer.review"),
          detail,
          buttons: [
            t("settings.transfer.cancel"),
            t("settings.transfer.apply"),
          ],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (confirmation.response !== 1) return { success: false };
        if (trustedWindow(event) !== window)
          throw new Error("Settings window changed");
        if (transaction) {
          db.settingsTransfers.begin(transaction);
          return {
            success: true,
            id: transaction.id,
            preferences: transaction.afterInterface,
          };
        }
        db.applySettingsImport(selected, expected);
        // Only an invalidation signal is broadcast; no settings or secrets leave main.
        notifyCategoriesChanged();
        return { success: true };
      } finally {
        busy = false;
      }
    },
  );

  ipcMain.handle(
    "settings:restore",
    async (
      event,
      interfaceInput: unknown,
      options?: SettingsTransferOptions,
    ) => {
      const window = trustedWindow(event);
      const preferences = validateInterfacePreferences(interfaceInput),
        sections = transferSections(options);
      acquire();
      try {
        const transaction = db.settingsTransfers.planRestore(
          preferences,
          sections,
        );
        const result = await dialog.showMessageBox(window, {
          type: "question",
          title: t("settings.transfer.restore"),
          message: t("settings.transfer.restoreReview"),
          detail: t("settings.transfer.restoreNotice", {
            sections: sections
              .map((section) => t(`settings.transfer.section.${section}`))
              .join(", "),
          }),
          buttons: [
            t("settings.transfer.cancel"),
            t("settings.transfer.restore"),
          ],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (result.response !== 1) return { success: false };
        if (trustedWindow(event) !== window)
          throw new Error("Settings window changed");
        db.settingsTransfers.begin(transaction);
        return {
          success: true,
          id: transaction.id,
          preferences: transaction.afterInterface,
        };
      } finally {
        busy = false;
      }
    },
  );
  ipcMain.handle('settings:working-profile', (event, interfaceInput: unknown, request: unknown) => {
    trustedWindow(event); acquire();
    try {
      const transaction = db.settingsTransfers.planWorkingProfile(validateInterfacePreferences(interfaceInput), request);
      db.settingsTransfers.begin(transaction);
      return { success: true, id: transaction.id, preferences: transaction.afterInterface };
    } finally { busy = false; }
  });
  ipcMain.handle("settings:transfer:status", (event) => {
    trustedWindow(event);
    return db.settingsTransfers.status();
  });
  ipcMain.handle(
    "settings:transfer:finish",
    (event, id: string, preferences: InterfacePreferences | null) => {
      trustedWindow(event);
      db.settingsTransfers.finish(id, preferences);
      notifyCategoriesChanged();
      return { success: true };
    },
  );
  ipcMain.handle(
    "settings:transfer:abort",
    (event, id: string, preserveInterface?: InterfacePreferences) => {
      trustedWindow(event);
      db.settingsTransfers.abort(id, preserveInterface);
      return { success: true };
    },
  );
  // Only the app shell enables synchronous startup recovery. No ordinary render update uses sync IPC.
  ipcMain.on?.("settings:recovery:get", (event) => {
    try {
      trustedWindow(event as Electron.IpcMainInvokeEvent);
      event.returnValue = db.settingsTransfers.recoverMain() ?? {};
    } catch {
      event.returnValue = { error: true };
    }
  });
  ipcMain.on?.(
    "settings:recovery:finish",
    (event, id: string, preferences: InterfacePreferences | null) => {
      try {
        trustedWindow(event as Electron.IpcMainInvokeEvent);
        db.settingsTransfers.finishRecovery(id, preferences);
        notifyCategoriesChanged();
        event.returnValue = { success: true };
      } catch {
        event.returnValue = { success: false };
      }
    },
  );
}
