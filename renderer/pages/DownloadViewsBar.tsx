import { ErrorMessage } from '../components/ErrorMessage';
import React, { useRef, useState } from "react";
import Button from "../components/Button";
import Icon from "../components/Icon";
import { Modal } from "../components/Modal";
import { Select } from "../components/Select";
import { NumberInput } from '../components/NumberInput';
import { useConfirm } from "../components/ConfirmDialog";
import { useTranslation } from "../utils/i18nContext";
import { categoryLabel, useCategories } from "../utils/useCategories";
import { downloadViews, useDownloadViews } from "../utils/download-views";
import {
  DOWNLOAD_VIEW_STATUSES,
  DownloadViewError,
  sameViewConfig,
  validateViewConfig,
  type DownloadViewConfig,
} from "../../shared/download-views";
import "./DownloadViewsBar.css";
import { activeDownloadConditions, clearDownloadCondition, type DownloadConditionKey } from '../../shared/download-filter-chips';
import { formatBytes } from '../utils/format-helpers';

const DownloadViewsBar: React.FC<{
  config: DownloadViewConfig;
  onApply: (config: DownloadViewConfig) => void;
}> = ({ config, onApply }) => {
  const { t } = useTranslation(),
    categories = useCategories(),
    { catalog, error: storageError } = useDownloadViews();
  const active = catalog.views.find((view) => view.id === catalog.activeId);
  const [dialog, setDialog] = useState<"save" | "rename" | "filters" | null>(
    null,
  );
  const [name, setName] = useState(""),
    [pinned, setPinned] = useState(true),
    [error, setError] = useState("");
  const [draft, setDraft] = useState(config.conditions),
    [min, setMin] = useState(""),
    [max, setMax] = useState("");
  const { confirm } = useConfirm();
  const changed = !!active && !sameViewConfig(active, config);
  const root = useRef<HTMLDivElement>(null), conditionKeys = activeDownloadConditions(config.conditions);
  const clear = (key?: DownloadConditionKey) => {
    onApply({ ...config, conditions: clearDownloadCondition(config.conditions, key) });
    requestAnimationFrame(() => (root.current?.querySelector<HTMLButtonElement>('.download-filter-chip')
      ?? root.current?.querySelector<HTMLButtonElement>('.download-views-toolbar button'))?.focus());
  };
  const conditionLabel = (key: DownloadConditionKey) => t(`views.chip.${key}`);
  const conditionValue = (key: DownloadConditionKey): string => {
    const value = config.conditions[key];
    if (key === 'status') return t(`filter.${config.conditions.status}`);
    if (key === 'category') return value === null ? t('views.categoryNone') : categories.some(category => category.id === value)
      ? categoryLabel(categories, String(value)) ?? t('views.categoryMissing') : t('views.categoryMissing');
    return typeof value === 'number' ? formatBytes(value) : String(value ?? '');
  };
  const attempt = (action: () => void) => {
    try {
      action();
      setError("");
      return true;
    } catch (cause) {
      setError(
        t(
          `views.error.${cause instanceof DownloadViewError ? cause.code : "storage"}`,
        ),
      );
      return false;
    }
  };
  const close = () => {
    setDialog(null);
    setError("");
  };
  const missingCategory =
    config.conditions.category &&
    !categories.some((category) => category.id === config.conditions.category);
  const categoryOptions = [
    { value: "all", label: t("views.categoryAll") },
    { value: "none", label: t("views.categoryNone") },
    ...categories.map((category) => ({
      value: `id:${category.id}`,
      label: categoryLabel(categories, category.id) ?? category.name,
    })),
  ];
  if (
    typeof draft.category === "string" &&
    !categories.some((category) => category.id === draft.category)
  )
    categoryOptions.push({
      value: `id:${draft.category}`,
      label: t("views.categoryMissing"),
    });
  return (
    <div className="download-views" ref={root}>
      <div className="download-views-toolbar">
        <Select
          ariaLabel={t("views.title")}
          className="download-views-select"
          value={catalog.activeId ?? ""}
          options={[
            { value: "", label: t("views.current") },
            ...catalog.views.map((view) => ({
              value: view.id,
              label: view.name,
            })),
          ]}
          onChange={(id) => attempt(() => downloadViews.select(id || null))}
        />
        <Button
          size="sm"
          variant="secondary"
          icon={<Icon name="filter" size={14} />}
          onClick={() => {
            setDraft({ ...config.conditions });
            setMin(
              config.conditions.minBytes === undefined
                ? ""
                : String(config.conditions.minBytes / 1048576),
            );
            setMax(
              config.conditions.maxBytes === undefined
                ? ""
                : String(config.conditions.maxBytes / 1048576),
            );
            setError("");
            setDialog("filters");
          }}
        >
          {t("views.conditions")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={storageError}
          onClick={() => {
            setName("");
            setPinned(true);
            setError("");
            setDialog("save");
          }}
        >
          {t("views.save")}
        </Button>
        {active && (
          <>
            {changed && (
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  attempt(() => {
                    downloadViews.save(
                      active.name,
                      config,
                      active.pinned,
                      active.id,
                    );
                  })
                }
              >
                {t("views.update")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setName(active.name);
                setError("");
                setDialog("rename");
              }}
            >
              {t("views.rename")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={active.pinned}
              onClick={() => attempt(() => downloadViews.pin(active.id))}
            >
              {t(active.pinned ? "views.unpin" : "views.pin")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void confirm({
                  title: t("views.delete"),
                  message: `${t("views.deleteConfirm")} «${active.name}»`,
                  danger: true,
                }).then((ok) => {
                  if (ok) attempt(() => downloadViews.remove(active.id));
                });
              }}
            >
              {t("views.delete")}
            </Button>
          </>
        )}
        {changed && (
          <span className="download-views-note">{t("views.modified")}</span>
        )}
      </div>
      {conditionKeys.length > 0 && <div className="download-active-filters" role="group" aria-label={t('views.activeFilters')}>
        <div className="download-active-filters-heading"><span>{t('views.activeCount').replace('{count}', String(conditionKeys.length))}</span>
          <Button size="sm" variant="ghost" onClick={() => clear()}>{t('views.clearFilters')}</Button></div>
        <div className="download-filter-chips">{conditionKeys.map(key => {
          const label = conditionLabel(key), value = conditionValue(key);
          return <Button key={key} size="sm" variant="secondary" className="download-filter-chip" data-filter-key={key}
            title={`${label}: ${value}`} aria-label={t('views.clearCondition').replace('{label}', label).replace('{value}', value)} onClick={() => clear(key)}>
            <span>{label}: {value}</span><Icon name="x" size={12} />
          </Button>;
        })}</div>
      </div>}
      {missingCategory && (
        <p className="download-views-note">{t("views.categoryMissingHint")}</p>
      )}
      {storageError && (
        <p role="alert" className="download-views-error">
          {t("views.storageUnreadable")}
        </p>
      )}
      {error && !dialog && (
        <p role="alert" className="download-views-error">
          <ErrorMessage error={error} />
        </p>
      )}
      {(dialog === "save" || dialog === "rename") && (
        <Modal
          title={t(dialog === "save" ? "views.save" : "views.rename")}
          onClose={close}
          size="sm"
        >
          <form
            className="download-views-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                attempt(() => {
                  if (dialog === "rename") {
                    if (!active) throw new DownloadViewError("missing");
                    downloadViews.rename(active.id, name);
                  } else downloadViews.save(name, config, pinned);
                })
              )
                close();
            }}
          >
            <label>
              {t("views.name")}
              <input
                className="input"
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            {dialog === "save" && (
              <label className="download-views-check">
                <input
                  type="checkbox"
                  checked={pinned}
                  onChange={(event) => setPinned(event.target.checked)}
                />
                {t("views.pin")}
              </label>
            )}
            {error && (
              <p role="alert" className="download-views-error">
                <ErrorMessage error={error} />
              </p>
            )}
            <div className="download-views-actions">
              <Button type="button" variant="secondary" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="primary">
                {t("views.confirmSave")}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === "filters" && (
        <Modal title={t("views.conditions")} onClose={close} size="lg">
          <form
            className="download-views-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                attempt(() => {
                  const parse = (value: string) => {
                    if (!value.trim()) return undefined;
                    const number = Number(value),
                      bytes = Math.round(number * 1048576);
                    if (
                      !Number.isFinite(number) ||
                      number < 0 ||
                      !Number.isSafeInteger(bytes)
                    )
                      throw new DownloadViewError("invalid");
                    return bytes;
                  };
                  const next = validateViewConfig({
                    ...config,
                    conditions: {
                      ...draft,
                      minBytes: parse(min),
                      maxBytes: parse(max),
                    },
                  });
                  onApply(next);
                })
              )
                close();
            }}
          >
            <div className="download-views-grid">
              <label>
                {t("views.status")}
                <Select
                  ariaLabel={t("views.status")}
                  value={draft.status}
                  options={DOWNLOAD_VIEW_STATUSES.map((status) => ({
                    value: status,
                    label: t(`filter.${status}`),
                  }))}
                  onChange={(value) =>
                    setDraft({ ...draft, status: value as typeof draft.status })
                  }
                />
              </label>
              <label>
                {t("views.category")}
                <Select
                  ariaLabel={t("views.category")}
                  value={
                    draft.category === undefined
                      ? "all"
                      : draft.category === null
                        ? "none"
                        : `id:${draft.category}`
                  }
                  options={categoryOptions}
                  onChange={(value) => {
                    const { category: _category, ...rest } = draft;
                    setDraft({
                      ...rest,
                      ...(value === "all"
                        ? {}
                        : {
                            category: value === "none" ? null : value.slice(3),
                          }),
                    });
                  }}
                />
              </label>
              <label>
                {t("views.nameContains")}
                <input
                  className="input"
                  maxLength={200}
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </label>
              <label>
                {t("views.pathContains")}
                <input
                  className="input"
                  maxLength={1024}
                  value={draft.path}
                  onChange={(event) =>
                    setDraft({ ...draft, path: event.target.value })
                  }
                />
              </label>
              <label>
                {t("views.minSize")}
                <NumberInput
                  className="input"
                  aria-label={t('views.minSize')}
                  min="0"
                  step="any"
                  value={min}
                  onValueChange={setMin}
                />
              </label>
              <label>
                {t("views.maxSize")}
                <NumberInput
                  className="input"
                  aria-label={t('views.maxSize')}
                  min="0"
                  step="any"
                  value={max}
                  onValueChange={setMax}
                />
              </label>
            </div>
            <p className="download-views-note">{t("views.conditionsHint")}</p>
            {error && (
              <p role="alert" className="download-views-error">
                <ErrorMessage error={error} />
              </p>
            )}
            <div className="download-views-actions">
              <Button type="button" variant="secondary" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="primary">
                {t("views.apply")}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
};
export default DownloadViewsBar;
