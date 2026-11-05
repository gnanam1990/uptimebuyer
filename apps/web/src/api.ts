// The single API client instance (same origin, in-memory token) and small data hooks. Components never fetch
// directly; every response is decoded by @uptimebuyer/api-client against the shared contracts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClientError, ApiContractError, createApiClient } from '@uptimebuyer/api-client';
import { getAccessToken, signOut } from './auth';

export const api = createApiClient({ getAccessToken });

export interface Resource<T> {
  data: T | null;
  error: string | null;
  status: number | null;
  loading: boolean;
  reload: () => Promise<T | null>;
}

/** Human, honest error text: what is known, what is not, and no internal detail beyond a correlation id. */
export function errorText(e: unknown): { text: string; status: number | null } {
  if (e instanceof ApiClientError) {
    if (e.status === 401) {
      signOut();
      return { text: 'Your session ended. Sign in again to continue.', status: 401 };
    }
    const corr = e.correlationId ? ` Reference ${e.correlationId}.` : '';
    if (e.status === 403)
      return {
        text: `Not available for your roles or site scope (${e.reasonCode ?? 'FORBIDDEN'}).${corr}`,
        status: 403,
      };
    if (e.status === 429) return { text: `Too many requests; wait a moment and retry.${corr}`, status: 429 };
    if (e.status === 202)
      return { text: `The outcome is not known yet; nothing is shown as done.${corr}`, status: 202 };
    return { text: `${e.message} (${e.reasonCode ?? e.code ?? e.status}).${corr}`, status: e.status };
  }
  if (e instanceof ApiContractError)
    return { text: 'The server response did not match the contract; it is not shown as fact.', status: null };
  return { text: 'The request could not be completed. Check the connection and retry.', status: null };
}

export function useResource<T>(
  loader: () => Promise<T>,
  deps: unknown[],
  opts: { pollMs?: number; paused?: boolean } = {},
): Resource<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; status: number | null; loading: boolean }>(
    {
      data: null,
      error: null,
      status: null,
      loading: true,
    },
  );
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const reload = useCallback(async () => {
    try {
      const data = await loaderRef.current();
      setState({ data, error: null, status: 200, loading: false });
      return data;
    } catch (e) {
      const { text, status } = errorText(e);
      setState((s) => ({ ...s, error: text, status, loading: false }));
      return null;
    }
  }, deps);
  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!opts.pollMs || opts.paused) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const timer = window.setInterval(tick, opts.pollMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload, opts.pollMs, opts.paused]);
  return { ...state, reload };
}
