import { ErrorMessage } from './ErrorMessage';
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "./Modal";
import { HostWindowProvider } from "../utils/hostWindow";
import { useDownloads } from "../state/downloads";
import { createPaletteCommands } from "../commands/paletteCommands";
import {
  executeCommand,
  searchCommands,
  type Command,
} from "../commands/registry";
import type { CommandContext } from "../commands/appCommands";
import { useDownloadViews } from "../utils/download-views";

interface Props {
  host: Window;
  getContext: () => CommandContext;
  onClose: () => void;
}

const Palette: React.FC<Props> = ({ host, getContext, onClose }) => {
  const context = getContext();
  const { t } = context;
  const downloads = useDownloads((s) => s.downloads);
  const savedViews = useDownloadViews();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  // Context is read again on every render and activation, including room updates.
  const rooms = context.getRooms();
  const voice = context.getVoice();
  const commands = useMemo(
    () => createPaletteCommands(getContext()),
    [getContext, downloads, rooms, voice, t, savedViews],
  );
  const matches = useMemo(
    () => searchCommands(commands, query),
    [commands, query],
  );
  const visible = matches.slice(0, 60);
  const activeIndex = Math.max(
    0,
    visible.findIndex((command) => command.id === selectedId),
  );
  const active = visible[activeIndex];

  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active?.id, query]);
  useEffect(() => {
    host.addEventListener("beforeunload", onClose);
    return () => host.removeEventListener("beforeunload", onClose);
  }, [host, onClose]);

  const activate = async (command: Command) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await executeCommand(
        command.id,
        () => createPaletteCommands(getContext()),
        t("commands.missing"),
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("commands.failed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("commands.title")}
      icon="search"
      size="lg"
      onClose={onClose}
      busy={busy}
      className="command-palette"
      bodyClassName="command-palette-body"
    >
      <input
        className="command-palette-input"
        type="search"
        role="combobox"
        aria-label={t("commands.placeholder")}
        placeholder={t("commands.placeholder")}
        autoComplete="off"
        spellCheck={false}
        readOnly={busy}
        value={query}
        aria-expanded="true"
        aria-controls="command-results"
        aria-activedescendant={
          active ? `command-result-${activeIndex}` : undefined
        }
        onChange={(e) => {
          setQuery(e.target.value);
          setSelectedId(null);
          setError("");
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (
            busyRef.current &&
            ["Enter", "Escape", "ArrowDown", "ArrowUp"].includes(e.key)
          ) {
            e.preventDefault();
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (visible.length)
              setSelectedId(
                visible[
                  (activeIndex +
                    (e.key === "ArrowDown" ? 1 : -1) +
                    visible.length) %
                    visible.length
                ].id,
              );
          } else if (e.key === "Home" && e.ctrlKey) {
            e.preventDefault();
            setSelectedId(visible[0]?.id ?? null);
          } else if (e.key === "End" && e.ctrlKey) {
            e.preventDefault();
            setSelectedId(visible[visible.length - 1]?.id ?? null);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (active) void activate(active);
          }
        }}
      />
      <p className="command-palette-privacy">{t("commands.localOnly")}</p>
      <div
        id="command-results"
        className="command-palette-results"
        role="listbox"
        aria-label={t("commands.results")}
        ref={list}
        aria-busy={busy}
      >
        {visible.map((command, index) => {
          const reason = command.disabledReason();
          return (
            <div
              key={command.id}
              id={`command-result-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              aria-disabled={!!reason || busy}
              className="command-palette-result"
              data-command-id={command.id}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setSelectedId(command.id)}
              onClick={() => void activate(command)}
            >
              <div className="command-palette-result-text">
                <span>{command.title}</span>
                <small>
                  {reason ||
                    command.description ||
                    t(`commands.group.${command.group}`)}
                </small>
              </div>
              <span className="command-palette-group">
                {t(`commands.group.${command.group}`)}
              </span>
            </div>
          );
        })}
        {!visible.length && (
          <p className="command-palette-empty">{t("commands.empty")}</p>
        )}
      </div>
      {error && (
        <p className="command-palette-error" role="alert">
          <ErrorMessage error={error} />
        </p>
      )}
      <div className="command-palette-footer">
        <span>{t("commands.help")}</span>
        <span role="status">
          {Math.min(60, matches.length)} / {matches.length}
        </span>
      </div>
    </Modal>
  );
};

const CommandPalette: React.FC<Props> = (props) =>
  props.host.closed
    ? null
    : createPortal(
        <HostWindowProvider window={props.host}>
          <Palette {...props} />
        </HostWindowProvider>,
        props.host.document.body,
      );
export default CommandPalette;
