// Shared view pieces: loading/error/empty states that distinguish "nothing here" from "cannot be loaded" (UI-SPEC §11),
// and copyable identifiers.
import type { ReactNode } from 'react';
import type { Resource } from '../api';

export function Loadable<T>({
  res,
  empty,
  children,
  what,
}: {
  res: Resource<T>;
  what: string;
  empty?: (d: T) => boolean;
  children: (d: T) => ReactNode;
}) {
  if (res.data === null && res.loading) return <p role="status">Loading {what}…</p>;
  if (res.data === null)
    return (
      <div className="notice notice-error" role="alert">
        <p>
          {what.charAt(0).toUpperCase() + what.slice(1)} cannot be loaded. {res.error}
        </p>
        <button type="button" className="btn btn-secondary" onClick={() => void res.reload()}>
          Retry loading {what}
        </button>
      </div>
    );
  return (
    <>
      {res.error ? (
        <p className="notice notice-warning" role="status">
          Showing the last loaded {what}; the latest refresh failed. {res.error}
        </p>
      ) : null}
      {empty && empty(res.data) ? <p className="empty">No {what} to show yet.</p> : children(res.data)}
    </>
  );
}

export const Code = ({ children }: { children: ReactNode }) => <code className="id">{children}</code>;

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
