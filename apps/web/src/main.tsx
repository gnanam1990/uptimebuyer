// Entry point. The OIDC popup callback is handled before React mounts (the code goes straight to the opener and the
// popup closes); otherwise the console renders. No analytics, no error-report beacon and no browser storage are used.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { completePopupCallback } from './auth';
import { App } from './App';
// Self-hosted fonts (exact-pinned @fontsource packages, OFL-1.1, latin subset): bundled into dist and served from the
// same origin, so the CSP's font-src 'self' holds and no font request leaves the site.
import '@fontsource/atkinson-hyperlegible-next/latin-400.css';
import '@fontsource/atkinson-hyperlegible-next/latin-700.css';
import '@fontsource/barlow-semi-condensed/latin-500.css';
import '@fontsource/barlow-semi-condensed/latin-600.css';
import '@fontsource/atkinson-hyperlegible-mono/latin-400.css';
import './styles.css';

const root = document.getElementById('root')!;
if (completePopupCallback()) {
  root.textContent = 'Completing sign-in… You can close this window if it stays open.';
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
