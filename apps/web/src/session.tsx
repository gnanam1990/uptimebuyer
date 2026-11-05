// Session context: the public config (OIDC endpoints, environment label) and, once signed in, the server's view of the
// principal (tenant, grants, sites). Client-side role checks only explain or hide actions; the server authorizes.
import { createContext, useContext, type ReactNode } from 'react';
import type { PublicConfig, Session } from '@uptimebuyer/api-client';

export interface AppSession {
  config: PublicConfig;
  session: Session;
}
const Ctx = createContext<AppSession | null>(null);
export const SessionProvider = ({ value, children }: { value: AppSession; children: ReactNode }) => (
  <Ctx.Provider value={value}>{children}</Ctx.Provider>
);
export function useSession(): AppSession {
  const s = useContext(Ctx);
  if (!s) throw new Error('session missing');
  return s;
}

/** Does the principal hold one of `roles` at `siteId` (site grant or tenant-wide grant)? Explanation only. */
export function holdsRole(session: Session, roles: readonly string[], siteId: string | null): boolean {
  return session.grants.some((g) => roles.includes(g.role) && (g.siteId === null || g.siteId === siteId));
}
