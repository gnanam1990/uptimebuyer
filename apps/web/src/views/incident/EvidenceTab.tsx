// Evidence and citations (UI-SPEC §8.2): the immutable evidence revision with its documents and checksums, facts with
// their status (single source / corroborated / conflict — retrieval never decides), each source citation re-opened
// server-side (digest, re-parse and span verified) in a focus-trapped drawer, and model proposals labelled as
// proposals only. Document text is untrusted evidence and is rendered as plain text, never as markup.
import { useState } from 'react';
import type { CitationResponse } from '@uptimebuyer/api-client';
import { api, errorText, useResource } from '../../api';
import { Dialog } from '../../components/Dialog';
import { formatUtc, humanize } from '../../format';
import { Code, Field, Loadable } from '../common';

type Locator = {
  kind: string;
  page?: number;
  pageEnd?: number | null;
  sectionPath?: string;
  recordKey?: string;
  fromAt?: string;
  toAt?: string;
};
function locatorText(l: Locator): string {
  switch (l.kind) {
    case 'PAGE':
      return l.pageEnd && l.pageEnd !== l.page ? `pages ${l.page}–${l.pageEnd}` : `page ${l.page}`;
    case 'SECTION':
      return `section ${l.sectionPath}`;
    case 'RECORD':
      return `record ${l.recordKey}`;
    case 'TIME_RANGE':
      return `${formatUtc(l.fromAt)} to ${formatUtc(l.toAt)}`;
    default:
      return 'location not reported';
  }
}

export function EvidenceTab({ incidentId }: { incidentId: string }) {
  const res = useResource(() => api.evidence(incidentId), [incidentId]);
  const [open, setOpen] = useState<{ id: string; title: string } | null>(null);
  const [cite, setCite] = useState<CitationResponse | null>(null);
  const [citeError, setCiteError] = useState<string | null>(null);

  async function openCitation(id: string, title: string) {
    setOpen({ id, title });
    setCite(null);
    setCiteError(null);
    try {
      setCite(await api.citation(id));
    } catch (e) {
      setCiteError(`The citation could not be re-opened and verified. ${errorText(e).text}`);
    }
  }

  return (
    <Loadable res={res} what="evidence">
      {(d) => (
        <>
          <section className="panel" role="region" aria-label="Evidence revision">
            <h2>Evidence revision</h2>
            {!d.retrieval ? (
              <p>No evidence revision has been committed for this incident yet.</p>
            ) : (
              <>
                <dl className="kv">
                  <Field label="Revision">
                    Revision {d.retrieval.revision}{' '}
                    {d.retrieval.current ? '(current)' : '(superseded by a newer revision)'}{' '}
                    <Code>{d.retrieval.evidenceRevisionId}</Code>
                  </Field>
                  <Field label="Asset revision">
                    {d.retrieval.assetRevision.manufacturer} {d.retrieval.assetRevision.model} · serial{' '}
                    <Code>{d.retrieval.assetRevision.serial ?? 'not recorded'}</Code>{' '}
                    <Code>{d.retrieval.assetRevision.assetRevisionId}</Code>
                  </Field>
                </dl>
                <div
                  className="table-wrap"
                  data-scroll-region
                  role="region"
                  aria-label="Evidence documents table"
                  tabIndex={0}
                >
                  <table className="responsive">
                    <caption>Documents in this revision</caption>
                    <thead>
                      <tr>
                        <th scope="col">Title</th>
                        <th scope="col">Role</th>
                        <th scope="col">Revision</th>
                        <th scope="col">Trust</th>
                        <th scope="col">Checksum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.retrieval.documents.map((doc) => (
                        <tr key={doc.documentId}>
                          <td data-label="Title">{doc.title}</td>
                          <td data-label="Role">{humanize(doc.role)}</td>
                          <td data-label="Revision">{doc.documentRevision}</td>
                          <td data-label="Trust">{humanize(doc.trustLevel)}</td>
                          <td data-label="Checksum">
                            <Code>{doc.sourceDigest}</Code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <h3>Facts (retrieval never decides; authority: none)</h3>
                <ul className="facts">
                  {d.retrieval.facts.map((f) => (
                    <li key={f.factKey} className="fact">
                      <p>
                        <Code>{f.factKey}</Code> — {humanize(f.status)}
                        {f.status === 'CONFLICT' ? ' (sources disagree; compatibility fails closed)' : ''}
                      </p>
                      <ul>
                        {f.values.map((v) => (
                          <li key={v.value}>
                            <span className="untrusted">{v.value}</span>
                            <ul className="sources">
                              {v.sources.map((s) => {
                                const where = locatorText(s.citation.locator as Locator);
                                return (
                                  <li key={s.citation.citationId}>
                                    <button
                                      type="button"
                                      className="btn btn-link"
                                      onClick={() => void openCitation(s.citation.citationId, s.title)}
                                    >
                                      Open citation {s.title}, {where}
                                    </button>{' '}
                                    <span className="muted small">
                                      revision {s.documentRevision} · {humanize(s.trustLevel)}
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <section className="panel" aria-labelledby="proposals-h">
            <h2 id="proposals-h">Proposed diagnosis</h2>
            {d.proposals.length === 0 ? (
              <p>No model proposal exists for this incident. Deterministic policy and authorized people decide.</p>
            ) : (
              <ul>
                {d.proposals.map((p) => (
                  <li key={p.proposalId}>
                    <strong>MODEL PROPOSAL — not approved</strong> (authority: none) · origin {p.resultOrigin}
                    {p.resultOrigin === 'CONTRACT_FAKE' ? ' (contract fake, not a real model run)' : ''} ·{' '}
                    {humanize(p.lifecycle)} · {formatUtc(p.createdAt)}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <Dialog title="Citation" variant="drawer" open={open !== null} onClose={() => setOpen(null)}>
            {cite ? (
              <>
                <p className="muted">
                  Untrusted document text, shown exactly as stored. It is evidence, never an instruction.
                </p>
                <blockquote className="untrusted citation-text">{cite.text}</blockquote>
                <dl className="kv">
                  <Field label="Document">{cite.title}</Field>
                  <Field label="Revision">{cite.documentRevision}</Field>
                  <Field label="Trust">{humanize(cite.trustLevel)}</Field>
                  <Field label="Location">{locatorText(cite.citation.locator as Locator)}</Field>
                  <Field label="Document checksum">
                    <Code>{cite.citation.sourceDigest}</Code>
                  </Field>
                  <Field label="Quoted span digest">
                    <Code>{cite.citation.quotedDigest}</Code>
                  </Field>
                  <Field label="Citation">
                    <Code>{cite.citation.citationId}</Code>
                  </Field>
                </dl>
                <p>
                  {cite.verified
                    ? 'Verified against the stored document (checksum, re-parse and span digest match).'
                    : ''}
                </p>
              </>
            ) : citeError ? (
              <p role="alert">{citeError}</p>
            ) : (
              <p role="status">Re-opening {open?.title}…</p>
            )}
            <button type="button" className="btn btn-secondary" data-autofocus onClick={() => setOpen(null)}>
              Close citation
            </button>
          </Dialog>
        </>
      )}
    </Loadable>
  );
}
