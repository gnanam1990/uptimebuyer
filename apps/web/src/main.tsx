// Entry point. The OIDC popup callback is handled before React mounts (the code goes straight to the opener and the
// popup closes); otherwise the console renders. No analytics, no error-report beacon and no browser storage are used.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { completePopupCallback } from './auth';
import { App } from './App';
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
