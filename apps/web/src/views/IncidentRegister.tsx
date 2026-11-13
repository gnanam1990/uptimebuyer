// Incident register (UI-SPEC §4): every incident visible to the principal, newest first, with lifecycle and deadline.
import { api, useResource } from '../api';
import { AxisBadge } from '../components/AxisBadge';
import { formatUtc } from '../format';
import { Link } from '../router';
import { useSession } from '../session';
import { Code, Loadable } from './common';

export function IncidentRegister() {
  const { session } = useSession();
  const res = useResource(() => api.incidents(), []);
  return (
    <>
      <h1 tabIndex={-1}>Incidents</h1>
      <p className="page-intro">Every incident you can see at {session.tenant.name}, newest first.</p>
      <section className="panel" aria-labelledby="register-h">
        <h2 id="register-h">Incident register</h2>
        <Loadable res={res} what="incidents" empty={(d) => d.incidents.length === 0}>
          {(d) => (
            <div
              className="table-wrap"
              data-scroll-region
              role="region"
              aria-label="Incident register table"
              tabIndex={0}
            >
              <table className="responsive">
                <caption className="sr-only">Incident register</caption>
                <thead>
                  <tr>
                    <th scope="col">Incident</th>
                    <th scope="col">State</th>
                    <th scope="col">Urgency</th>
                    <th scope="col">Asset</th>
                    <th scope="col">Opened</th>
                    <th scope="col">Current deadline</th>
                  </tr>
                </thead>
                <tbody>
                  {d.incidents.map((i) => (
                    <tr key={i.incidentId}>
                      <td data-label="Incident">
                        <Link to={`/incidents/${i.incidentId}`} className="link-button">
                          Open incident {i.incidentId}
                        </Link>
                      </td>
                      <td data-label="State">
                        <AxisBadge axis="incident-state" value={i.state} />
                      </td>
                      <td data-label="Urgency">
                        <AxisBadge axis="urgency" value={i.urgency} />
                      </td>
                      <td data-label="Asset">
                        <Code>{i.assetId}</Code>
                      </td>
                      <td data-label="Opened">{formatUtc(i.openedAt)}</td>
                      <td data-label="Current deadline">
                        {formatUtc(i.currentResponseDeadlineAt)} <AxisBadge axis="deadline" value={i.deadlineStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Loadable>
      </section>
    </>
  );
}
