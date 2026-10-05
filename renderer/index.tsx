import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Self-hosted Inter (bundled) — the prod CSP blocks the Google Fonts CDN, so
// loading it locally is the only way the app actually renders in Inter when packaged.
import '@fontsource/inter/300.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
// Self-hosted Chakra Petch (bundled) — the display face for titles/labels/primary
// actions (--font-display). Same CSP reason as Inter: local, never a CDN.
import '@fontsource/chakra-petch/500.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
// Chakra Petch has NO Cyrillic. Exo 2 (squared/technical, same HUD family) covers
// both scripts, so Russian gets a real HUD display face too. In EN the display
// stack is 'Chakra Petch','Exo 2',Inter (Latin → Chakra Petch); in RU a :lang(ru)
// rule switches --font-display to Exo 2 first, so Russian headings render in ONE
// face (letters AND digits) instead of mixing Chakra Petch digits with Cyrillic.
import '@fontsource/exo-2/500.css';
import '@fontsource/exo-2/600.css';
import '@fontsource/exo-2/700.css';
import './index.css';
import { setSplashStage } from './utils/splash';

setSplashStage('interface');

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
