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
      <p className="page-intro">
        This tenant's append-only, hash-chained evidence record, as exported for audit. Entries are never edited.
      </p>
      <section className="panel" aria-labelledby="ledger-h">
        <h2 id="ledger-h">Ledger entries</h2>
        <Loadable res={res} what="evidence ledger" empty={(d) => d.entries.length === 0}>
          {(d) => {
            const chain = (d as { chain?: { valid?: boolean } }).chain;
            return (
              <>
                <dl className="chain-summary">
                  <div>
                    <dt>Cut-off</dt>
                    <dd>{formatUtc(d.cutoffAt)}</dd>
                  </div>
                  <div>
                    <dt>Entries</dt>
                    <dd>{d.entries.length}</dd>
                  </div>
                  <div>
                    <dt>Hash chain</dt>
                    <dd>
                      {chain?.valid === true
                        ? 'Verified: every envelope links to its predecessor'
                        : chain?.valid === false
                          ? 'Broken: investigate before relying on this export'
                          : 'Not reported'}
                    </dd>
                  </div>
                </dl>
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
