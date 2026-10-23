import {
  captureInterfacePreferences,
  validateInterfacePreferences,
  writeInterfacePreferences,
  type PreferencesStorage,
  type SettingsTransferOptions,
  type SettingsTransferStep,
} from "../shared/interface-preferences";

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  sendSync(channel: string, ...args: unknown[]): unknown;
}

/** Runs in preload, before App/early theme startup when a recovery is pending. */
export function createSettingsTransferClient(
  bridge: Bridge,
  storage: PreferencesStorage,
) {
  let busy = false;
  const recover = () => {
    const result = bridge.sendSync("settings:recovery:get") as
      { id?: string; preferences?: unknown; error?: boolean } | undefined;
    if (result?.error)
      throw new Error(
        "Settings recovery is unavailable. The saved snapshots have been kept.",
      );
    if (!result?.id) return { success: true };
    const preferences = result.preferences
      ? validateInterfacePreferences(result.preferences)
      : null;
    if (preferences) writeInterfacePreferences(storage, preferences);
    const acknowledgement = bridge.sendSync(
      "settings:recovery:finish",
      result.id,
      preferences,
    ) as { success?: boolean } | undefined;
    if (!acknowledgement?.success)
      throw new Error("Settings recovery could not be confirmed");
    return { success: true };
  };
  const run = async (
    channel: "settings:import" | "settings:restore" | 'settings:working-profile',
    options?: SettingsTransferOptions,
    profile?: import('../shared/working-profiles').WorkingProfileRequest,
  ) => {
    if (busy) throw new Error("A settings transfer is already in progress");
    busy = true;
    try {
      const before = captureInterfacePreferences(storage);
      const result = (await bridge.invoke(
        channel,
        before,
        channel === 'settings:working-profile' ? profile : options,
      )) as SettingsTransferStep;
      if (!result.success || !result.id) return { success: result.success };
      let preserveInterface:
        ReturnType<typeof captureInterfacePreferences> | undefined;
      try {
        const current = captureInterfacePreferences(storage);
        if (JSON.stringify(current) !== JSON.stringify(before)) {
          preserveInterface = current;
          throw new Error("Interface preferences changed during the preview");
        }
        if (result.preferences)
          writeInterfacePreferences(storage, result.preferences);
        await bridge.invoke(
          "settings:transfer:finish",
          result.id,
          captureInterfacePreferences(storage),
        );
      } catch (error) {
        // Main rolls back first. Its durable journal retains the original UI if storage is still failing.
        await bridge.invoke(
          "settings:transfer:abort",
          result.id,
          preserveInterface,
        );
        recover();
        throw error;
      }
      return { success: true };
    } finally {
      busy = false;
    }
  };
  return {
    exportSettings: async (options?: SettingsTransferOptions) => {
      if (busy) throw new Error("A settings transfer is already in progress");
      busy = true;
      try {
        return (await bridge.invoke(
          "settings:export",
          captureInterfacePreferences(storage),
          options,
        )) as { success: boolean; path?: string };
      } finally {
        busy = false;
      }
    },
    importSettings: (options?: SettingsTransferOptions) =>
      run("settings:import", options),
    applyWorkingProfile: (request: import('../shared/working-profiles').WorkingProfileRequest) => run('settings:working-profile', undefined, request),
    restoreSettings: (options?: SettingsTransferOptions) =>
      run("settings:restore", options),
    recoverSettingsTransfer: async () => {
      if (busy) throw new Error("A settings transfer is already in progress");
      busy = true;
      try {
        return recover();
      } finally {
        busy = false;
      }
    },
  };
}
