// Spend & orders (UI-SPEC §8.5; INV-12): execution authorities with local authority status, the separate Kite-session
// axes (external outcome, transport, adapter capability), budget projection and scope; issuance and revocation behind
// effect-disclosing confirmations (issuance answers 202: never session confirmation). Orders keep purchase orders and
// service jobs distinct and show the fulfillment state, economic intent, external outcome, transport, adapter
// capability and reconciliation separately; a post-egress UNKNOWN stays UNKNOWN and disables any retry with its reason.
import { useState } from 'react';
import type { AuthorityWire, OrderWire } from '@uptimebuyer/api-client';
import { api, errorText, useResource } from '../../api';
import { useAnnounce } from '../../announce';
import { AxisBadge } from '../../components/AxisBadge';
import { Dialog } from '../../components/Dialog';
import { ActionButton, RadioGroup, type Option } from '../../components/Forms';
import { formatMinor, formatUtc, humanize } from '../../format';
import { holdsRole, useSession } from '../../session';
import { Code, Field, Loadable } from '../common';

const REVOKE_REASONS: Option[] = [
  { value: 'SCOPE_NO_LONGER_NEEDED', label: 'Scope no longer needed' },
  { value: 'SUSPECTED_MISUSE', label: 'Suspected misuse' },
  { value: 'PLAN_SUPERSEDED', label: 'Plan superseded' },
];

const RECONCILIATION: Record<string, string> = {
  NONE: 'No reconciliation pending',
  SCHEDULED: 'Reconciliation scheduled: the broker looks the result up by the original operation key',
  MANUAL_REVIEW:
    'Manual review: no automatic lookup is possible; a finance approver resolves this from authoritative evidence',
};

