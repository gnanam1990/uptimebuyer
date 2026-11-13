// Incident workspace (UI-SPEC §8): a status header that always shows lifecycle, signal freshness, the current and
// original pinned-SOP deadline, owner, blocker and next safe action; URL-addressable sections; shared reloadable
// resources so a command or a version conflict refreshes the authoritative server state (never a local guess).
import { useState } from 'react';
import { api, useResource } from '../../api';
import { AxisBadge, Icon } from '../../components/AxisBadge';
import { formatMilliCelsius, formatUtc } from '../../format';
import { INCIDENT_TABS, Link, type IncidentTab } from '../../router';
import { Code, Loadable } from '../common';
import { EvidenceTab } from './EvidenceTab';
import { readoutModel } from './readout';
import { OverviewTab } from './OverviewTab';
import { PlanTab } from './PlanTab';
import { SpendTab } from './SpendTab';
import { TimelineTab } from './TimelineTab';
import { VerificationTab } from './VerificationTab';
import type { IncidentDetail, Telemetry } from '@uptimebuyer/api-client';

const TAB_LABEL: Record<IncidentTab, string> = {
  overview: 'Overview',
  evidence: 'Evidence',
  plan: 'Recovery plan',
  spend: 'Spend & orders',
  verification: 'Verification',
  timeline: 'Timeline',
};

/** Blocker and next safe action derived only from server state (UI-SPEC §7.2, §8). */
export function guidance(
  d: IncidentDetail,
  freshness: string | null,
  telemetryFailed = false,
): { blocker: string; next: string } {
  const i = d.incident;
  const a = i.currentAssignment;
  if (i.state === 'RECOVERED')
    return { blocker: 'None — recovered by canonical closeout', next: 'Review the closeout evidence' };
  if (!a) return { blocker: 'No owner', next: 'Assign an owner' };
  if (!a.acceptedAt) return { blocker: 'Assignment not accepted', next: 'The assignee accepts ownership' };
  if (i.deadlineStatus === 'EXPIRED')
    return { blocker: 'Response deadline expired', next: 'Escalate or contain under the pinned procedure' };
  // A failed telemetry refresh means the retained freshness is not current: never reason from it as if it were.
  if (telemetryFailed)
    return {
      blocker: 'Telemetry refresh failed',
      next: 'Restore the telemetry connection before relying on the last loaded reading',
    };
  if (freshness === 'NO_SIGNAL')
    return { blocker: 'No bound sensor signal', next: 'Bind a sensor or record an authorized manual observation' };
  if (freshness && freshness !== 'FRESH')
    return {
      blocker: `Signal is ${freshness.toLowerCase()}`,
      next: 'Restore a fresh, authenticated signal before relying on telemetry',
    };
  switch (i.state) {
    case 'AWAITING_APPROVAL':
      return { blocker: 'Bounded spend approval pending', next: 'Review the spending session in Recovery plan' };
    case 'AWAITING_EVIDENCE':
      return { blocker: 'Evidence required', next: 'Supply the missing evidence' };
    case 'PLANNING':
      return { blocker: 'No approvable plan yet', next: 'Review compatibility and quotes' };
    case 'EXECUTING':
      return { blocker: 'Approved action in progress', next: 'Track payment and fulfillment in Spend & orders' };
    case 'VERIFYING':
      return {
        blocker: 'Independent recovery evidence pending',
        next: 'Review the stable-window progress in Verification',
      };
    case 'ESCALATED':
      return { blocker: 'Escalated', next: 'Accept ownership and revalidate' };
    case 'REOPENED':
      return { blocker: 'Reopened after recovery', next: 'Triage the reopened incident' };
    default:
      return { blocker: 'Triage in progress', next: 'Acknowledge and triage' };
  }
}

