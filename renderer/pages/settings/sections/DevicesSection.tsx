import { DeviceInvitation } from '../../../components/DeviceInvitation';
import React, { useEffect, useState } from "react";
import { Button, Toggle, Select, Modal } from "../../../components";
import { NumberInput } from "../../../components/NumberInput";
import { SettingsCard, SettingRow } from "../controls";
import { useTranslation } from "../../../utils/i18nContext";
import { useDevices } from "../../../utils/devices";
import { deviceFingerprint } from "../../../components/DeviceConsentHost";
import type {
  DeviceUiConfig,
  DeviceUiRequest,
  DeviceUiResult,
  DeviceSnapshotDecision,
} from "../../../../shared/device-ui";
import type { DeviceScope } from "../../../../shared/device-pairing";
import type { Category } from "../../../../shared/types";
import "./DevicesSection.css";

export function DevicesSection() {
  const { state: s, setState, error: bridgeError } = useDevices();
  const { language } = useTranslation();
  const ru = language === "ru",
    l = (a: string, b: string) => (ru ? a : b);
  const [config, setConfig] = useState<DeviceUiConfig | null>(null);
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState(false);
  const [invitation, setInvitation] = useState(""),
    [join, setJoin] = useState(""),
    [invitationExpiresAt, setInvitationExpiresAt] = useState<number | null>(null);
  const [preview, setPreview] = useState<DeviceUiResult["preview"]>(undefined);
  const [reset, setReset] = useState(false),
    [phrase, setPhrase] = useState("");
  const [disable, setDisable] = useState(false),
    [approve, setApprove] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const savedConfig = JSON.stringify(s?.config ?? null);
  useEffect(() => { if (s?.status !== 'inviting') { setInvitation(''); setInvitationExpiresAt(null); } }, [s?.status]);
  useEffect(() => {
    const next: DeviceUiConfig | null = JSON.parse(savedConfig);
    if (next) setConfig(next);
  }, [savedConfig]);
  useEffect(() => {
    void window.api
      .getCategories()
      .then(setCategories)
      .catch(() => {});
  }, []);
  const command = async (request: DeviceUiRequest | DeviceSnapshotDecision) => {
    setBusy(true);
    setFailure(false);
    try {
      const r = await window.api.devices.command(request);
      setState(r.state);
      if (r.invitation) {
        setInvitation(r.invitation);
        setInvitationExpiresAt(r.invitationExpiresAt ?? null);
      }
      if (r.preview) setPreview(r.preview);
      if (
        ["cancel", "revoke", "reset", "join", "confirm"].includes(request.kind)
      ) { setInvitation(""); setInvitationExpiresAt(null); }
      return r;
    } catch {
      setFailure(true);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const scopes: Array<{ id: DeviceScope; name: string; detail: string }> = [
    {
      id: "preferences",
      name: l("Интерфейс и плеер", "Interface and player"),
      detail: l(
        "Язык, масштаб, плотность, анимация, единицы скорости и языки дорожек.",
        "Language, scale, density, motion, speed units and track languages.",
      ),
    },
    {
      id: "views",
      name: l("Сохранённые виды", "Saved views"),
      detail: l(
        "Названия, условия и порядок. Категории сопоставляются вручную; фильтры с локальным путём исключаются.",
        "Names, conditions and order. Categories need mapping; local path filters are excluded.",
      ),
    },
    {
      id: "playback",
      name: l("Позиции просмотра", "Playback positions"),
      detail: l(
        "Только локальные завершённые файлы с одинаковыми infoHash, относительным путём и размером. Открытый плеер блокирует применение.",
        "Only complete local files matching infoHash, relative path and size. An open player blocks application.",
      ),
    },
  ];
  const names: Record<string, string> = {
    off: l("Выключено", "Off"),
    opening: l("Открытие хранилища", "Opening storage"),
    unpaired: l("Нет связанного устройства", "No paired device"),
    inviting: l(
      "Приглашение действует 10 минут",
      "Invitation valid for 10 minutes",
    ),
    confirming: l(
      "Ожидается сравнение отпечатков",
      "Waiting for fingerprint comparison",
    ),
    pending: l("Ожидается подтверждение", "Waiting for confirmation"),
    prepared: l("Завершение сопряжения", "Finishing pairing"),
    offline: l("Устройство не в сети", "Device offline"),
    connecting: l("Подключение", "Connecting"),
    online: l("Соединение установлено", "Connected"),
    revoked: l("Доступ отозван", "Access revoked"),
    error: l("Требуется внимание", "Needs attention"),
  };
  const errors: Record<string, string> = {
    version: l(
      "Несовместимая версия протокола. Обновите Havvn на обоих устройствах.",
      "Incompatible protocol. Update Havvn on both devices.",
    ),
    identity: l(
      "Ключ или сертификат устройства не прошёл проверку. Восстановите исходный профиль либо архивируйте состояние и создайте новую идентичность.",
      "Device key or certificate failed validation. Restore the original profile or archive state and create a new identity.",
    ),
    missing: l(
      "Защищённое состояние устройств отсутствует. Данные могли быть очищены. Новая идентичность создаётся только после явного сброса.",
      "Protected device state is missing, possibly after clearing app data. A new identity requires an explicit reset.",
    ),
    config: l(
      "Настройки подключения повреждены. Архивируйте состояние устройств для явного сброса.",
      "Connection configuration is damaged. Archive device state for an explicit reset.",
    ),
    locked: l(
      "Системное хранилище ключей недоступно. Разблокируйте его и повторите. В Linux нужен защищённый keyring.",
      "System key storage is unavailable. Unlock it and retry. Linux requires a secure keyring.",
    ),
    storage: l(
      "Не удалось сохранить защищённое состояние. Освободите место или восстановите доступ и повторите подключение.",
      "Protected state could not be saved. Restore disk space or access and reconnect.",
    ),
    clone: l(
      "Профиль перенесён или уже занят. Для новой установки создайте новую идентичность через архивирование.",
      "Profile moved or in use. Archive the device state to create a new identity.",
    ),
    peer: l(
      "Соединение потеряно или другая версия протокола. Проверьте адрес, порт и версию приложения.",
      "Connection lost or protocol incompatible. Check address, port and app version.",
    ),
    quota: l(
      "Очередь или хранилище достигли лимита. Подключите второе устройство и обработайте ожидающие изменения.",
      "Queue or storage limit reached. Connect the peer and review pending changes.",
    ),
    size: l(
      "Данные превышают лимит прототипа: один снимок не более 64 КиБ. Состояние сохранено.",
      "Prototype limit exceeded: one snapshot must fit 64 KiB. State is retained.",
    ),
    stale: l(
      "Данные уже изменились. Откройте предварительный просмотр ещё раз.",
      "Data changed. Open the preview again.",
    ),
    expired: l(
      "Приглашение истекло. Создайте новое.",
      "Invitation expired. Create another.",
    ),
    invalid: l(
      "Проверьте приглашение, локальный IPv4 и порт.",
      "Check invitation, private IPv4 and port.",
    ),
  };
  if (!s || !config)
    return (
      <p role="status">
        {bridgeError
          ? l(
              "Раздел устройств недоступен. Перезапустите приложение.",
              "Devices unavailable. Restart the app.",
            )
          : l("Загрузка…", "Loading…")}
      </p>
    );
  const c = config;
  const activePair =
    !!s.peer && !["revoked", "unpaired", "off"].includes(s.status);
  return (
    <div className="devices-content" data-devices-section>
      <SettingsCard
        title={l(
          "Мои устройства · экспериментально",
          "My devices · experimental",
        )}
        icon="monitor"
      >
        <SettingRow
          label={l(
            "Синхронизация между двумя устройствами",
            "Sync between two devices",
          )}
          description={l(
            "По умолчанию выключена. Прямое соединение в локальной сети, без облака. Выключение отзывает текущую пару.",
            "Off by default. Direct local network connection, no cloud. Turning off revokes this pairing.",
          )}
          control={
            <Toggle
              checked={s.enabled}
              disabled={busy}
              onChange={(v) =>
                v
                  ? void command({ kind: "enable", enabled: true })
                  : setDisable(true)
              }
              ariaLabel={l("Включить устройства", "Enable devices")}
            />
          }
        />
        <div className="device-status" role="status">
          {names[s.status]}
          {s.recovering ? " · " + l("Восстановление", "Recovering") : ""}
        </div>
        {(s.error || failure) && (
          <p className="device-warning" role="alert">
            {errors[s.error ?? ""] ??
              l(
                "Операция не завершена. Проверьте подключение и повторите.",
                "Operation incomplete. Check connection and retry.",
              )}
          </p>
        )}
        {s.self && (
          <label>
            {l("Отпечаток этого устройства", "This device fingerprint")}
            <code className="device-fingerprint">
              {deviceFingerprint(s.self)}
            </code>
          </label>
        )}
        {s.peer && (
          <label>
            {l("Отпечаток второго устройства", "Other device fingerprint")}
            <code className="device-fingerprint">
              {deviceFingerprint(s.peer)}
            </code>
          </label>
        )}
        {s.enabled && (
          <div className="device-actions">
            <Button
              disabled={busy}
              onClick={() => void command({ kind: "reconnect" })}
            >
              {l("Повторить подключение", "Reconnect")}
            </Button>
            {activePair && (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => void command({ kind: "revoke" })}
              >
                {l("Отозвать доступ", "Revoke access")}
              </Button>
            )}
          </div>
        )}
      </SettingsCard>
      {s.enabled && (
        <>
          <SettingsCard
            title={l("Подключение и разрешения", "Connection and permissions")}
            icon="globe"
          >
            <p>
              {l(
                "На первом устройстве выберите его LAN-адрес, сохраните настройки и создайте приглашение. Передайте его второму устройству доверенным способом. 127.0.0.1 подходит только для проверки на одном ПК. Откройте выбранный TCP-порт в брандмауэре вручную при необходимости.",
                "On the first device choose its LAN address, save and create an invitation. Transfer it to the other device over a trusted channel. 127.0.0.1 works only on one computer. Allow the chosen TCP port in your firewall if needed.",
              )}
            </p>
            <div className="device-fields">
              <label>
                {l("Локальный адрес", "Local address")}
                <Select
                  ariaLabel={l("Локальный адрес", "Local address")}
                  value={c.listen.host}
                  options={[...new Set([...s.addresses, c.listen.host])].map(
                    (value) => ({ value, label: value }),
                  )}
                  onChange={(host) =>
                    setConfig({ ...c, listen: { ...c.listen, host } })
                  }
                />
              </label>
              <label>
                {l("Порт", "Port")}
                <NumberInput
                  className="input"
                  aria-label={l("Порт устройства", "Device port")}
                  min={1024}
                  max={65535}
                  value={c.listen.port}
                  onValueChange={(value) =>
                    setConfig({
                      ...c,
                      listen: { ...c.listen, port: Number(value) },
                    })
                  }
                />
              </label>
            </div>
            {c.remote && (
              <div className="device-fields">
                <label>
                  {l("Адрес первого устройства", "First device address")}
                  <input
                    className="input"
                    value={c.remote.host}
                    onChange={(e) =>
                      setConfig({
                        ...c,
                        remote: { ...c.remote!, host: e.target.value },
                      })
                    }
                  />
                </label>
                <label>
                  {l("Порт второго конца", "Remote port")}
                  <NumberInput
                    className="input"
                    min={1024}
                    max={65535}
                    value={c.remote.port}
                    onValueChange={(value) =>
                      setConfig({
                        ...c,
                        remote: { ...c.remote!, port: Number(value) },
                      })
                    }
                  />
                </label>
              </div>
            )}
            {scopes.map((scope) => (
              <SettingRow
                key={scope.id}
                label={scope.name}
                description={scope.detail}
                control={
                  <Toggle
                    checked={c.scopes.includes(scope.id)}
                    disabled={
                      busy || (activePair && !s.scopes.includes(scope.id))
                    }
                    onChange={(v) =>
                      setConfig({
                        ...c,
                        scopes: v
                          ? [...c.scopes, scope.id]
                          : c.scopes.filter((id) => id !== scope.id),
                      })
                    }
                    ariaLabel={scope.name}
                  />
                }
              />
            ))}
            <div className="device-actions">
              <Button
                disabled={busy || !c.scopes.length}
                onClick={() =>
                  void command({
                    kind: "configure",
                    listen: c.listen,
                    remote: c.remote,
                    scopes: c.scopes,
                  })
                }
              >
                {l("Сохранить подключение", "Save connection")}
              </Button>
              {activePair &&
                s.scopes.includes("preferences") &&
                s.scopes.length > 1 && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void command({
                        kind: "narrow",
                        scopes: ["preferences"].filter((x) =>
                          s.scopes.includes(x as DeviceScope),
                        ) as DeviceScope[],
                      })
                    }
                  >
                    {l("Оставить только интерфейс", "Keep interface only")}
                  </Button>
                )}
            </div>
            {activePair && (
              <p>
                {l(
                  "Расширение разрешений требует нового сопряжения. Сужение действует сразу, расширение через настройки не добавляет прав к текущей паре.",
                  "New permissions require pairing again. Narrowing takes effect immediately; connection settings cannot extend current rights.",
                )}
              </p>
            )}
            {!activePair && (
              <>
                <div className="device-actions">
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => void command({ kind: "invite" })}
                  >
                    {l("Создать приглашение", "Create invitation")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => void command({ kind: "cancel" })}
                  >
                    {l("Отменить сопряжение", "Cancel pairing")}
                  </Button>
                </div>
                {invitation && <DeviceInvitation text={invitation} expiresAt={invitationExpiresAt} />}
                <label>
                  {l(
                    "Приглашение с другого устройства",
                    "Invitation from another device",
                  )}
                  <textarea
                    className="input device-invitation"
                    value={join}
                    maxLength={20000}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setJoin(e.target.value)}
                  />
                </label>
                <div className="device-actions">
                  <Button
                    disabled={busy || !join.trim()}
                    onClick={() => {
                      const text = join;
                      setJoin("");
                      void command({ kind: "join", text });
                    }}
                  >
                    {l("Подключить устройство", "Connect device")}
                  </Button>
                </div>
              </>
            )}
          </SettingsCard>
          {activePair && (
            <SettingsCard
              title={l("Обмен данными", "Data exchange")}
              icon="activity"
            >
              <p>
                {l("Локальные записи для обмена", "Local records to exchange")}:{" "}
                {s.inventory.preferences} {l("настроек", "preferences")} ·{" "}
                {s.inventory.views} {l("видов", "views")} ·{" "}
                {s.inventory.playback} {l("позиций", "positions")}.
              </p>
              <div className="device-exchange-summary" data-device-exchange-summary>
                <p><strong>{l('Разрешённые области', 'Approved scopes')}: </strong>{s.approved ? s.scopes.map(id => scopes.find(scope => scope.id === id)?.name ?? id).join(' · ') : l('Обмен ещё не разрешён', 'Exchange is not approved')}</p>
                <p><strong>{l('Последнее подтверждённое применение', 'Last confirmed application')}: </strong>{s.lastApplied ? new Date(s.lastApplied.at).toLocaleString(language) + ' · ' + (scopes.find(scope => scope.id === s.lastApplied!.scope)?.name ?? s.lastApplied.scope) : l('Нет данных о применении. Соединение само по себе не означает синхронизацию.', 'No application recorded. A connection alone does not mean data was synchronized.')}</p>
              </div>
              <p>
                {l("Очередь", "Outbox")}: {s.outbox} ·{" "}
                {l("Ожидают решения", "Pending")}: {s.pending} ·{" "}
                {l("Конфликты", "Conflicts")}: {s.conflicts}
              </p>
              <p>
                {s.approved
                  ? l(
                      "Обмен разрешён для этой пары. Изменения применяются после проверки, конфликты ждут вашего выбора.",
                      "Exchange approved for this pair. Valid changes apply; conflicts await your choice.",
                    )
                  : l(
                      "Обмен ещё не разрешён. Изучите разрешения, исключения и ожидающие версии ниже. Локальные данные пока не отправляются.",
                      "Exchange is not approved. Review permissions, exclusions and pending versions below. Local data is not sent yet.",
                    )}
              </p>
              {s.issues.length > 0 && (
                <details>
                  <summary>
                    {l("Исключения и ограничения", "Exclusions and limits")} (
                    {s.issues.length})
                  </summary>
                  {s.issues.map((i, n) => (
                    <p key={n}>
                      {i.scope} · {i.recordId} · {i.code}
                    </p>
                  ))}
                </details>
              )}
              <div className="device-actions">
                {!s.approved && s.grant && (
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => setApprove(true)}
                  >
                    {l(
                      "Проверить и разрешить обмен",
                      "Review and approve exchange",
                    )}
                  </Button>
                )}
                {s.approved && (
                  <Button
                    disabled={busy || s.status !== "online"}
                    onClick={() => void command({ kind: "snapshot" })}
                  >
                    {l("Предложить повторную сверку", "Offer resync")}
                  </Button>
                )}
              </div>
              <p>
                {l(
                  "Снимок сверки ограничен 64 КиБ; на втором устройстве потребуется подтверждение. Передаются только выбранные разделы, без торрентов, файлов, путей загрузки и секретов.",
                  "Resync snapshot limit: 64 KiB, with approval on the other device. Only selected scopes are shared; torrents, files, download paths and secrets are excluded.",
                )}
              </p>
            </SettingsCard>
          )}
          {s.records.map((record) => (
            <SettingsCard
              key={record.scope + record.recordId}
              title={`${record.scope} · ${record.recordId}`}
              icon="info"
            >
              <p className="device-warning">
                {record.issue ?? l("Конфликт версий", "Version conflict")}
              </p>
              {record.variants.map((v) => (
                <div className="device-variant" key={v.author + v.sequence}>
                  <span>
                    {v.author === s.self
                      ? l("Это устройство", "This device")
                      : l("Второе устройство", "Other device")}{" "}
                    · {v.sequence}
                  </span>
                  <pre>
                    {v.deleted
                      ? l("Удаление записи", "Delete record")
                      : JSON.stringify(v.value, null, 2)}
                  </pre>
                  {record.issue === "category" &&
                    !v.deleted &&
                    v.value &&
                    typeof v.value === "object" &&
                    !Array.isArray(v.value) && (
                      <CategoryMapping
                        value={v.value}
                        categories={categories}
                        busy={busy}
                        map={(source, target) =>
                          void command({ kind: "map-category", source, target })
                        }
                        label={l(
                          "Сопоставить с локальной категорией",
                          "Map to local category",
                        )}
                      />
                    )}
                  <Button
                    disabled={busy || !s.approved}
                    onClick={() =>
                      void command({
                        kind: "preview",
                        scope: record.scope,
                        recordId: record.recordId,
                        author: v.author,
                        sequence: v.sequence,
                      })
                    }
                  >
                    {l("Просмотреть эту версию", "Preview this version")}
                  </Button>
                </div>
              ))}
              <div className="device-actions">
                <Button
                  disabled={busy || !s.approved}
                  onClick={() =>
                    void command({
                      kind: "preview",
                      scope: record.scope,
                      recordId: record.recordId,
                      local: true,
                    })
                  }
                >
                  {l(
                    "Оставить текущее локальное значение",
                    "Keep current local value",
                  )}
                </Button>
              </div>
            </SettingsCard>
          ))}
          {s.snapshotOffer && (
            <SettingsCard
              title={l("Предложена повторная сверка", "Resync offered")}
              icon="info"
            >
              <p>
                {s.snapshotOffer.scope} · {s.snapshotOffer.records}{" "}
                {l("записей", "records")} · {s.snapshotOffer.watermark}
              </p>
              <p>
                {l(
                  "Будет объединено защищённое состояние. Конфликты сохранятся для ручного выбора.",
                  "Protected state will be merged. Conflicts remain for manual choice.",
                )}
              </p>
              <div className="device-actions">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void command({
                      kind: "accept-snapshot",
                      id: s.snapshotOffer!.id,
                      accept: false,
                    })
                  }
                >
                  {l("Отклонить", "Reject")}
                </Button>
                <Button
                  disabled={busy || !s.approved}
                  onClick={() =>
                    void command({
                      kind: "accept-snapshot",
                      id: s.snapshotOffer!.id,
                      accept: true,
                    })
                  }
                >
                  {l("Принять сверку", "Accept resync")}
                </Button>
              </div>
            </SettingsCard>
          )}
        </>
      )}
      <SettingsCard
        title={l("Восстановление идентичности", "Identity recovery")}
        icon="shield"
      >
        <p>
          {l(
            "Если ключ потерян, отозвать доступ нужно также на втором устройстве. Сброс архивирует зашифрованное состояние устройств и выключает функцию. При следующем включении будет создан новый отпечаток.",
            "If the key is lost, revoke access on the other device too. Reset archives encrypted device state and turns the feature off. Enabling again creates a new fingerprint.",
          )}
        </p>
        <div className="device-actions">
          <Button
            disabled={busy}
            onClick={() => {
              setPhrase("");
              setReset(true);
            }}
          >
            {l("Архивировать состояние устройств", "Archive device state")}
          </Button>
        </div>
      </SettingsCard>
      {disable && (
        <Modal
          title={l("Выключить устройства?", "Turn devices off?")}
          onClose={() => setDisable(false)}
          footer={
            <>
              <Button onClick={() => setDisable(false)}>
                {l("Отмена", "Cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  void command({ kind: "enable", enabled: false }).then(() =>
                    setDisable(false),
                  );
                }}
              >
                {l("Выключить и отозвать пару", "Turn off and revoke pair")}
              </Button>
            </>
          }
        >
          <p>
            {l(
              "Сопряжение будет отозвано. Для возобновления потребуется новое приглашение.",
              "This pairing will be revoked. Reconnecting requires a new invitation.",
            )}
          </p>
        </Modal>
      )}
      {approve && (
        <Modal
          title={l("Разрешить первый обмен?", "Approve first exchange?")}
          onClose={() => setApprove(false)}
          footer={
            <>
              <Button onClick={() => setApprove(false)}>
                {l("Отмена", "Cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  if (s.grant)
                    void command({ kind: "approve", grant: s.grant }).then(() =>
                      setApprove(false),
                    );
                }}
              >
                {l("Разрешить выбранные данные", "Approve selected data")}
              </Button>
            </>
          }
        >
          <div className="devices-content">
            <p>
              {scopes
                .filter((x) => s.scopes.includes(x.id))
                .map((x) => x.name)
                .join(" · ")}
            </p>
            <p>
              {l(
                "Начнётся отправка локальных записей и применение полученных изменений. Одновременные правки сохранятся как конфликт. Это разрешение сохранится после перезапуска до отзыва пары.",
                "Local records will be sent and received changes applied. Concurrent edits remain conflicts. Approval persists until revocation.",
              )}
            </p>
            <p>
              {l("Настройки", "Preferences")}: {s.inventory.preferences} ·{" "}
              {l("Виды", "Views")}: {s.inventory.views} ·{" "}
              {l("Позиции", "Positions")}: {s.inventory.playback} ·{" "}
              {l("Исключения", "Exclusions")}: {s.issues.length}
            </p>
            <details>
              <summary>
                {l("Данные этого устройства", "Data on this device")}
              </summary>
              {s.localRecords.map((r) => (
                <div className="device-variant" key={r.scope + r.recordId}>
                  <span>
                    {r.scope} · {r.recordId}
                  </span>
                  <pre>{JSON.stringify(r.value, null, 2)}</pre>
                </div>
              ))}
            </details>
          </div>
        </Modal>
      )}
      {reset && (
        <Modal
          title={l("Архивировать и сбросить?", "Archive and reset?")}
          onClose={() => setReset(false)}
          footer={
            <>
              <Button onClick={() => setReset(false)}>
                {l("Отмена", "Cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={busy || phrase !== "RESET"}
                onClick={() =>
                  void command({ kind: "reset", confirmation: phrase }).then(
                    () => setReset(false),
                  )
                }
              >
                {l("Архивировать и выключить", "Archive and turn off")}
              </Button>
            </>
          }
        >
          <div className="devices-content">
            <p>
              {l(
                "Сохранится зашифрованная резервная копия devices-archive-* в профиле приложения. Настройки приложения и комнаты сохранятся. Если keyring потерян, архив не расшифруется автоматически.",
                "An encrypted devices-archive-* backup stays in the app profile. App settings and rooms are retained. A lost keyring cannot be recovered from this archive alone.",
              )}
            </p>
            <label>
              {l("Введите RESET", "Type RESET")}
              <input
                className="input"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                autoComplete="off"
              />
            </label>
          </div>
        </Modal>
      )}
      {preview && (
        <Modal
          title={l("Предварительный просмотр изменения", "Preview change")}
          size="xl"
          onClose={() => setPreview(undefined)}
          footer={
            <>
              <Button onClick={() => setPreview(undefined)}>
                {l("Отмена", "Cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={busy || !!preview.issue}
                onClick={() =>
                  void command({
                    kind: "resolve",
                    scope: preview.scope,
                    recordId: preview.recordId,
                    heads: preview.heads,
                    beforeStamp: preview.beforeStamp,
                    author: preview.author,
                    sequence: preview.sequence,
                    local: preview.local,
                  }).then((r) => {
                    if (r && !r.state.error) setPreview(undefined);
                  })
                }
              >
                {l("Применить эту версию", "Apply this version")}
              </Button>
            </>
          }
        >
          <div className="devices-content">
            <p>
              {preview.scope} · {preview.recordId}
            </p>
            {preview.issue && <p role="alert">{preview.issue}</p>}
            <label>
              {l("Сейчас", "Current")}
              <pre>{preview.before}</pre>
            </label>
            <label>
              {l("После применения", "After applying")}
              <pre>{preview.after}</pre>
            </label>
            <p>
              {l(
                "Если данные изменятся до применения, потребуется новый просмотр.",
                "If data changes before applying, a new preview is required.",
              )}
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
function CategoryMapping({
  value,
  categories,
  map,
  label,
  busy,
}: {
  value: object;
  categories: Category[];
  map(source: string, target: string): void;
  label: string;
  busy: boolean;
}) {
  const category = (value as { conditions?: { category?: unknown } }).conditions
    ?.category;
  if (typeof category !== "string") return null;
  return (
    <Select
      disabled={busy}
      ariaLabel={label}
      value=""
      placeholder={label}
      options={categories.map((c) => ({ value: c.id, label: c.name }))}
      onChange={(id) => map(category, id)}
    />
  );
}
