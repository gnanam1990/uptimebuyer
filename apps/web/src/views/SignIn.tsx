// Sign-in (no credential ever typed into this page): the identity provider authenticates the person in a popup.
// The optional login hint is passed to the provider only.
import { useState } from 'react';
import type { PublicConfig } from '@uptimebuyer/api-client';
import { SignInError, signInWithPopup } from '../auth';

const MESSAGES: Record<string, string> = {
  POPUP_BLOCKED: 'The sign-in window was blocked. Allow pop-ups for this site and try again.',
  CANCELLED: 'Sign-in was cancelled before it finished.',
  STATE_MISMATCH: 'The sign-in response did not match this request and was ignored. Try again.',
  TOKEN_REJECTED: 'The identity provider did not issue a session. Try again or contact your administrator.',
  TIMEOUT: 'Sign-in took too long. Try again.',
};

export function SignIn({ config }: { config: PublicConfig | null }) {
  const [hint, setHint] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main id="main" className="signin" tabIndex={-1}>
      <h1>Sign in to UptimeBuyer Operations</h1>
      {config?.environmentLabel ? (
        <p className="env" role="note" aria-label="Environment">
          <strong>{config.environmentLabel}</strong> — seeded or simulated data, not live operations
        </p>
      ) : null}
      <p>You sign in with your organization's identity provider. This page never asks for a password.</p>
      {error ? (
        <div className="error-summary" role="alert">
          <h2>Sign-in did not complete</h2>
          <p>{error}</p>
        </div>
      ) : null}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!config) return;
          setBusy(true);
          setError(null);
          try {
            await signInWithPopup(config.oidc, hint);
          } catch (err) {
            setError(MESSAGES[err instanceof SignInError ? err.reason : 'TOKEN_REJECTED'] ?? MESSAGES.TOKEN_REJECTED!);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="login-hint">Login hint (optional)</label>
        <input
          id="login-hint"
          type="text"
          autoComplete="username"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={!config || busy}>
          Sign in with identity provider
        </button>
      </form>
      {!config ? <p role="status">Loading sign-in configuration…</p> : null}
    </main>
  );
}
