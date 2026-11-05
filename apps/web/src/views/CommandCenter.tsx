// Command Center (UI-SPEC §7): fleet strip with separate fresh / stale / offline / invalid / no-signal counts and an
// "as of" time (stale data is never aggregated into a healthy count — INV-11), the asset freshness table with input
// origin labels, the active incident board and the action queue.
import { api, useResource } from '../api';
import { AxisBadge } from '../components/AxisBadge';
import { formatDuration, formatUtc } from '../format';
import { Link } from '../router';
import { useSession } from '../session';
import { Code, Loadable } from './common';

const STATS: [string, string][] = [
  ['assetsFresh', 'Assets fresh'],
  ['assetsStale', 'Assets stale'],
  ['assetsOffline', 'Assets offline'],
  ['assetsInvalid', 'Assets invalid'],
  ['assetsNoSignal', 'Assets with no signal'],
  ['activeIncidents', 'Active incidents'],
  ['criticalIncidents', 'Critical incidents'],
  ['unresolvedExternalOutcomes', 'Unresolved external outcomes'],
];

export function CommandCenter() {
  const { session } = useSession();
  const fleet = useResource(() => api.fleet(), [], { pollMs: 15_000 });
  const incidents = useResource(() => api.incidents({ activeOnly: true }), [], { pollMs: 15_000 });
  const notes = useResource(() => api.notifications(), []);
  return (
    <>
      <h1 tabIndex={-1}>Command Center — {session.tenant.name}</h1>
      <section aria-labelledby="fleet-h" className="panel">
        <h2 id="fleet-h">Fleet health</h2>
        <Loadable res={fleet} what="fleet health">
          {(f) => (
            <>
              <ul className="stats">
                {STATS.map(([key, label]) => (
                  <li key={key} className="stat">
                    <span className="stat-label">{label}</span>
                    <span className="stat-value" data-testid={`count-${key}`}>
                      {String(f.counts[key as keyof typeof f.counts])}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="muted">
                As of {formatUtc(f.asOf)}. Stale, offline, invalid and no-signal assets are never counted as fresh.
              </p>
            </>
          )}
        </Loadable>
      </section>

      <section aria-labelledby="assets-h" className="panel">
        <h2 id="assets-h">Assets and signal freshness</h2>
        <Loadable res={fleet} what="assets" empty={(f) => f.sites.every((s) => s.assets.length === 0)}>
          {(f) => (
            <div
              className="table-wrap"
              data-scroll-region
              role="region"
              aria-label="Assets and signal freshness table"
              tabIndex={0}
            >
              <table className="responsive">
                <caption className="sr-only">Assets and signal freshness</caption>
                <thead>
                  <tr>
                    <th scope="col">Asset</th>
                    <th scope="col">Site</th>
                    <th scope="col">Freshness</th>
                    <th scope="col">Newest reading</th>
                    <th scope="col">Input</th>
                    <th scope="col">Active incidents</th>
                  </tr>
                </thead>
                <tbody>
                  {f.sites.flatMap((s) =>
                    s.assets.map((a) => (
                      <tr key={a.assetId} data-asset-id={a.assetId}>
                        <td data-label="Asset">
                          {a.manufacturer} {a.model} <Code>{a.serial ?? 'serial not recorded'}</Code>
                        </td>
                        <td data-label="Site">{s.name}</td>
                        <td data-label="Freshness">
                          <AxisBadge axis="freshness" value={a.freshness} />
                          {a.freshnessReason ? <span className="muted small"> {a.freshnessReason}</span> : null}
                        </td>
                        <td data-label="Newest reading">
                          {formatUtc(a.sourceTime)}
                          {a.devices[0]?.ageMs !== null && a.devices[0]?.ageMs !== undefined ? (
                            <span className="muted small"> ({formatDuration(a.devices[0].ageMs)} ago)</span>
                          ) : null}
                        </td>
                        <td data-label="Input">
                          {a.inputOrigins.length === 0
                            ? 'No device'
                            : a.inputOrigins.map((o) => (
                                <span key={o} className={o === 'SIMULATOR' ? 'label-sim' : 'label-phys'}>
                                  {o === 'SIMULATOR' ? 'SIMULATED_INPUT' : 'Physical sensor'}
                                </span>
                              ))}
                        </td>
                        <td data-label="Active incidents">
                          {a.activeIncidentIds.length === 0
                            ? 'None'
                            : a.activeIncidentIds.map((id) => (
                                <Link key={id} to={`/incidents/${id}`} className="link-button">
                                  Open incident {id}
                                </Link>
                              ))}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Loadable>
      </section>

      <section aria-labelledby="board-h" className="panel">
        <h2 id="board-h">Active incidents</h2>
        <Loadable res={incidents} what="active incidents" empty={(d) => d.incidents.length === 0}>
          {(d) => (
            <div
              className="table-wrap"
              data-scroll-region
              role="region"
              aria-label="Active incidents table"
              tabIndex={0}
            >
              <table className="responsive">
                <caption className="sr-only">Active incidents</caption>
                <thead>
                  <tr>
                    <th scope="col">Incident</th>
                    <th scope="col">Severity and state</th>
                    <th scope="col">Signal</th>
                    <th scope="col">Pinned SOP deadline</th>
                    <th scope="col">Owner</th>
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
                      <td data-label="Severity and state">
                        <AxisBadge axis="urgency" value={i.urgency} />{' '}
                        <AxisBadge axis="incident-state" value={i.state} />
                      </td>
                      <td data-label="Signal">
                        {i.triggerInputOrigin === 'SIMULATED_INPUT' ? (
                          <span className="label-sim">SIMULATED_INPUT</span>
                        ) : (
                          i.triggerInputOrigin
                        )}{' '}
                        <span className="muted small">({i.signalState})</span>
                      </td>
                      <td data-label="Pinned SOP deadline">
                        {formatUtc(i.currentResponseDeadlineAt)} <AxisBadge axis="deadline" value={i.deadlineStatus} />
                      </td>
                      <td data-label="Owner">
                        {i.currentAssignment ? (
                          <>
                            <Code>{i.currentAssignment.assigneeUserId}</Code>{' '}
                            {i.currentAssignment.acceptedAt ? 'accepted' : 'not accepted'}
                          </>
                        ) : (
                          'Unassigned'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Loadable>
      </section>

      <section aria-labelledby="queue-h" className="panel">
        <h2 id="queue-h">Action queue</h2>
        <Loadable res={notes} what="action queue">
          {(n) => {
            const count = (k: string) => n.notifications.filter((x) => x.triggerKind === k).length;
            return (
              <ul className="queue">
                <li>Spend approvals awaiting review: {count('APPROVAL_REQUIRED')}</li>
                <li>Spend exceptions (unknown or failed outcomes): {count('SPEND_EXCEPTION')}</li>
                <li>Evidence gaps: {count('EVIDENCE_GAP')}</li>
                <li>Provider changes: {count('PROVIDER_CHANGE')}</li>
                <li>
                  <Link to="/notifications" className="link-button">
                    Review notifications
                  </Link>
                </li>
              </ul>
            );
          }}
        </Loadable>
      </section>
    </>
  );
}
