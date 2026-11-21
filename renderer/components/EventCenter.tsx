import { ErrorMessage } from './ErrorMessage';
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  eventActions,
  type AppEvent,
  type AppEventAction,
  type AppEventPage,
  type AppEventQuery,
  type AppEventTarget,
} from "../../shared/app-events";
import { useTranslation } from "../utils/i18nContext";
import "./EventCenter.css";

const EventCenter: React.FC<{
  onNavigate: (target: AppEventTarget) => void;
}> = ({ onNavigate }) => {
  const { t, language } = useTranslation();
  const [filter, setFilter] =
    useState<NonNullable<AppEventQuery["filter"]>>("all");
  const [page, setPage] = useState<AppEventPage | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const request = useRef(0),
    pending = useRef<string | null>(null),
    alive = useRef(true);
  const load = useCallback(
    async (cursor?: AppEventQuery["cursor"]) => {
      const sequence = ++request.current;
      setLoading(true);
      try {
        const next = await window.api.events.list({
          filter,
          ...(cursor ? { cursor } : {}),
        });
        if (!alive.current || request.current !== sequence) return;
        setPage((previous) =>
          cursor && previous
            ? {
                ...next,
                items: [
                  ...new Map(
                    [...previous.items, ...next.items].map((item) => [
                      item.id,
                      item,
                    ]),
                  ).values(),
                ],
              }
            : next,
        );
        setError("");
      } catch {
        if (alive.current && request.current === sequence)
          setError(t("events.loadFailed"));
      } finally {
        if (alive.current && request.current === sequence) setLoading(false);
      }
    },
    [filter, t],
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    alive.current = true;
    setPage(null);
    void loadRef.current();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.api.events?.onChanged?.(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void loadRef.current();
      }, 100);
    });
    return () => {
      alive.current = false;
      ++request.current;
      clearTimeout(timer);
      off?.();
    };
  }, [filter]);
  const perform = async (event: AppEvent, action: AppEventAction) => {
    if (pending.current) return;
    pending.current = event.id;
    setBusy(event.id);
    setError("");
    try {
      const result = await window.api.events.run(event.id, action);
      if (!alive.current) return;
      if (!result.ok) setError(t(`events.actionError.${result.reason}`));
      else if (result.target) onNavigate(result.target);
      else await loadRef.current();
    } catch {
      if (alive.current) setError(t("events.actionError.failed"));
    } finally {
      pending.current = null;
      if (alive.current) setBusy(null);
    }
  };
  const markRead = async (id: string | "all") => {
    if (pending.current) return;
    pending.current = id;
    setBusy(id);
    try {
      await window.api.events.read(id);
      if (alive.current) await loadRef.current();
    } catch {
      if (alive.current) setError(t("events.actionError.failed"));
    } finally {
      pending.current = null;
      if (alive.current) setBusy(null);
    }
  };
  return (
    <section className="event-center">
      <header className="event-center-head">
        <div>
          <h1>{t("events.title")}</h1>
          <p>
            {t("events.active")}: {page?.summary.active ?? 0} ·{" "}
            {t("events.unread")}: {page?.summary.unread ?? 0}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void markRead("all")}
          disabled={!!busy || !page?.summary.unread}
        >
          {t("events.readAll")}
        </button>
      </header>
      <div
        className="event-center-filters"
        role="group"
        aria-label={t("events.filters")}
      >
        {(["all", "problems", "unread"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {t(`events.filter.${value}`)}
          </button>
        ))}
      </div>
      <p className="event-center-note">{t("events.privacy")}</p>
      {page?.summary.storage === "unavailable" && (
        <p role="alert" className="event-center-warning">
          {t("events.storageUnavailable")}
        </p>
      )}
      {error && (
        <p role="alert" className="event-center-warning">
          <ErrorMessage error={error} />
          <button type="button" onClick={() => void loadRef.current()}>
            {t("events.reload")}
          </button>
        </p>
      )}
      <div className="event-center-scroll" aria-busy={loading}>
        <ul className="event-center-list">
          {page?.items.map((event) => {
            const unread = event.readAt === null || event.readAt < event.lastAt;
            return (
              <li
                key={event.id}
                className="event-center-item"
                data-event-id={event.id}
                data-problem={event.problem}
              >
                <div className="event-center-item-head">
                  <strong>{t(`events.code.${event.code}`)}</strong>
                  <span>{t(`events.problem.${event.problem}`)}</span>
                </div>
                <p>
                  {event.object.kind === "system"
                    ? t("events.system")
                    : `${t(`events.object.${event.object.kind}`)} · …${event.object.id.slice(-8)}`}
                  {event.params.reason
                    ? ` · ${t(`events.reason.${event.params.reason}`)}`
                    : ""}
                </p>
                <div className="event-center-meta">
                  <time dateTime={new Date(event.lastAt).toISOString()}>
                    {new Date(event.lastAt).toLocaleString(language)}
                  </time>
                  <span>×{event.count}</span>
                  <span>
                    {t(unread ? "events.unreadItem" : "events.readItem")}
                  </span>
                </div>
                <div className="event-center-actions">
                  {eventActions(event).map((action) => (
                    <button
                      type="button"
                      key={action}
                      disabled={!!busy}
                      onClick={() => void perform(event, action)}
                    >
                      {t(`events.action.${action}`)}
                    </button>
                  ))}
                  {unread && (
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => void markRead(event.id)}
                    >
                      {t("events.markRead")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {!loading && !page?.items.length && (
          <p className="event-center-empty">{t("events.empty")}</p>
        )}
        {loading && <p role="status">{t("events.loading")}</p>}
        {page?.next && (
          <button
            type="button"
            disabled={loading || !!busy}
            onClick={() => void loadRef.current(page.next ?? undefined)}
          >
            {t("events.more")}
          </button>
        )}
      </div>
    </section>
  );
};
export default EventCenter;
