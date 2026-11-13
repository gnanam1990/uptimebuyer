// Command Center (UI-SPEC §7): fleet strip with separate fresh / stale / offline / invalid / no-signal counts and an
// "as of" time (stale data is never aggregated into a healthy count — INV-11), the asset freshness table with input
// origin labels, the active incident board and the action queue.
import { api, useResource } from '../api';
import { AxisBadge, Icon } from '../components/AxisBadge';
import { describeAxis, type Shape, type Tone } from '../status/axes';
import { formatDuration, formatUtc } from '../format';
import { Link } from '../router';
import { useSession } from '../session';
import { Code, Loadable } from './common';

type Stat = [key: string, label: string, shape: Shape, tone: Tone];
// Icon shape and tone come from the freshness axis mapping, so a count never looks healthier than its state.
const fresh = (value: string): [Shape, Tone] => {
  const d = describeAxis('freshness', value);
  return [d.shape, d.tone];
};
const SIGNAL_STATS: Stat[] = [
  ['assetsFresh', 'Assets fresh', ...fresh('FRESH')],
  ['assetsStale', 'Assets stale', ...fresh('STALE')],
  ['assetsOffline', 'Assets offline', ...fresh('OFFLINE')],
  ['assetsInvalid', 'Assets invalid', ...fresh('INVALID')],
  ['assetsNoSignal', 'Assets with no signal', ...fresh('NO_SIGNAL')],
];
const INCIDENT_STATS: Stat[] = [
  ['activeIncidents', 'Active incidents', 'circle', 'neutral'],
  ['criticalIncidents', 'Critical incidents', 'octagon', 'critical'],
  ['unresolvedExternalOutcomes', 'Unresolved external outcomes', 'question', 'unknown'],
];

function StatList({ stats, counts }: { stats: Stat[]; counts: Record<string, number> }) {
  return (
    <ul className="stats">
      {stats.map(([key, label, shape, tone]) => (
        <li key={key} className="stat">
          <span className={`stat-icon tone-${tone}`}>
            <Icon shape={shape} />
          </span>
          <span className="stat-value" data-testid={`count-${key}`}>
            {String(counts[key])}
          </span>
          <span className="stat-label">{label}</span>
        </li>
      ))}
    </ul>
  );
}

export function CommandCenter() {
  const { session } = useSession();
  const fleet = useResource(() => api.fleet(), [], { pollMs: 15_000 });
  const incidents = useResource(() => api.incidents({ activeOnly: true }), [], { pollMs: 15_000 });
  const notes = useResource(() => api.notifications(), []);
  return (
    <>
      <h1 tabIndex={-1}>Command Center</h1>
      <p className="page-intro">
        Refrigeration assets and open incidents for {session.tenant.name}. Fleet data refreshes every 15 seconds.
      </p>
      <section aria-labelledby="fleet-h" className="panel controller fleet">
        <h2 id="fleet-h">Fleet health</h2>
        <Loadable res={fleet} what="fleet health">
          {(f) => {
            const counts = f.counts as unknown as Record<string, number>;
            return (
              <>
                <div className="fleet-groups">
                  <div className="fleet-group">
                    <h3>Sensor signal</h3>
                    <StatList stats={SIGNAL_STATS} counts={counts} />
                  </div>
                  <div className="fleet-group">
                    <h3>Incidents and outcomes</h3>
                    <StatList stats={INCIDENT_STATS} counts={counts} />
                  </div>
                </div>
                <p className="asof">
                  As of {formatUtc(f.asOf)}. Stale, offline, invalid and no-signal assets are never counted as fresh.
                </p>
              </>
            );
          }}
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
                          {a.freshnessReason ? (
                            <span className="muted small code-text"> {a.freshnessReason}</span>
                          ) : null}
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
                                  Open incident <span className="id-text">{id}</span>
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
                          Open incident <span className="id-text">{i.incidentId}</span>
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
