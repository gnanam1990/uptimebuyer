// Application shell (UI-SPEC §6): skip link, banner with product name, tenant/site scope, pending notification count,
// the user menu and the primary navigation (the dark "cabinet": a full-height rail on wide screens, a top bar with
// wrapping navigation on narrow ones); a persistent environment label (seeded, replay or simulated data is always
// labelled) heading the working column; the main landmark that receives focus on navigation.
import { useEffect, type ReactNode } from 'react';
import { api, useResource } from '../api';
import { signOut } from '../auth';
import { Link, useRouter } from '../router';
import { useSession } from '../session';
import { BrandMark, NavIcon, WarningIcon, type NavIconName } from './Icons';

const NAV: { to: string; label: string; icon: NavIconName; match: (n: string) => boolean }[] = [
  { to: '/', label: 'Command Center', icon: 'command', match: (n) => n === 'command' },
  { to: '/incidents', label: 'Incidents', icon: 'incidents', match: (n) => n === 'incidents' || n === 'incident' },
  { to: '/ledger', label: 'Evidence ledger', icon: 'ledger', match: (n) => n === 'ledger' },
  { to: '/policies', label: 'Policies', icon: 'policies', match: (n) => n === 'policies' },
  { to: '/notifications', label: 'Notifications', icon: 'notifications', match: (n) => n === 'notifications' },
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
      {/* The cabinet: a full-height rail on wide screens, a top bar with wrapping navigation on narrow ones. DOM order
          (brand, navigation, scope, user) is the visual and keyboard order at every width. */}
      <header className="banner" role="banner">
        <p className="brand">
          <BrandMark />
          <span>UptimeBuyer Operations</span>
        </p>
        <nav className="primary-nav" aria-label="Primary">
          <ul>
            {NAV.map((n) => (
              <li key={n.to}>
                <Link
                  to={n.to}
                  className="nav-link"
                  {...(n.match(route.name) ? { 'aria-current': 'page' as const } : {})}
                >
                  <NavIcon name={n.icon} />
                  <span>{n.label}</span>
                  {n.to === '/notifications' && pending !== null ? (
                    <span className="count">
                      <span className="sr-only"> (</span>
                      {pending}
                      <span className="sr-only">)</span>
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="banner-foot">
          <dl className="scope">
            <div>
              <dt>Tenant</dt>
              <dd>{session.tenant.name}</dd>
            </div>
            <div>
              <dt>Scope</dt>
              <dd>{scope}</dd>
            </div>
          </dl>
          <div className="user">
            <span className="user-name">
              <span>{session.user.displayName}</span>
              <span className="user-roles">{roles}</span>
            </span>
            <button type="button" className="btn btn-cabinet" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <div className="workspace">
        <EnvironmentLabel label={config.environmentLabel} />
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

/** The persistent environment label: seeded, replay or simulated data is always named, on every page. */
export function EnvironmentLabel({ label }: { label: string | null | undefined }) {
  return label ? (
    <p className="env env-labelled" role="note" aria-label="Environment">
      <WarningIcon />
      <span>
        <strong>{label}</strong> <span>Seeded or simulated data, not live operations.</span>
      </span>
    </p>
  ) : (
    <p className="env env-production" role="note" aria-label="Environment">
      <strong>PRODUCTION</strong>
    </p>
  );
}
