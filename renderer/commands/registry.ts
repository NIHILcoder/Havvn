/** Local commands only. Every handler is an explicitly registered capability. */
export type CommandGroup =
  "pages" | "actions" | "settings" | "downloads" | "rooms" | "views";
export interface Command {
  id: string;
  title: string;
  description?: string;
  keywords: string[];
  group: CommandGroup;
  disabledReason: () => string | null;
  run: () => void | Promise<void>;
}

export const normalizeCommandQuery = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();

export function searchCommands(
  commands: readonly Command[],
  query: string,
): Command[] {
  const normalized = normalizeCommandQuery(query);
  const terms = normalized.split(" ").filter(Boolean);
  return commands
    .map((command, order) => {
      const title = normalizeCommandQuery(command.title);
      const text = normalizeCommandQuery(
        [command.title, command.description, ...command.keywords].join(" "),
      );
      if (!terms.every((term) => text.includes(term))) return null;
      const score = !normalized
        ? 0
        : title === normalized
          ? 100
          : title.startsWith(normalized)
            ? 80
            : title.includes(normalized)
              ? 60
              : terms.every((term) => title.includes(term))
                ? 40
                : 20;
      return { command, score, order };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((item) => item.command);
}

/** Resolve again at activation: the result shown to the user may have vanished. */
export async function executeCommand(
  id: string,
  getCommands: () => readonly Command[],
  missing: string,
): Promise<void> {
  const command = getCommands().find((item) => item.id === id);
  if (!command) throw new Error(missing);
  const reason = command.disabledReason();
  if (reason) throw new Error(reason);
  await command.run();
}
