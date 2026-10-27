import React from "react";
import { createRoot } from "react-dom/client";
import { DevicesSection } from "../../renderer/pages/settings/sections/DevicesSection";
import { DeviceConsentHost } from "../../renderer/components/DeviceConsentHost";
import { I18nProvider } from "../../renderer/utils/i18nContext";
import { listenDeviceChanges } from "../../renderer/utils/devices";
import "../../renderer/index.css";
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/exo-2/600.css';
listenDeviceChanges();
void window.api.devices.start().then(() =>
  createRoot(document.getElementById("root")!).render(
    <I18nProvider>
      <DevicesSection />
      <DeviceConsentHost />
    </I18nProvider>,
  ),
);
