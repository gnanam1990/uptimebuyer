// Top-level composition: public config -> sign-in or session -> routed views inside the shell.
import { useEffect, useState, type ReactNode } from 'react';
import type { PublicConfig, Session } from '@uptimebuyer/api-client';
import { api, errorText } from './api';
import { AnnouncerProvider } from './announce';
import { isSignedIn, onAuthChange } from './auth';
import { Shell } from './components/Shell';
import { RouterProvider, useRouter } from './router';
import { SessionProvider } from './session';
import { CommandCenter } from './views/CommandCenter';
import { IncidentRegister } from './views/IncidentRegister';
import { IncidentWorkspace } from './views/incident/IncidentWorkspace';
import { Ledger } from './views/Ledger';
import { Notifications } from './views/Notifications';
import { Policies } from './views/Policies';
import { SignIn } from './views/SignIn';

function Routed() {
  const { route } = useRouter();
  let title = 'Not found';
  let body: ReactNode;
  switch (route.name) {
    case 'command':
      title = 'Command Center';
      body = <CommandCenter />;
      break;
    case 'incidents':
      title = 'Incidents';
      body = <IncidentRegister />;
      break;
    case 'incident':
      title = `Incident ${route.id}`;
      body = <IncidentWorkspace key={route.id} id={route.id} tab={route.tab} context={route.context} />;
      break;
    case 'ledger':
      title = 'Evidence ledger';
      body = <Ledger />;
      break;
    case 'policies':
      title = 'Policy administration';
      body = <Policies />;
      break;
    case 'notifications':
      title = 'Notifications';
      body = <Notifications />;
      break;
    default:
      body = (
        <section>
          <h1 tabIndex={-1}>Page not found</h1>
          <p>This address is not a console view. Use the navigation to continue.</p>
        </section>
      );
  }
  return <Shell title={title}>{body}</Shell>;
}

export function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(isSignedIn());
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    api.publicConfig().then(setConfig, (e) => setConfigError(errorText(e).text));
    return onAuthChange(() => setSignedIn(isSignedIn()));
  }, []);
  useEffect(() => {
    if (!signedIn) {
      setSession(null);
      return;
    }
    api.session().then(
      (s) => {
        setSession(s);
        setSessionError(null);
      },
      (e) => setSessionError(errorText(e).text),
    );
  }, [signedIn]);

  return (
    <AnnouncerProvider>
      {configError ? (
        <main id="main" tabIndex={-1}>
          <h1 tabIndex={-1}>Console unavailable</h1>
          <p role="alert">{configError}</p>
        </main>
      ) : !signedIn || !config ? (
        <SignIn config={config} />
      ) : !session ? (
        <main id="main" tabIndex={-1}>
          <h1 tabIndex={-1}>Loading your session</h1>
          {sessionError ? <p role="alert">{sessionError}</p> : <p role="status">Loading…</p>}
        </main>
      ) : (
        <SessionProvider value={{ config, session }}>
          <RouterProvider>
            <Routed />
          </RouterProvider>
        </SessionProvider>
      )}
    </AnnouncerProvider>
  );
}
