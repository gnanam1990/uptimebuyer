// Evidence ledger (FR-18): the tenant's append-only, hash-chained ledger export (auditors and admins), with the chain
// verification result and the export cut-off time.
import { api, useResource } from '../api';
import { formatUtc, humanize } from '../format';
import { Code, Loadable } from './common';

export function Ledger() {
  const res = useResource(() => api.ledger(), []);
  return (
    <>
      <h1 tabIndex={-1}>Evidence ledger</h1>
      <section className="panel" aria-labelledby="ledger-h">
        <h2 id="ledger-h">Ledger entries</h2>
        <Loadable res={res} what="evidence ledger" empty={(d) => d.entries.length === 0}>
          {(d) => {
            const chain = (d as { chain?: { valid?: boolean } }).chain;
            return (
              <>
                <p>
                  Cut-off {formatUtc(d.cutoffAt)} · {d.entries.length} entries · chain{' '}
                  {chain?.valid === true
                    ? 'verified (every envelope links to its predecessor)'
                    : chain?.valid === false
                      ? 'BROKEN — investigate'
                      : 'not reported'}
                </p>
                <div
                  className="table-wrap"
                  data-scroll-region
                  role="region"
                  aria-label="Evidence ledger table"
                  tabIndex={0}
                >
                  <table className="responsive">
                    <caption>Evidence ledger entries</caption>
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">Kind</th>
                        <th scope="col">Trust</th>
                        <th scope="col">Evidence</th>
                        <th scope="col">Recorded</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.entries.map((e) => (
                        <tr key={e.evidenceId}>
                          <td data-label="#">{e.sequence}</td>
                          <td data-label="Kind">{humanize(e.kind)}</td>
                          <td data-label="Trust">{humanize(e.trust)}</td>
                          <td data-label="Evidence">
                            <Code>{e.evidenceId}</Code>
                          </td>
                          <td data-label="Recorded">{formatUtc(e.recordedAt)}</td>
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
    </>
  );
}
