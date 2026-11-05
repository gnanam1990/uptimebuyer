// Policy administration (FR-21; UI-SPEC §10): immutable, effective-dated AUTHORITY revisions with history; a draft is
// validated server-side before publication, and publication (admin only) goes through an effect-disclosing
// confirmation. Nothing here edits a published revision.
import { useState } from 'react';
import { api, errorText, useResource } from '../api';
import { useAnnounce } from '../announce';
import { Dialog } from '../components/Dialog';
import { formatUtc } from '../format';
import { Code, Loadable } from './common';

export function Policies() {
  const announce = useAnnounce();
  const res = useResource(() => api.policies(), []);
  const [draft, setDraft] = useState('');
  const [result, setResult] = useState<{
    kind: 'info' | 'error';
    text: string;
    issues?: { path: string; code: string }[];
  } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const parse = (): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(draft) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  return (
    <>
      <h1 tabIndex={-1}>Policy administration</h1>
      <section className="panel" aria-labelledby="policy-h">
        <h2 id="policy-h">Policy revisions</h2>
        <Loadable res={res} what="policy revisions" empty={(d) => d.revisions.length === 0}>
          {(d) => (
            <div
              className="table-wrap"
              data-scroll-region
              role="region"
              aria-label="Policy revisions table"
              tabIndex={0}
            >
              <table className="responsive">
                <caption>Policy revisions</caption>
                <thead>
                  <tr>
                    <th scope="col">Revision</th>
                    <th scope="col">Effective</th>
                    <th scope="col">Until</th>
                    <th scope="col">Current</th>
                    <th scope="col">Identifier</th>
                  </tr>
                </thead>
                <tbody>
                  {d.revisions.map((r) => {
                    const x = r as typeof r & { effectiveUntil?: string | null; current?: boolean };
                    return (
                      <tr key={r.policyRevisionId}>
                        <td data-label="Revision">{r.revision}</td>
                        <td data-label="Effective">{formatUtc(r.effectiveAt)}</td>
                        <td data-label="Until">{x.effectiveUntil ? formatUtc(x.effectiveUntil) : 'Open'}</td>
                        <td data-label="Current">{x.current ? 'Current' : 'No'}</td>
                        <td data-label="Identifier">
                          <Code>{r.policyRevisionId}</Code>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Loadable>
      </section>
      <section className="panel" aria-labelledby="draft-h">
        <h2 id="draft-h">Draft a new revision</h2>
        <label htmlFor="policy-draft">Policy draft (JSON)</label>
        <textarea
          id="policy-draft"
          rows={10}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          aria-describedby="policy-draft-hint"
        />
        <p id="policy-draft-hint" className="muted small">
          A whole AUTHORITY policy body: approval limits and the compatibility section. It is validated on the server;
          publication creates a new immutable revision.
        </p>
        {result ? (
          <div className={`notice notice-${result.kind}`} role={result.kind === 'error' ? 'alert' : 'status'}>
            <p>{result.text}</p>
            {result.issues?.length ? (
              <ul>
                {result.issues.map((i) => (
                  <li key={`${i.path}-${i.code}`}>
                    <Code>{i.path || '(root)'}</Code>: {i.code}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <div className="actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={async () => {
              const body = parse();
              if (!body) return setResult({ kind: 'error', text: 'The draft is not a JSON object.' });
              try {
                const v = await api.validatePolicy({ body });
                setResult(
                  v.valid
                    ? { kind: 'info', text: 'The draft is valid.' }
                    : { kind: 'error', text: 'The draft has problems.', issues: v.issues },
                );
              } catch (e) {
                setResult({ kind: 'error', text: errorText(e).text });
              }
            }}
          >
            Validate draft
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              parse() ? setConfirm(true) : setResult({ kind: 'error', text: 'The draft is not a JSON object.' })
            }
          >
            Publish revision…
          </button>
        </div>
      </section>
      <Dialog title="Confirm policy publication" open={confirm} onClose={() => setConfirm(false)}>
        <p>
          Publishing creates a new immutable revision. Active decisions, plans and approvals under the previous revision
          are re-evaluated or invalidated.
        </p>
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              setConfirm(false);
              try {
                const r = await api.publishPolicy({ body: parse()! });
                setResult({ kind: 'info', text: `Published revision ${r.revision} (${r.policyRevisionId}).` });
                announce(`Policy revision ${r.revision} published.`);
                await res.reload();
              } catch (e) {
                setResult({ kind: 'error', text: `Not published. ${errorText(e).text}` });
              }
            }}
          >
            Publish revision
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      </Dialog>
    </>
  );
}
