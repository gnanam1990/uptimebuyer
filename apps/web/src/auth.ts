// Operator sign-in: OIDC authorization code + PKCE (S256) in a popup (FR-24, M12 security review). The PKCE verifier,
// state and the access token live only in this module's memory: nothing is written to localStorage, sessionStorage,
// cookies, the URL of this window or any log, so a reload simply asks the user to sign in again (the identity
// provider's own session makes that quick). The popup's callback page posts {code, state} back to this window with an
// exact same-origin target, and the message is accepted only from that popup and only with the matching state.
import type { PublicConfig } from '@uptimebuyer/api-client';

let accessToken: string | null = null;
let expiresAtMs = 0;
const listeners = new Set<() => void>();

export const getAccessToken = (): string | null =>
  accessToken && Date.now() < expiresAtMs - 5_000 ? accessToken : null;
export const isSignedIn = (): boolean => getAccessToken() !== null;
export function onAuthChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((fn) => fn());

export function signOut(): void {
  accessToken = null;
  expiresAtMs = 0;
  notify();
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export class SignInError extends Error {
  constructor(readonly reason: 'POPUP_BLOCKED' | 'CANCELLED' | 'STATE_MISMATCH' | 'TOKEN_REJECTED' | 'TIMEOUT') {
    super(reason);
  }
}

export async function signInWithPopup(oidc: PublicConfig['oidc'], loginHint: string): Promise<void> {
  const verifier = random(32);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = random(16);
  const redirectUri = `${window.location.origin}/auth/callback`;
  const url = new URL(oidc.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', oidc.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', oidc.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (loginHint.trim()) url.searchParams.set('login_hint', loginHint.trim());
  const popup = window.open(url.toString(), 'ub-oidc', 'popup,width=520,height=680');
  if (!popup) throw new SignInError('POPUP_BLOCKED');

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new SignInError('TIMEOUT')), 300_000);
    const poll = window.setInterval(() => {
      if (popup.closed) finish(new SignInError('CANCELLED'));
    }, 500);
    function finish(result: string | Error) {
      window.clearTimeout(timeout);
      window.clearInterval(poll);
      window.removeEventListener('message', onMessage);
      if (typeof result === 'string') resolve(result);
      else reject(result);
    }
    function onMessage(ev: MessageEvent) {
      if (ev.origin !== window.location.origin || ev.source !== popup) return;
      const d = ev.data as { type?: unknown; code?: unknown; state?: unknown };
      if (d?.type !== 'ub-oidc-callback') return;
      if (d.state !== state || typeof d.code !== 'string') return finish(new SignInError('STATE_MISMATCH'));
      finish(d.code);
    }
    window.addEventListener('message', onMessage);
  });

  const res = await fetch(oidc.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: oidc.clientId,
    }),
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
  });
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!res.ok || !json || typeof json.access_token !== 'string' || typeof json.expires_in !== 'number')
    throw new SignInError('TOKEN_REJECTED');
  accessToken = json.access_token;
  expiresAtMs = Date.now() + Math.min(json.expires_in, 3_600) * 1_000;
  notify();
}

/**
 * Runs in the popup at /auth/callback: hand the code to the opener (exact same-origin target) and close. Returns false
 * when this window is not a sign-in popup.
 */
export function completePopupCallback(): boolean {
  if (window.location.pathname !== '/auth/callback') return false;
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  // Drop the code from this window's URL and history immediately.
  window.history.replaceState(null, '', '/auth/callback');
  if (window.opener && code && state) {
    (window.opener as Window).postMessage({ type: 'ub-oidc-callback', code, state }, window.location.origin);
    window.close();
  }
  return true;
}
