import { SETTINGS_SEARCH_ENTRIES } from "../pages/settings/settingsSearchCatalog";
import type { CommandContext } from "./appCommands";
import { createNavigationCommands } from './navigationCommands';
import type { Command } from "./registry";

/** Built only while the lazy palette is open; no extra IPC or network indexing. */
export function createPaletteCommands(ctx: CommandContext): Command[] {
  const { t } = ctx;
  const commands = createNavigationCommands(ctx);
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    commands.push({
      id: `setting:${entry.section}:${entry.labelKey}`,
      title: t(entry.labelKey),
      description: `${t("nav.settings")} › ${t(`settings.${entry.section}` as Parameters<typeof t>[0])}`,
      keywords: [
        entry.descriptionKey ? t(entry.descriptionKey) : "",
        entry.parentKey ? t(entry.parentKey) : "",
        entry.section,
      ],
      group: "settings",
      disabledReason: () => null,
      run: () => ctx.navigate({ kind: "setting", entry }),
    });
  }
  for (const download of ctx.getDownloads()) {
    const getLive = () => ctx.getDownloads().find((d) => d.id === download.id);
    const disabledReason = () => (getLive() ? null : t("commands.missing"));
    commands.push({
      id: `download:${download.id}`,
      title: download.name,
      description: t("nav.downloads"),
      keywords: ["download", "torrent", download.id],
      group: "downloads",
      disabledReason,
      run: () => {
        if (!getLive()) throw new Error(t("commands.missing"));
        ctx.navigate({ kind: "download", id: download.id });
      },
    });
    commands.push({
      id: `folder:${download.id}`,
      title: `${t("downloads.openFolder")}: ${download.name}`,
      description: t("nav.downloads"),
      keywords: [download.name, "folder"],
      group: "downloads",
      disabledReason: () =>
        disabledReason() ||
        (getLive()?.savePath ? null : t("commands.noFolder")),
      run: async () => {
        const live = getLive();
        if (!live?.savePath) throw new Error(t("commands.missing"));
        await ctx.api.openPath(live.savePath);
      },
    });
  }
  return commands;
}
