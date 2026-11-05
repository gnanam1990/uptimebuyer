// Compatibility, plan comparison and approval (UI-SPEC §8.3, §8.5; FR-11). Decisions are M06's deterministic
// ALLOW/HOLD/REJECT; the ranking is M08's advisory expected cost-to-recovery with its inputs; an incomplete plan has no
// winner. Before approval the effective bounds of the spending session — incident, merchant, action, amount, currency,
// purpose and expiry — are displayed and, when the approver opens the confirmation, announced. Approval copy names the
// exact effect; approving moves no money and never implies a Kite session. Hold records a decision and authorizes
// nothing.
import { useState } from 'react';
import type { PlanWire } from '@uptimebuyer/api-client';
import { api, errorText, useResource } from '../../api';
import { useAnnounce } from '../../announce';
import { AxisBadge } from '../../components/AxisBadge';
import { Dialog } from '../../components/Dialog';
import { ActionButton, RadioGroup, type Option } from '../../components/Forms';
import { formatMinor, formatMoney, formatUtc, humanize } from '../../format';
import { holdsRole, useSession } from '../../session';
import { Code, Field, Loadable } from '../common';

const HOLD_REASONS: Option[] = [
  { value: 'NEED_SECOND_QUOTE', label: 'Need a second quote' },
  { value: 'EVIDENCE_INCOMPLETE', label: 'Evidence incomplete' },
  { value: 'BUDGET_REVIEW', label: 'Budget review' },
];

