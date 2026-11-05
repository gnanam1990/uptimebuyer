// Verification (UI-SPEC §8.6; INV-01, INV-11): an evidence-backed checklist, never a "mark fixed" button. Only the
// canonical closeout gate reads as recovered; milestones, evaluations (with the immutable observation boundary) and
// closeouts (including reopened ones) are shown as recorded. Provider completion is visible but insufficient.
import { api, useResource } from '../../api';
import { AxisBadge } from '../../components/AxisBadge';
import { formatUtc, humanize } from '../../format';
import { Code, Loadable } from '../common';

export function VerificationTab({ incidentId }: { incidentId: string }) {
  const res = useResource(() => api.recovery(incidentId), [incidentId], { pollMs: 15_000 });
  return (
    <section className="panel" role="region" aria-label="Recovery verification">
      <h2>Recovery verification</h2>
      <Loadable res={res} what="recovery status">
        {(r) => {
          const g = r.gate;
          const current = r.evaluations.at(-1);
          const milestone = r.milestones.filter((m) => m.milestoneType).at(-1);
          return (
            <>
              <p className="gate">
                <AxisBadge axis="recovery" value={g.recovered ? 'RECOVERED' : 'NOT_RECOVERED'} />{' '}
                {g.recovered ? (
                  <>
                    — closeout <Code>{g.closeoutId}</Code>
                  </>
                ) : (
                  <>Reasons: {g.reasons.map(humanize).join('; ') || 'none reported'}.</>
                )}
              </p>
              <p className="muted">
                Provider completion is shown but never proves recovery; only the canonical closeout with a fresh stable
                telemetry window does.
              </p>
              <h3>Checklist</h3>
              <ul className="checklist">
                <li>
                  Intervention milestone:{' '}
                  {milestone
                    ? `${humanize(milestone.milestoneType)} at ${formatUtc(milestone.occurredAt)} from ${humanize(milestone.sourceKind)}`
                    : 'not recorded yet'}
                </li>
                <li>
                  Observation boundary:{' '}
                  {current
                    ? `${formatUtc(current.observationBoundaryAt)} (samples must be strictly after it)`
                    : 'not set'}
                </li>
                <li>
                  Stable telemetry window:{' '}
                  {current ? (
                    <>
                      <AxisBadge axis="recovery-evaluation" value={current.state} />{' '}
                      {current.stateReason ? humanize(current.stateReason) : ''}
                    </>
                  ) : (
                    'no evaluation yet'
                  )}
                </li>
                <li>
                  Closeout:{' '}
                  {g.recovered ? 'current closeout passed every configured check' : 'no current passing closeout'}
                </li>
              </ul>
              <div
                className="table-wrap"
                data-scroll-region
                role="region"
                aria-label="Recovery evaluations table"
                tabIndex={0}
              >
                <table className="responsive">
                  <caption>Recovery evaluations</caption>
                  <thead>
                    <tr>
                      <th scope="col">Evaluation</th>
                      <th scope="col">State</th>
                      <th scope="col">Boundary</th>
                      <th scope="col">Expires</th>
                      <th scope="col">Decided</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.evaluations.map((e) => (
                      <tr key={e.recoveryEvaluationId}>
                        <td data-label="Evaluation">
                          <Code>{e.recoveryEvaluationId}</Code>
                        </td>
                        <td data-label="State">
                          <AxisBadge axis="recovery-evaluation" value={e.state} />
                        </td>
                        <td data-label="Boundary">{formatUtc(e.observationBoundaryAt)}</td>
                        <td data-label="Expires">{formatUtc(e.expiresAt)}</td>
                        <td data-label="Decided">{formatUtc(e.decidedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-wrap" data-scroll-region role="region" aria-label="Closeouts table" tabIndex={0}>
                <table className="responsive">
                  <caption>Closeouts</caption>
                  <thead>
                    <tr>
                      <th scope="col">Closeout</th>
                      <th scope="col">Decided</th>
                      <th scope="col">Manifest digest</th>
                      <th scope="col">Reopened</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.closeouts.map((c) => (
                      <tr key={c.closeoutId}>
                        <td data-label="Closeout">
                          <Code>{c.closeoutId}</Code>
                        </td>
                        <td data-label="Decided">{formatUtc(c.decidedAt)}</td>
                        <td data-label="Manifest digest">
                          <Code>{c.manifestDigest}</Code>
                        </td>
                        <td data-label="Reopened">{c.reopenedAt ? formatUtc(c.reopenedAt) : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
      </Loadable>
    </section>
  );
}
