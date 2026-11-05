// Minimal client router over the History API: URL-addressable views and incident tabs (UI-SPEC §15), focus moved to the
// new page heading and the page title announced on navigation (NFR-07). Links are real anchors (keyboard, middle
// click, copy link) that navigate in-app on a plain activation.
import { createContext, useContext, useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';

export type Route =
  | { name: 'command' }
  | { name: 'incidents' }
  | { name: 'incident'; id: string; tab: IncidentTab; context: string | null }
  | { name: 'ledger' }
  | { name: 'policies' }
  | { name: 'notifications' }
  | { name: 'notfound' };
export const INCIDENT_TABS = ['overview', 'evidence', 'plan', 'spend', 'verification', 'timeline'] as const;
export type IncidentTab = (typeof INCIDENT_TABS)[number];

const ID = /^[a-z]{2,5}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/;

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'command' };
  if (parts[0] === 'incidents') {
    if (parts.length === 1) return { name: 'incidents' };
    const id = parts[1]!;
    if (!ID.test(id)) return { name: 'notfound' };
    if (parts.length === 2) return { name: 'incident', id, tab: 'overview', context: null };
    if (parts.length === 3 && (INCIDENT_TABS as readonly string[]).includes(parts[2]!))
      return { name: 'incident', id, tab: parts[2] as IncidentTab, context: null };
    if (parts.length === 5 && parts[2] === 'providers' && parts[3] === 'contacts' && ID.test(parts[4]!))
      return { name: 'incident', id, tab: 'spend', context: parts[4]! };
    return { name: 'notfound' };
  }
  if (parts.length === 1 && (parts[0] === 'ledger' || parts[0] === 'policies' || parts[0] === 'notifications'))
    return { name: parts[0] };
  return { name: 'notfound' };
}

const RouterContext = createContext<{ route: Route; path: string; navigate: (to: string) => void }>({
  route: { name: 'command' },
  path: '/',
  navigate: () => {},
});

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = (to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState(null, '', to);
    setPath(to);
  };
  return (
    <RouterContext.Provider value={{ route: parseRoute(path), path, navigate }}>{children}</RouterContext.Provider>
  );
}

export const useRouter = () => useContext(RouterContext);

export function Link({
  to,
  children,
  ...rest
}: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
