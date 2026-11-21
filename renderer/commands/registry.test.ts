import { describe, expect, it, vi } from "vitest";
import en from "../i18n/en.json";
import ru from "../i18n/ru.json";
import type { Download, RoomSummary } from "../../shared/types";
import {
  executeCommand,
  normalizeCommandQuery,
  searchCommands,
} from "./registry";
import { createPaletteCommands } from "./paletteCommands";
import { createAppCommands, type CommandContext } from "./appCommands";
import { commandFavorite, createNavigationCommands } from './navigationCommands';
import { favoriteCommandId } from '../../shared/navigation';
import {
  DEFAULT_VIEW_CONFIG,
  type DownloadView,
} from "../../shared/download-views";

function fixture(dictionary = en) {
  let downloads = [
    {
      id: "d1",
      name: "Приём файлов",
      savePath: "D:/media",
      status: "downloading",
    },
  ] as Download[];
  let rooms = [{ roomId: "r1", name: "Кинозал" }] as RoomSummary[];
  let voice: ReturnType<CommandContext["getVoice"]> = null;
  const api = {
    pauseAll: vi.fn(),
    resumeAll: vi.fn(),
    openPath: vi.fn(),
    rooms: {
      list: vi.fn(async () => rooms),
      voice: { mute: vi.fn(), deafen: vi.fn() },
    },
  };
  const ctx: CommandContext = {
    t: (key) => dictionary[key],
    getDownloads: () => downloads,
    getRooms: () => rooms,
    getVoice: () => voice,
    navigate: vi.fn(),
    api: api as unknown as CommandContext["api"],
  };
  const getCommands = () => createPaletteCommands(ctx);
  const execute = (id: string) =>
    executeCommand(id, getCommands, ctx.t("commands.missing"));
  return {
    ctx,
    api,
    getCommands,
    execute,
    setDownloads: (next: Download[]) => {
      downloads = next;
    },
    setRooms: (next: RoomSummary[]) => {
      rooms = next;
    },
    setVoice: (next: typeof voice) => {
      voice = next;
    },
  };
}

