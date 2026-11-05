// Timeline (UI-SPEC §8.7): append-only lifecycle transitions, signals and acknowledgements with actor and reason.
import type { Timeline } from '@uptimebuyer/api-client';
import type { Resource } from '../../api';
import { AxisBadge } from '../../components/AxisBadge';
import { formatUtc, humanize } from '../../format';
import { Code, Loadable } from '../common';

export function TimelineTab({
  timeline,
  nameOf,
}: {
  timeline: Resource<Timeline>;
  nameOf: (id: string | null | undefined) => string;
}) {
  return (
    <section className="panel" aria-labelledby="timeline-h">
      <h2 id="timeline-h">Timeline</h2>
      <Loadable res={timeline} what="timeline">
        {(t) => (
          <>
            <div
              className="table-wrap"
              data-scroll-region
              role="region"
              aria-label="Lifecycle transitions table"
              tabIndex={0}
            >
              <table className="responsive">
                <caption>Lifecycle transitions</caption>
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">From</th>
                    <th scope="col">To</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Actor</th>
                    <th scope="col">At</th>
                  </tr>
                </thead>
                <tbody>
                  {t.transitions.map((x) => (
                    <tr key={x.incidentVersion}>
                      <td data-label="Version">{x.incidentVersion}</td>
                      <td data-label="From">
                        {x.fromState ? <AxisBadge axis="incident-state" value={x.fromState} /> : 'Opened'}
                      </td>
                      <td data-label="To">
                        <AxisBadge axis="incident-state" value={x.toState} />
                      </td>
                      <td data-label="Reason">
                        <Code>{x.reasonCode}</Code>
                      </td>
                      <td data-label="Actor">
                        {x.actor.kind === 'HUMAN' ? nameOf(x.actor.id) : humanize(x.actor.kind)}
                      </td>
                      <td data-label="At">{formatUtc(x.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>Signals</h3>
            <ul>
              {t.signals.map((s) => (
                <li key={s.signalId}>
                  {humanize(s.signalKind)} · trust {humanize(s.trust)}
                </li>
              ))}
            </ul>
            <h3>Acknowledgements</h3>
            <ul>
              {t.acknowledgements.length === 0 ? <li>None</li> : null}
              {t.acknowledgements.map((a) => (
                <li key={`${a.userId}-${a.acknowledgedAt}`}>
                  {nameOf(a.userId)} at {formatUtc(a.acknowledgedAt)}
                </li>
              ))}
            </ul>
          </>
        )}
      </Loadable>
    </section>
  );
}
