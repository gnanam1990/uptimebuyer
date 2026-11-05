// Application shell (UI-SPEC §6): skip link, banner with product name, a persistent environment label (seeded, replay
// or simulated data is always labelled), tenant/site scope, pending notification count and the user menu; primary
// navigation; the main landmark that receives focus on navigation.
import { useEffect, type ReactNode } from 'react';
import { api, useResource } from '../api';
import { signOut } from '../auth';
import { Link, useRouter } from '../router';
import { useSession } from '../session';

const NAV: { to: string; label: string; match: (n: string) => boolean }[] = [
  { to: '/', label: 'Command Center', match: (n) => n === 'command' },
  { to: '/incidents', label: 'Incidents', match: (n) => n === 'incidents' || n === 'incident' },
  { to: '/ledger', label: 'Evidence ledger', match: (n) => n === 'ledger' },
  { to: '/policies', label: 'Policies', match: (n) => n === 'policies' },
  { to: '/notifications', label: 'Notifications', match: (n) => n === 'notifications' },
];

export function Shell({ children, title }: { children: ReactNode; title: string }) {
  const { config, session } = useSession();
  const { route, path } = useRouter();
  const notes = useResource(() => api.notifications(), [], { pollMs: 30_000 });
  const pending = notes.data?.notifications.filter((n) => n.state !== 'FAILED').length ?? null;
  useEffect(() => {
    document.title = `${title} — UptimeBuyer Operations`;
    const h1 = document.querySelector<HTMLElement>('main h1');
    h1?.focus({ preventScroll: false });
  }, [path, title]);
  const roles = [...new Set(session.grants.map((g) => g.role))].join(', ');
  const scope = session.grants.some((g) => g.siteId === null)
    ? 'all sites'
    : session.sites.map((s) => s.name).join(', ') || 'no sites';
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="banner" role="banner">
        <div className="brand">UptimeBuyer Operations</div>
        <div className="env" role="note" aria-label="Environment">
          <strong>{config.environmentLabel ?? 'PRODUCTION'}</strong>
          {config.environmentLabel ? <span> — seeded or simulated data, not live operations</span> : null}
        </div>
        <div className="scope">
          <span>
            Tenant: <strong>{session.tenant.name}</strong>
          </span>{' '}
          <span>· Scope: {scope}</span>
        </div>
        <div className="user">
          <span>
            {session.user.displayName} <span className="muted">({roles})</span>
          </span>
          <button type="button" className="btn btn-secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <nav className="primary-nav" aria-label="Primary">
        <ul>
          {NAV.map((n) => (
            <li key={n.to}>
              <Link
                to={n.to}
                className="nav-link"
                {...(n.match(route.name) ? { 'aria-current': 'page' as const } : {})}
              >
                {n.label}
                {n.to === '/notifications' && pending !== null ? <span className="count"> ({pending})</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
