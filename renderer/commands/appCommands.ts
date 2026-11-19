import type { Download, IpcApi, RoomSummary } from "../../shared/types";
import { canPause, canResume } from "../../shared/state-machine";
import type { PageId } from "../layout/Sidebar";
import type { SettingSearchEntry } from "../pages/settings/settingsSearch";
import type { Command } from "./registry";
import type { DownloadView } from "../../shared/download-views";
import { NAVIGATION_PAGES } from '../../shared/navigation';

export type Translate = (key: keyof typeof import("../i18n/en.json")) => string;
export type NavigationTarget =
  | { kind: "page"; page: PageId }
  | { kind: "download"; id: string }
  | { kind: "room"; id: string }
  | { kind: "download-view"; id: string }
  | { kind: "setting"; entry: SettingSearchEntry }
  | { kind: "first-steps" }
  | { kind: "watch-download"; id: string }
  | { kind: "room-task"; roomId?: string; action: 'create' | 'join' | 'files' | 'server' | 'lan' }
  | { kind: "add-torrent" };
export interface CommandContext {
  t: Translate;
  getDownloads: () => readonly Download[];
  getRooms: () => readonly RoomSummary[];
  getViews?: () => readonly DownloadView[];
  getVoice: () => { roomId: string; muted: boolean; deafened: boolean } | null;
  navigate: (target: NavigationTarget) => void;
  api: Pick<IpcApi, "pauseAll" | "resumeAll" | "openPath" | "rooms">;
}

export function createAppCommands(ctx: CommandContext): Command[] {
  const { t } = ctx;
  const commands: Command[] = NAVIGATION_PAGES.map(({ id: page, labelKey: key }) => ({
    id: page === "create-torrent" ? page : `open-${page}`,
    title: t(key),
    description: page === "search" ? t("commands.searchHint") : undefined,
    keywords: [page],
    group: "pages",
    disabledReason: () => null,
    run: () => ctx.navigate({ kind: "page", page }),
  }));
  commands.push({ id: 'open-first-steps', title: t('first.title'), keywords: ['help', 'onboarding', 'tutorial', 'помощь'],
    group: 'actions', disabledReason: () => null, run: () => ctx.navigate({ kind: 'first-steps' }) });
  commands.push({
    id: "add-torrent",
    title: t("btn.addTorrent"),
    keywords: ["torrent", "magnet"],
    group: "actions",
    disabledReason: () => null,
    run: () => ctx.navigate({ kind: "add-torrent" }),
  });
  for (const action of ["pause-all", "resume-all"] as const) {
    const pause = action === "pause-all";
    commands.push({
      id: action,
      title: t(pause ? "hotkeys.pauseAll" : "hotkeys.resumeAll"),
      keywords: ["torrent"],
      group: "actions",
      disabledReason: () =>
        ctx
          .getDownloads()
          .some((d) => (pause ? canPause(d.status) : canResume(d.status)))
          ? null
          : t(pause ? "downloads.nothingToPause" : "downloads.nothingToResume"),
      run: async () => {
        if (pause) await ctx.api.pauseAll();
        else await ctx.api.resumeAll();
      },
    });
  }
  for (const action of ["voice-mute", "voice-deafen"] as const) {
    commands.push({
      id: action,
      title: t(
        action === "voice-mute" ? "hotkeys.voiceMute" : "hotkeys.voiceDeafen",
      ),
      keywords: ["voice", "microphone"],
      group: "actions",
      disabledReason: () => (ctx.getVoice() ? null : t("commands.noVoice")),
      run: async () => {
        const call = ctx.getVoice();
        if (!call) throw new Error(t("commands.noVoice"));
        if (action === "voice-mute")
          await ctx.api.rooms.voice.mute(call.roomId, !call.muted);
        else await ctx.api.rooms.voice.deafen(call.roomId, !call.deafened);
      },
    });
  }
  return commands;
}