export function SpendTab({ incidentId, siteId }: { incidentId: string; siteId: string }) {
  const { session } = useSession();
  const announce = useAnnounce();
  const auths = useResource(() => api.authorities(incidentId), [incidentId]);
  const orders = useResource(() => api.orders(incidentId), [incidentId]);
  const [revoke, setRevoke] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [issueFor, setIssueFor] = useState<{ approvalId: string; candidateActionId: string } | null>(null);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const canManage = holdsRole(session, ['maintenance_approver', 'finance_approver', 'admin'], siteId);

  return (
    <>
      {message ? (
        <div className={`notice notice-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </div>
      ) : null}
      <section className="panel" role="region" aria-label="Execution authority">
        <h2>Execution authority and Kite session</h2>
        <Loadable res={auths} what="execution authorities">
          {(d) => (
            <>
              {d.authorities.length === 0 ? <p>No execution authority has been issued for this incident.</p> : null}
              {d.authorities.map((a) => (
                <AuthorityCard
                  key={a.authority.executionAuthorityId}
                  a={a}
                  canManage={canManage}
                  onRevoke={() => setRevoke(a.authority.executionAuthorityId)}
                />
              ))}
            </>
          )}
        </Loadable>
      </section>
      <section className="panel" role="region" aria-label="Orders and payments">
        <h2>Orders and payments</h2>
        <p className="muted">
          A payment receipt or delivery never proves recovery; only the canonical closeout in Verification does.
        </p>
        <Loadable res={orders} what="orders" empty={(d) => d.orders.length === 0}>
          {(d) => (
            <>
              {d.orders.map((o) => (
                <OrderCard key={o.orderId} o={o} />
              ))}
            </>
          )}
        </Loadable>
      </section>
      <Dialog title="Confirm authority revocation" open={revoke !== null} onClose={() => setRevoke(null)}>
        <p>
          Revoking <Code>{revoke}</Code> blocks new spending immediately. It never erases or relabels an effect that may
          already be in flight; those keep reconciling under the original authority.
        </p>
        <RadioGroup
          id="revoke-reason"
          name="revoke-reason"
          legend="Reason"
          options={REVOKE_REASONS}
          value={reason}
          onChange={setReason}
        />
        <div className="actions">
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || !reason}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.changeAuthority(revoke!, { to: 'REVOKED', reasonCode: reason! });
                setRevoke(null);
                await auths.reload();
                const t = `Authority ${r.authority.executionAuthorityId} is now ${r.authority.status}. In-flight effects keep reconciling.`;
                setMessage({ kind: 'info', text: t });
                announce(t);
              } catch (e) {
                setRevoke(null);
                const t = `The authority was not revoked. ${errorText(e).text}`;
                setMessage({ kind: 'error', text: t });
                announce(t, { assertive: true });
              } finally {
                setBusy(false);
              }
            }}
          >
            Revoke authority
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setRevoke(null)}>
            Cancel
          </button>
        </div>
      </Dialog>
      <Dialog title="Confirm authority issuance" open={issueFor !== null} onClose={() => setIssueFor(null)}>
        <p>
          Issuing materializes one immutable, signed authority for approval <Code>{issueFor?.approvalId}</Code> and
          requests its Kite session. A 202 response is not session confirmation; spending stays blocked until the
          session outcome is CONFIRMED.
        </p>
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.issueAuthority(issueFor!.approvalId, {
                  subject: { type: 'PLAN_ACTION', id: issueFor!.candidateActionId },
                });
                setIssueFor(null);
                await auths.reload();
                const t = `Authority ${r.authority.authority.executionAuthorityId} issued. Kite session: ${humanize(r.authority.session.externalOutcomeState)}${r.sessionConfirmed ? '' : ' (not confirmed)'}.`;
                setMessage({ kind: 'info', text: t });
                announce(t);
              } catch (e) {
                setIssueFor(null);
                const t = `The authority was not issued. ${errorText(e).text}`;
                setMessage({ kind: 'error', text: t });
                announce(t, { assertive: true });
              } finally {
                setBusy(false);
              }
            }}
          >
            Issue execution authority
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setIssueFor(null)}>
            Cancel
          </button>
        </div>
      </Dialog>
      <Loadable res={auths} what="approvals">
        {(d) => {
          const pending = d.approvals.filter((x) => x.executionAuthorityId === null);
          return pending.length === 0 ? null : (
            <section className="panel" aria-labelledby="issue-h">
              <h2 id="issue-h">Approvals without an authority</h2>
              {pending.map((x) => (
                <p key={x.approvalId}>
                  Approval <Code>{x.approvalId}</Code> recorded {formatUtc(x.approvedAt)}.{' '}
                  <ActionButton
                    disabledReason={
                      holdsRole(session, ['operator', 'maintenance_approver', 'finance_approver'], siteId)
                        ? null
                        : 'Requires an operator or approver role at this site.'
                    }
                    onClick={() => setIssueFor({ approvalId: x.approvalId, candidateActionId: x.candidateActionId })}
                  >
                    Issue execution authority…
                  </ActionButton>
                </p>
              ))}
            </section>
          );
        }}
      </Loadable>
    </>
  );
}

function AuthorityCard({ a, canManage, onRevoke }: { a: AuthorityWire; canManage: boolean; onRevoke: () => void }) {
  const s = a.session;
  const b = a.budget;
  const confirmed = s.externalOutcomeState === 'CONFIRMED';
  const money = (v: string) => formatMinor(v, b.currency);
  return (
    <article className="card" data-authority-id={a.authority.executionAuthorityId}>
      <h3>
        Execution authority <Code>{a.authority.executionAuthorityId}</Code>
      </h3>
      <div className="badges">
        <AxisBadge axis="local-authority" value={a.authority.status} prefix="Local authority" />
        <AxisBadge axis="kite-session" value={s.externalOutcomeState} prefix="Kite session" />
        <AxisBadge axis="transport" value={s.transportState} prefix="Transport" />
        <AxisBadge axis="adapter-capability" value={s.adapterCapability} prefix="Capability" />
      </div>
      {!confirmed ? (
        <p className="notice notice-warning">
          Kite session not confirmed. No spend can be reserved until the session outcome is CONFIRMED.
        </p>
      ) : null}
      {s.externalOutcomeState === 'UNKNOWN' ? (
        <p className="notice notice-unknown">
          Reconciliation required. No new spending until the session outcome is reconciled by the original operation
          key.
        </p>
      ) : null}
      {s.providerSessionRef ? (
        <p className="muted small">
          Provider session reference <Code>{s.providerSessionRef}</Code> (a reference is evidence, not confirmation).
        </p>
      ) : null}
      {a.sessionReasonCode ? <p className="muted small">Session reason: {humanize(a.sessionReasonCode)}</p> : null}
      <dl className="kv">
        <Field label="Merchant">
          <Code>{a.authority.merchantId}</Code>
        </Field>
        <Field label="Purpose">{a.authority.purpose}</Field>
        <Field label="Per-action limit">{money(a.authority.perActionLimit.amountMinor)}</Field>
        <Field label="Expires">{formatUtc(a.authority.expiresAt)}</Field>
        <Field label="Base / effective limit">
          {money(b.baseLimitMinor)} / {money(b.effectiveLimitMinor)}
        </Field>
        <Field label="Open reserve">{money(b.openReservedMinor)}</Field>
        <Field label="Gross captured / net settled">
          {money(b.grossCapturedMinor)} / {money(b.netSettledMinor)}
        </Field>
        <Field label="Refunded / reversed">
          {money(b.refundedMinor)} / {money(b.reversedMinor)} (never new authority)
        </Field>
        <Field label="Remaining gross authority">{money(b.availableMinor)}</Field>
      </dl>
      {a.unresolvedAttempts.length > 0 ? (
        <p className="notice notice-unknown">{a.unresolvedAttempts.length} attempt(s) still reconciling.</p>
      ) : null}
      <ActionButton
        kind="danger"
        onClick={onRevoke}
        disabledReason={
          a.authority.status === 'REVOKED' || a.authority.status === 'EXPIRED'
            ? `Already ${a.authority.status.toLowerCase()}.`
            : canManage
              ? null
              : 'Requires a maintenance approver, finance approver or admin role at this site.'
        }
      >
        Revoke authority…
      </ActionButton>
    </article>
  );
}

function OrderCard({ o }: { o: OrderWire }) {
  const purchase = o.orderKind === 'PURCHASE_ORDER';
  const e = o.economic;
  const unknown = e.state === 'UNKNOWN' || e.externalOutcomeState === 'UNKNOWN' || o.state === 'UNKNOWN';
  return (
    <article className="card" data-order-id={o.orderId}>
      <h3>
        {purchase ? 'Purchase order' : 'Service job'} {o.orderId}
      </h3>
      <div className="badges">
        <AxisBadge
          axis={purchase ? 'purchase-order' : 'service-job'}
          value={o.state}
          prefix={purchase ? 'Purchase order' : 'Service job'}
        />
        <AxisBadge axis="economic-intent" value={e.state} prefix="Payment" />
        <AxisBadge axis="external-outcome" value={e.externalOutcomeState} prefix="External outcome" />
        <AxisBadge axis="transport" value={e.transportState} prefix="Transport" />
        <AxisBadge axis="adapter-capability" value={e.adapterCapability} prefix="Capability" />
      </div>
      <p>{RECONCILIATION[e.reconciliation] ?? 'Reconciliation status not reported'}.</p>
      {e.reasonCode ? <p className="muted small">Payment reason: {humanize(e.reasonCode)}</p> : null}
      {o.blockedReason ? <p className="notice notice-warning">Blocked: {humanize(o.blockedReason)}</p> : null}
      <dl className="kv">
        <Field label="Approved">
          {o.approved.quantity} × up to {formatMinor(o.approved.amountMinor, o.approved.currency)}
        </Field>
        <Field label="Commercial intent">
          <Code>{o.commercialIntentId}</Code>
        </Field>
      </dl>
      {e.state === 'CONFIRMED' ? (
        <p className="muted small">A payment receipt or delivery never proves recovery.</p>
      ) : null}
      {unknown || e.state === 'FAILED' ? (
        <ActionButton
          disabledReason={
            unknown
              ? 'Retry is disabled: the outcome is UNKNOWN. It must be reconciled before any retry so a duplicate purchase cannot happen.'
              : 'Retry is disabled: a definite failure is retried only through a fresh approval, which creates a linked successor intent.'
          }
        >
          Retry purchase
        </ActionButton>
      ) : null}
    </article>
  );
}