export function PlanTab({ incidentId, siteId }: { incidentId: string; siteId: string }) {
  const compat = useResource(() => api.compatibility(incidentId), [incidentId]);
  const plans = useResource(() => api.plans(incidentId), [incidentId]);
  return (
    <>
      <section className="panel" aria-labelledby="compat-h">
        <h2 id="compat-h">Compatibility</h2>
        <Loadable res={compat} what="compatibility decisions" empty={(d) => d.decisions.length === 0}>
          {(d) => (
            <div
              className="table-wrap"
              data-scroll-region
              role="region"
              aria-label="Compatibility decisions table"
              tabIndex={0}
            >
              <table className="responsive">
                <caption>Compatibility decisions</caption>
                <thead>
                  <tr>
                    <th scope="col">Candidate</th>
                    <th scope="col">Decision</th>
                    <th scope="col">Exact match</th>
                    <th scope="col">Safety class</th>
                    <th scope="col">Reasons</th>
                    <th scope="col">Missing or conflicting</th>
                    <th scope="col">Lifecycle</th>
                  </tr>
                </thead>
                <tbody>
                  {d.decisions.map((x) => (
                    <tr key={x.compatibilityDecisionId}>
                      <td data-label="Candidate">
                        <Code>{x.candidateActionId}</Code>
                      </td>
                      <td data-label="Decision">
                        <AxisBadge axis="compatibility" value={x.decision} />
                      </td>
                      <td data-label="Exact match">{x.exactMatch ? 'Exact OEM match' : 'Not an exact match'}</td>
                      <td data-label="Safety class">{humanize(x.safetyClass)}</td>
                      <td data-label="Reasons">{x.reasonCodes.join(', ') || 'None'}</td>
                      <td data-label="Missing or conflicting">
                        {[...x.missingFields, ...x.conflictingFields].join(', ') || 'None'}
                      </td>
                      <td data-label="Lifecycle">{humanize(x.lifecycle)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Loadable>
      </section>
      <Loadable res={plans} what="recovery plans" empty={(d) => d.plans.length === 0}>
        {(d) => {
          const plan = d.plans[d.plans.length - 1]!;
          return (
            <>
              <PlanComparison plan={plan} />
              <Approval plan={plan} siteId={siteId} incidentId={incidentId} reload={plans.reload} />
            </>
          );
        }}
      </Loadable>
    </>
  );
}

function PlanComparison({ plan }: { plan: PlanWire }) {
  return (
    <section className="panel" aria-labelledby="plan-h">
      <h2 id="plan-h">Plan comparison</h2>
      <p>
        Plan revision {plan.revision} · {humanize(plan.state)} · outcome {humanize(plan.outcome)} ·{' '}
        <strong>{plan.label}</strong> — the ranking is advisory and never an approval.
        {plan.incomplete ? ' A required input is missing, so there is no deterministic winner.' : ''}
      </p>
      <div
        className="table-wrap"
        data-scroll-region
        role="region"
        aria-label="Recovery plan comparison table"
        tabIndex={0}
      >
        <table className="responsive">
          <caption>Recovery plan comparison (advisory ranking)</caption>
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Action</th>
              <th scope="col">Amount</th>
              <th scope="col">Expected cost to recovery</th>
              <th scope="col">Deadline fit</th>
              <th scope="col">Recovery ETA</th>
              <th scope="col">Disposition</th>
            </tr>
          </thead>
          <tbody>
            {plan.actions.map((a) => (
              <tr key={a.planActionId}>
                <td data-label="Rank">{a.ordinal ?? 'Unranked'}</td>
                <td data-label="Action">{humanize(a.actionKind)}</td>
                <td data-label="Amount">{formatMoney(a.amount)}</td>
                <td data-label="Expected cost to recovery">
                  {a.expectedCostMinor !== null && a.amount
                    ? formatMinor(a.expectedCostMinor, a.amount.currency)
                    : 'Incomplete'}
                </td>
                <td data-label="Deadline fit">{a.deadlineFit ? humanize(a.deadlineFit) : 'Not computed'}</td>
                <td data-label="Recovery ETA">{formatUtc(a.recoveryEtaAt)}</td>
                <td data-label="Disposition">
                  <AxisBadge axis="plan-disposition" value={a.disposition} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Approval({
  plan,
  siteId,
  incidentId,
  reload,
}: {
  plan: PlanWire;
  siteId: string;
  incidentId: string;
  reload: () => Promise<unknown>;
}) {
  const { session } = useSession();
  const announce = useAnnounce();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [holdFor, setHoldFor] = useState<string | null>(null);
  const [holdReason, setHoldReason] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const canApprove = holdsRole(session, ['maintenance_approver'], siteId);
  const canHold = holdsRole(session, ['maintenance_approver', 'finance_approver', 'engineer'], siteId);
  const requests = plan.approvalRequests;
  const active = requests.find((r) => r.approvalRequestId === confirm) ?? null;

  const boundsText = (r: (typeof requests)[number]) => {
    const b = r.sessionBounds;
    return `incident ${b.incidentId}, merchant ${b.merchantId}, action ${b.actionKind}, amount ${formatMoney(b.amount)}, purpose ${b.purpose}, expires ${formatUtc(b.expiresAt)}`;
  };

  return (
    <section className="panel" role="region" aria-label="Approval">
      <h2>Approval</h2>
      {message ? (
        <div className={`notice notice-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </div>
      ) : null}
      {requests.length === 0 ? <p>No approval request has been prepared for this plan.</p> : null}
      {requests.map((r) => {
        const b = r.sessionBounds;
        const amount = formatMoney(b.amount);
        return (
          <article key={r.approvalRequestId} className="approval">
            <h3>
              Approval request <Code>{r.approvalRequestId}</Code>
            </h3>
            <div role="group" aria-label="Spending session bounds" className="bounds">
              <dl className="kv">
                <Field label="Incident">
                  <Code>{b.incidentId}</Code>
                </Field>
                <Field label="Merchant">
                  <Code>{b.merchantId}</Code>
                </Field>
                <Field label="Action">
                  {b.actionKind} ({humanize(b.actionClass)})
                </Field>
                <Field label="Amount">{amount.split(' ')[0]}</Field>
                <Field label="Currency">{b.amount.currency}</Field>
                <Field label="Purpose">{b.purpose}</Field>
                <Field label="Expires">{formatUtc(b.expiresAt)}</Field>
                <Field label="Policy revision">
                  <Code>{b.policyRevisionId}</Code>
                </Field>
                <Field label="Provider account revision">
                  <Code>{b.providerAccountRevisionId}</Code>
                </Field>
              </dl>
            </div>
            {r.approvalId ? (
              <p className="notice notice-info">
                Approval recorded: <Code>{r.approvalId}</Code>. No money has moved. Kite session not confirmed: an
                execution authority must be issued and its Kite session confirmed before any spend.
              </p>
            ) : r.state === 'INVALIDATED' ? (
              <p className="notice notice-warning">
                This request was invalidated ({humanize(r.invalidatedReason ?? 'INVALIDATED')}); it cannot be approved.
              </p>
            ) : (
              <div className="actions">
                <ActionButton
                  kind="primary"
                  disabledReason={
                    canApprove
                      ? null
                      : 'Requires the maintenance approver role at this site (the server enforces this and the policy amount limit).'
                  }
                  onClick={() => {
                    setConfirm(r.approvalRequestId);
                    announce(`Review spending session before approving: ${boundsText(r)}.`);
                  }}
                >
                  {`Approve up to ${amount} for incident ${b.incidentId}`}
                </ActionButton>
                <ActionButton
                  disabledReason={canHold ? null : 'Requires an approver role at this site.'}
                  onClick={() => setHoldFor(r.approvalRequestId)}
                >
                  Hold approval…
                </ActionButton>
              </div>
            )}
          </article>
        );
      })}
      <Dialog title="Confirm spending approval" open={active !== null} onClose={() => setConfirm(null)}>
        {active ? (
          <>
            <p>You are approving at most {formatMoney(active.sessionBounds.amount)} for exactly this scope:</p>
            <p className="bounds-text">{boundsText(active)}.</p>
            <p>
              No money moves when you approve. Approval records a bounded authorization; an execution authority and a
              CONFIRMED Kite session are still required before any spend, and the server re-checks your authority and
              the policy amount limit.
            </p>
            <div className="actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                data-autofocus
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await api.approve(active.planId, {
                      approvalRequestId: active.approvalRequestId,
                      planHash: active.planHash,
                    });
                    setConfirm(null);
                    await reload();
                    const t = `Approval recorded: ${r.approvalId} for at most ${formatMoney(r.maxAmount)}. No money moved; the Kite session is not confirmed.`;
                    setMessage({ kind: 'info', text: t });
                    announce(t);
                  } catch (e) {
                    setConfirm(null);
                    const t = `The approval was not recorded. ${errorText(e).text}`;
                    setMessage({ kind: 'error', text: t });
                    announce(t, { assertive: true });
                    await reload();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Confirm approval
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </div>
          </>
        ) : null}
      </Dialog>
      <Dialog title="Hold approval" open={holdFor !== null} onClose={() => setHoldFor(null)}>
        <p>A hold records your decision in the evidence ledger. It approves nothing and the request stays pending.</p>
        <RadioGroup
          id="hold-reason"
          name="hold-reason"
          legend="Reason"
          options={HOLD_REASONS}
          value={holdReason}
          onChange={setHoldReason}
        />
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !holdReason}
            onClick={async () => {
              const req = requests.find((x) => x.approvalRequestId === holdFor)!;
              setBusy(true);
              try {
                const r = await api.hold(req.planId, {
                  approvalRequestId: req.approvalRequestId,
                  reasonCode: holdReason!,
                });
                setHoldFor(null);
                await reload();
                const t = `Hold recorded in ledger entry ${r.ledgerEntryId}; nothing was approved and the request stays pending.`;
                setMessage({ kind: 'info', text: t });
                announce(t);
              } catch (e) {
                setHoldFor(null);
                const t = `The hold was not recorded. ${errorText(e).text}`;
                setMessage({ kind: 'error', text: t });
                announce(t, { assertive: true });
              } finally {
                setBusy(false);
              }
            }}
          >
            Confirm hold
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setHoldFor(null)}>
            Cancel
          </button>
        </div>
      </Dialog>
      <p className="muted small">
        Incident <Code>{incidentId}</Code>: approvals are bounded by the AUTHORITY policy revision named above.
      </p>
    </section>
  );
}