export function IncidentWorkspace({ id, tab, context }: { id: string; tab: IncidentTab; context: string | null }) {
  const detail = useResource(() => api.incident(id), [id]);
  const timeline = useResource(() => api.timeline(id), [id]);
  const members = useResource(() => api.assignableMembers(id), [id]);
  const [paused, setPaused] = useState(false);
  const telemetry = useResource<Telemetry | null>(
    async () => (detail.data ? api.telemetry(detail.data.incident.assetId) : null),
    [id, detail.data?.incident.assetId],
    { pollMs: 5_000, paused },
  );
  const reloadAll = async () => {
    await Promise.all([detail.reload(), timeline.reload()]);
  };
  const nameOf = (userId: string | null | undefined) =>
    (userId && members.data?.members.find((m) => m.userId === userId)?.displayName) || userId || 'Unassigned';
  const freshness = telemetry.data
    ? telemetry.data.devices.length === 0
      ? 'NO_SIGNAL'
      : (telemetry.data.devices.map((d) => d.freshness).sort((a, b) => rank(b) - rank(a))[0] ?? 'NO_SIGNAL')
    : null;

  return (
    <>
      <h1 tabIndex={-1}>Incident {id}</h1>
      <Loadable res={detail} what="incident">
        {(d) => {
          const i = d.incident;
          const g = guidance(d, freshness, telemetry.error !== null);
          return (
            <>
              <section className="incident-status controller" role="region" aria-label="Incident status">
                <Readout
                  telemetry={telemetry.data}
                  freshness={freshness}
                  paused={paused}
                  refreshError={telemetry.error}
                />
                <div className="plate-main">
                  <div className="badges">
                    <AxisBadge axis="incident-state" value={i.state} />
                    <AxisBadge axis="urgency" value={i.urgency} />
                    <AxisBadge axis="deadline" value={i.deadlineStatus} />
                    {i.triggerInputOrigin === 'SIMULATED_INPUT' ? (
                      <span className="label-sim">SIMULATED_INPUT</span>
                    ) : null}
                  </div>
                  <dl className="status-grid">
                    <div className="deadline-current">
                      <dt>Current deadline</dt>
                      <dd>
                        <UtcSplit iso={i.currentResponseDeadlineAt} />{' '}
                        {i.deadlineOverdue ? <strong>(overdue)</strong> : null}
                      </dd>
                    </div>
                    <div>
                      <dt>Original deadline</dt>
                      <dd>{formatUtc(i.originalResponseDeadlineAt)}</dd>
                    </div>
                    <div>
                      <dt>Owner</dt>
                      <dd>
                        {nameOf(i.currentAssignment?.assigneeUserId)}
                        {i.currentAssignment
                          ? i.currentAssignment.acceptedAt
                            ? ' (accepted)'
                            : ' (not accepted)'
                          : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>Blocker</dt>
                      <dd>{g.blocker}</dd>
                    </div>
                    <div className="next-action">
                      <dt>Next safe action</dt>
                      <dd>{g.next}</dd>
                    </div>
                    <div>
                      <dt>Asset</dt>
                      <dd>
                        <Code>{i.assetId}</Code>
                      </dd>
                    </div>
                  </dl>
                </div>
              </section>
              <nav className="section-nav" aria-label="Incident sections">
                <ul>
                  {INCIDENT_TABS.map((t) => (
                    <li key={t}>
                      <Link
                        to={t === 'overview' ? `/incidents/${id}` : `/incidents/${id}/${t}`}
                        className="nav-link"
                        {...(t === tab ? { 'aria-current': 'page' as const } : {})}
                      >
                        {TAB_LABEL[t]}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
              {context ? (
                <p className="notice notice-info">
                  Opened from a notification about provider contact <Code>{context}</Code>.
                </p>
              ) : null}
              {tab === 'overview' ? (
                <OverviewTab
                  detail={d}
                  timeline={timeline}
                  members={members}
                  telemetry={telemetry}
                  paused={paused}
                  setPaused={setPaused}
                  reloadAll={reloadAll}
                  nameOf={nameOf}
                />
              ) : tab === 'evidence' ? (
                <EvidenceTab incidentId={id} />
              ) : tab === 'plan' ? (
                <PlanTab incidentId={id} siteId={i.siteId} />
              ) : tab === 'spend' ? (
                <SpendTab incidentId={id} siteId={i.siteId} />
              ) : tab === 'verification' ? (
                <VerificationTab incidentId={id} />
              ) : (
                <TimelineTab timeline={timeline} nameOf={nameOf} />
              )}
            </>
          );
        }}
      </Loadable>
    </>
  );
}

function rank(f: string): number {
  return ({ FRESH: 0, STALE: 1, OFFLINE: 2, INVALID: 3 } as Record<string, number>)[f] ?? 4;
}

/** A UTC instant with the time large and the date small (same text as formatUtc). */
function UtcSplit({ iso }: { iso: string | null | undefined }) {
  const text = formatUtc(iso);
  if (!/^\d{4}-\d{2}-\d{2} /.test(text)) return <>{text}</>;
  return (
    <>
      <span className="deadline-date">{text.slice(0, 10)}</span> <span>{text.slice(11)}</span>
    </>
  );
}

/**
 * The controller readout: the asset's newest temperature from the telemetry the workspace already loads (selection and
 * honesty rules in ./readout.ts). It reads as the newest reading only while the signal is FRESH and the latest refresh
 * succeeded; otherwise it says "last known, not live", and after a failed refresh it shows the error instead of the
 * retained freshness. The faceplate heads every incident section, so the failure is visible on every tab. A
 * simulator's value carries SIMULATED_INPUT at the number, as the Telemetry panel shows it, and is never styled live.
 */
function Readout({
  telemetry,
  freshness,
  paused,
  refreshError,
}: {
  telemetry: Telemetry | null;
  freshness: string | null;
  paused: boolean;
  refreshError: string | null;
}) {
  const m = readoutModel({ telemetry, freshness, paused, refreshError });
  return (
    <div className="readout">
      <p className="readout-label">{m.label}</p>
      {m.last ? (
        <p className="readout-value" data-live={String(m.live)} data-simulated={String(m.simulated)}>
          {formatMilliCelsius(m.last.valueInt)}
        </p>
      ) : freshness === null && refreshError === null ? (
        <p className="readout-value readout-none">Signal freshness loading…</p>
      ) : (
        <p className="readout-value readout-none">No reading</p>
      )}
      <div className="readout-meta">
        {m.freshness ? <AxisBadge axis="freshness" value={m.freshness} /> : null}
        {m.simulated ? <span className="label-sim">SIMULATED_INPUT</span> : null}
        {m.last ? <span>at {formatUtc(m.last.eventAt).slice(11)}</span> : null}
        {m.beyond ? (
          <span className="tag-alert">
            <Icon shape="triangle" />
            {m.beyond === 'ABOVE' ? 'Above threshold' : 'Below threshold'}
          </span>
        ) : null}
      </div>
      {m.refreshError ? (
        <p className="notice notice-error readout-error">
          Telemetry refresh failed: {m.refreshError} The value shown is the last one loaded.
        </p>
      ) : null}
      {m.threshold ? (
        <p className="readout-meta">
          Pinned threshold {formatMilliCelsius(m.threshold.thresholdInt)} ({m.threshold.comparator.toLowerCase()})
        </p>
      ) : null}
    </div>
  );
}