describe("local command registry", () => {
  it('opens first steps through the shared registry without changing preferences or starting a task', async () => {
    const f = fixture();
    await f.execute('open-first-steps');
    expect(f.ctx.navigate).toHaveBeenCalledWith({ kind: 'first-steps' });
    expect(f.api.rooms.list).not.toHaveBeenCalled(); expect(f.api.pauseAll).not.toHaveBeenCalled();
  });
  it('shares favorite capabilities with the palette and excludes paths/settings/download actions', async () => {
    const f = fixture();
    f.ctx.getViews = () => [{ ...DEFAULT_VIEW_CONFIG, id: 'v1', name: 'Films', pinned: true }];
    const commands = createNavigationCommands(f.ctx), palette = f.getCommands();
    expect(commands.every(command => palette.some(item => item.id === command.id))).toBe(true);
    for (const command of commands) expect(favoriteCommandId(commandFavorite(command)!)).toBe(command.id);
    for (const command of palette.filter(item => ['settings', 'downloads', 'folders'].includes(item.group))) expect(commandFavorite(command)).toBeNull();
    expect(f.api.rooms.list).not.toHaveBeenCalled(); expect(f.api.pauseAll).not.toHaveBeenCalled();
    expect(f.ctx.navigate).not.toHaveBeenCalled();
    await expect(executeCommand('removeDownload:d1', () => commands, en['commands.missing'])).rejects.toThrow(en['commands.missing']);
    expect(f.ctx.navigate).not.toHaveBeenCalled();
  });
  it("navigates saved views by ID and rejects a deleted view from an old result list", async () => {
    const f = fixture();
    let views: DownloadView[] = [
      { ...DEFAULT_VIEW_CONFIG, id: "v1", name: "Films", pinned: true },
    ];
    f.ctx.getViews = () => views;
    const commands = f.getCommands();
    await f.execute("download-view:v1");
    expect(f.ctx.navigate).toHaveBeenCalledWith({
      kind: "download-view",
      id: "v1",
    });
    views = [];
    await expect(
      executeCommand(
        "download-view:v1",
        () => commands,
        en["commands.missing"],
      ),
    ).rejects.toThrow(en["commands.missing"]);
  });
  it("has stable unique IDs and translated labels in both languages", () => {
    for (const dictionary of [en, ru]) {
      const commands = fixture(dictionary).getCommands();
      expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length);
      expect(
        commands.every(
          (c) => c.title && !/^(commands|settings)\./.test(c.title),
        ),
      ).toBe(true);
    }
    expect(
      fixture(en)
        .getCommands()
        .map((c) => c.id),
    ).toEqual(
      fixture(ru)
        .getCommands()
        .map((c) => c.id),
    );
  });
  it("normalizes Russian ё, unicode width, case and whitespace", () => {
    expect(normalizeCommandQuery("  ПРИЁМ  Ａ ")).toBe("прием a");
    expect(
      searchCommands(fixture(ru).getCommands(), "файлов ПРИЕМ")[0].id,
    ).toBe("download:d1");
  });
  it("ranks an exact title ahead of descriptions and returns no unrelated results", () => {
    const commands = fixture().getCommands();
    expect(searchCommands(commands, en["settings.upSpeed"])[0].id).toBe(
      "setting:connection:settings.upSpeed",
    );
    expect(searchCommands(commands, "does-not-exist-123456")).toEqual([]);
    expect(searchCommands(commands, "  ")).toEqual(commands);
  });
  it("indexes object names and setting descriptions without making IPC calls", () => {
    const f = fixture(ru);
    for (const query of [
      "Кинозал",
      "Прием",
      ru["settings.closeTray.desc"],
      "magnet",
    ]) {
      expect(searchCommands(f.getCommands(), query).length).toBeGreaterThan(0);
    }
    expect(f.api.rooms.list).not.toHaveBeenCalled();
    expect(f.api.openPath).not.toHaveBeenCalled();
    expect(f.ctx.navigate).not.toHaveBeenCalled();
  });
  it("addresses settings, duplicate download names and pages by stable identity", async () => {
    const f = fixture();
    f.setDownloads([
      { id: "first", name: "same" },
      { id: "second", name: "same" },
    ] as Download[]);
    await f.execute("download:second");
    expect(f.ctx.navigate).toHaveBeenLastCalledWith({
      kind: "download",
      id: "second",
    });
    await f.execute("setting:connection:settings.upSpeed");
    expect(f.ctx.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "setting",
        entry: expect.objectContaining({
          labelKey: "settings.upSpeed",
          section: "connection",
        }),
      }),
    );
    await f.execute("open-search");
    expect(f.ctx.navigate).toHaveBeenLastCalledWith({
      kind: "page",
      page: "search",
    });
    expect(f.api.rooms.list).not.toHaveBeenCalled();
  });
  it("rejects a removed object from an old result list and never invokes its handler", async () => {
    const f = fixture();
    const old = f.getCommands();
    f.setDownloads([]);
    await expect(f.execute("download:d1")).rejects.toThrow(
      en["commands.missing"],
    );
    await expect(
      executeCommand("download:d1", () => old, "missing"),
    ).rejects.toThrow(en["commands.missing"]);
    expect(f.ctx.navigate).not.toHaveBeenCalled();
  });
  it("rechecks local room membership on activation, including stale sidebar data", async () => {
    const f = fixture();
    f.api.rooms.list.mockResolvedValueOnce([]);
    await expect(f.execute("room:r1")).rejects.toThrow(en["commands.missing"]);
    expect(f.ctx.navigate).not.toHaveBeenCalled();
    await f.execute("room:r1");
    expect(f.ctx.navigate).toHaveBeenCalledWith({ kind: "room", id: "r1" });
  });
  it("uses the current path when opening a download folder", async () => {
    const f = fixture();
    const old = f.getCommands();
    f.setDownloads([
      { id: "d1", name: "moved", savePath: "D:/new" },
    ] as Download[]);
    await executeCommand("folder:d1", () => old, "missing");
    expect(f.api.openPath).toHaveBeenCalledWith("D:/new");
  });
  it("exposes disabled reasons and checks torrent state again before running", async () => {
    const f = fixture();
    expect(
      createAppCommands(f.ctx)
        .find((c) => c.id === "pause-all")!
        .disabledReason(),
    ).toBeNull();
    f.setDownloads([]);
    await expect(f.execute("pause-all")).rejects.toThrow(
      en["downloads.nothingToPause"],
    );
    expect(f.api.pauseAll).not.toHaveBeenCalled();
  });
  it("uses current voice state rather than the state at search time", async () => {
    const f = fixture();
    await expect(f.execute("voice-mute")).rejects.toThrow(
      en["commands.noVoice"],
    );
    f.setVoice({ roomId: "r1", muted: true, deafened: false });
    await f.execute("voice-mute");
    await f.execute("voice-deafen");
    expect(f.api.rooms.voice.mute).toHaveBeenCalledWith("r1", false);
    expect(f.api.rooms.voice.deafen).toHaveBeenCalledWith("r1", true);
  });
  it("rejects unknown IDs instead of forwarding an arbitrary IPC operation", async () => {
    const f = fixture();
    await expect(f.execute("removeDownload:d1")).rejects.toThrow(
      en["commands.missing"],
    );
    expect(f.ctx.navigate).not.toHaveBeenCalled();
  });
});
