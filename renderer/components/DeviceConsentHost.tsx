import React, { useState } from "react";
import { Modal, Button, Toggle } from "./index";
import { useDevices } from "../utils/devices";
import { useTranslation } from "../utils/i18nContext";
import "../pages/settings/sections/DevicesSection.css";
export const deviceFingerprint = (id: string) =>
  id.match(/.{1,8}/g)?.join(" ") ?? id;
export function DeviceConsentHost() {
  const { state } = useDevices();
  const { language } = useTranslation();
  const ru = language === "ru",
    c = state?.confirmation;
  const [checked, setChecked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (!c) return null;
  const decide = async (accept: boolean) => {
    setBusy(true);
    setError(false);
    try {
      await window.api.devices.command({ kind: "confirm", id: c.id, accept });
      setChecked(null);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={ru ? "Подтвердить устройство" : "Confirm device"}
      size="lg"
      busy={busy}
      onClose={() => void decide(false)}
      footer={
        <>
          <Button onClick={() => void decide(false)} disabled={busy}>
            {ru ? "Отклонить" : "Reject"}
          </Button>
          <Button
            variant="primary"
            disabled={checked !== c.id || busy}
            onClick={() => void decide(true)}
          >
            {ru ? "Связать устройства" : "Pair devices"}
          </Button>
        </>
      }
    >
      <div className="devices-content">
        <p>
          {ru
            ? "Сравните оба полных отпечатка на двух устройствах по доверенному каналу. Подтверждение требуется на каждом устройстве."
            : "Compare both full fingerprints on the two devices over a trusted channel. Both devices must confirm."}
        </p>
        <label>
          {ru ? "Это устройство" : "This device"}
          <code className="device-fingerprint" data-device-self>
            {deviceFingerprint(c.self)}
          </code>
        </label>
        <label>
          {ru ? "Второе устройство" : "Other device"}
          <code className="device-fingerprint" data-device-peer>
            {deviceFingerprint(c.peer)}
          </code>
        </label>
        <p>
          {ru ? "Разрешения" : "Permissions"}: {c.scopes.join(", ")}
          {c.endpoint ? ` · ${c.endpoint.host}:${c.endpoint.port}` : ""}
        </p>
        <p>
          {ru
            ? "Обмен данными включается отдельно после сопряжения."
            : "Data exchange requires a separate approval after pairing."}
        </p>
        <Toggle
          checked={checked === c.id}
          onChange={(v) => setChecked(v ? c.id : null)}
          label={ru ? "Оба отпечатка совпадают" : "Both fingerprints match"}
        />
        {error && (
          <p role="alert">
            {ru
              ? "Подтверждение не сохранено. Повторите действие."
              : "Confirmation was not saved. Retry."}
          </p>
        )}
      </div>
    </Modal>
  );
}
