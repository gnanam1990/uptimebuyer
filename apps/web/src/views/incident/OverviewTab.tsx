// Overview (UI-SPEC §8.0-8.1): telemetry, incident command controls (assign / accept / hand off with required reason
// and next-action deadline, compare-and-set with conflict recovery, append-only history) and the pinned SOP deadline
// control (procedure revision, basis, original and current deadline, authorized deadline events only).
import { useState } from 'react';
import {
  ApiClientError,
  type IncidentDetail,
  type Members,
  type Telemetry,
  type Timeline,
} from '@uptimebuyer/api-client';
import { api, errorText, type Resource } from '../../api';
import { useAnnounce } from '../../announce';
import { AxisBadge } from '../../components/AxisBadge';
import { ActionButton, ErrorSummary, RadioGroup, type FieldProblem, type Option } from '../../components/Forms';
import { formatDuration, formatUtc, humanize } from '../../format';
import { Code, Field } from '../common';
import { TelemetryPanel } from './TelemetryPanel';

const ASSIGN_REASONS: Option[] = [
  { value: 'SHIFT_PLAN', label: 'Shift plan' },
  { value: 'COVERAGE_GAP', label: 'Coverage gap' },
  { value: 'SKILLS_MATCH', label: 'Skills match' },
];
const HANDOFF_REASONS: Option[] = [
  { value: 'SHIFT_CHANGE', label: 'Shift change' },
  { value: 'SPECIALIST_NEEDED', label: 'Specialist needed' },
  { value: 'SITE_ACCESS', label: 'Site access' },
];
const DUE: Option[] = [
  { value: '30', label: 'In 30 minutes' },
  { value: '60', label: 'In 1 hour' },
  { value: '120', label: 'In 2 hours' },
  { value: '240', label: 'In 4 hours' },
];
const DEADLINE_REASONS: Option[] = [
  { value: 'CONTAINMENT_IN_PLACE', label: 'Containment in place' },
  { value: 'AWAITING_PART', label: 'Awaiting part delivery' },
  { value: 'SITE_ACCESS_DELAY', label: 'Site access delay' },
];
const dueAt = (minutes: string) => new Date(Date.now() + Number(minutes) * 60_000).toISOString();

/** A 409 VERSION_CONFLICT (or a superseded assignment): reload and say so, never overwrite. */
function isConflict(e: unknown): e is ApiClientError {
  return e instanceof ApiClientError && e.status === 409;
}

interface Props {
  detail: IncidentDetail;
  timeline: Resource<Timeline>;
  members: Resource<Members>;
  telemetry: Resource<Telemetry | null>;
  paused: boolean;
  setPaused: (p: boolean) => void;
  reloadAll: () => Promise<void>;
  nameOf: (id: string | null | undefined) => string;
}

export function OverviewTab(p: Props) {
  return (
    <div className="grid-2">
      <TelemetryPanel telemetry={p.telemetry} paused={p.paused} setPaused={p.setPaused} />
      <Ownership {...p} />
      <Deadline {...p} />
    </div>
  );
}

function Ownership({ detail, timeline, members, reloadAll, nameOf }: Props) {
  const announce = useAnnounce();
  const i = detail.incident;
  const a = i.currentAssignment;
  const c = detail.commands;
  const [mode, setMode] = useState<'none' | 'assign' | 'handoff'>('none');
  const [who, setWho] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setWho(null);
    setReason(null);
    setDue(null);
    setProblems([]);
  };
  const open = (m: 'assign' | 'handoff') => {
    reset();
    setConflict(null);
    setError(null);
    setMode(m);
  };

  async function run(label: string, fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setConflict(null);
      await reloadAll();
      announce(done);
      setMode('none');
      reset();
    } catch (e) {
      if (isConflict(e)) {
        await reloadAll();
        const msg = `This incident changed while you were working${e.currentVersion ? ` (version ${e.currentVersion} is now current)` : ''}. The current assignment and deadline were reloaded and nothing was overwritten; review them and submit again if it still applies.`;
        setConflict(msg);
        announce(msg, { assertive: true });
      } else {
        const t = errorText(e).text;
        setError(`${label} did not complete. ${t}`);
        announce(`${label} did not complete. ${t}`, { assertive: true });
      }
    } finally {
      setBusy(false);
    }
  }

  const memberOptions = (exclude: string | null): Option[] =>
    (members.data?.members ?? [])
      .filter((m) => m.userId !== exclude)
      .map((m) => ({ value: m.userId, label: m.displayName, hint: m.roles.join(', ') }));

  function submit() {
    const errs: FieldProblem[] = [];
    if (!who)
      errs.push({ fieldId: `${mode}-who`, message: mode === 'assign' ? 'Choose an assignee' : 'Choose a next owner' });
    if (!reason) errs.push({ fieldId: `${mode}-reason`, message: 'Choose a reason' });
    if (mode === 'handoff' && !due) errs.push({ fieldId: `${mode}-due`, message: 'Choose a next-action deadline' });
    setProblems(errs);
    if (errs.length > 0) return;
    const name = nameOf(who);
    if (mode === 'assign')
      void run(
        'Assignment',
        () =>
          api.assign(
            i.incidentId,
            { assigneeUserId: who!, reasonCode: reason!, ...(due ? { nextActionDueAt: dueAt(due) } : {}) },
            { expectedVersion: i.version },
          ),
        `Incident assigned to ${name}.`,
      );
    else
      void run(
        'Handoff',
        () =>
          api.handoff(
            i.incidentId,
            { nextOwnerUserId: who!, reasonCode: reason!, nextActionDueAt: dueAt(due!) },
            { expectedVersion: i.version },
          ),
        `Handed off to ${name}; next action due ${formatUtc(dueAt(due!))}.`,
      );
  }

  const why = (k: string) => {
    const x = c[k];
    return x && !x.allowed ? `Unavailable: ${humanize(x.reasonCode ?? 'NOT_PERMITTED')}.` : null;
  };

  return (
    <section className="panel" role="region" aria-label="Ownership">
      <h2>Ownership</h2>
      <dl className="kv">
        <Field label="Current owner">
          {nameOf(a?.assigneeUserId)}{' '}
          {a ? (a.acceptedAt ? `(accepted ${formatUtc(a.acceptedAt)})` : '(not accepted)') : ''}
        </Field>
        <Field label="Assignment">
          {a ? (
            <>
              {humanize(a.assignmentKind)} by{' '}
              {a.assignedBy.kind === 'HUMAN' ? nameOf(a.assignedBy.id) : a.assignedBy.kind} at {formatUtc(a.assignedAt)}{' '}
              · reason <Code>{a.reasonCode}</Code> · incident version {a.incidentVersion}
            </>
          ) : (
            'None'
          )}
        </Field>
        <Field label="Next-action deadline">{formatUtc(a?.nextActionDueAt)}</Field>
      </dl>
      {conflict ? (
        <div className="notice notice-warning" role="alert">
          {conflict}
        </div>
      ) : null}
      {error ? (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="actions">
        <ActionButton onClick={() => open('assign')} disabledReason={why('assign')}>
          Assign incident…
        </ActionButton>
        <ActionButton
          kind="primary"
          disabledReason={why('accept')}
          onClick={() =>
            void run(
              'Acceptance',
              () => api.accept(i.incidentId, a!.assignmentId, { expectedVersion: i.version }),
              'Assignment accepted. You are the accepted owner.',
            )
          }
        >
          Accept assignment
        </ActionButton>
        <ActionButton onClick={() => open('handoff')} disabledReason={why('handoff')}>
          Hand off incident…
        </ActionButton>
      </div>
      {mode !== 'none' ? (
        <form
          aria-label={mode === 'assign' ? 'Assign incident' : 'Hand off incident'}
          className="command-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <ErrorSummary problems={problems} />
          <RadioGroup
            id={`${mode}-who`}
            name={`${mode}-who`}
            legend={mode === 'assign' ? 'Assignee' : 'Next owner'}
            options={memberOptions(mode === 'handoff' ? (a?.assigneeUserId ?? null) : null)}
            value={who}
            onChange={setWho}
            error={problems.find((x) => x.fieldId === `${mode}-who`)?.message ?? null}
          />
          <RadioGroup
            id={`${mode}-reason`}
            name={`${mode}-reason`}
            legend="Reason"
            options={mode === 'assign' ? ASSIGN_REASONS : HANDOFF_REASONS}
            value={reason}
            onChange={setReason}
            error={problems.find((x) => x.fieldId === `${mode}-reason`)?.message ?? null}
          />
          <RadioGroup
            id={`${mode}-due`}
            name={`${mode}-due`}
            legend="Next-action deadline"
            options={DUE}
            value={due}
            onChange={setDue}
            error={problems.find((x) => x.fieldId === `${mode}-due`)?.message ?? null}
          />
          <p className="muted">
            Cross-tenant people are never offered. The server re-checks your role, the current version and the assignee.
          </p>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {mode === 'assign' ? 'Assign incident' : 'Hand off incident'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setMode('none')}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <div className="table-wrap" data-scroll-region role="region" aria-label="Assignment history table" tabIndex={0}>
        <table className="responsive">
          <caption>Assignment history</caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Assignee</th>
              <th scope="col">Assigned</th>
              <th scope="col">Reason</th>
              <th scope="col">Next action due</th>
              <th scope="col">Accepted</th>
              <th scope="col">Superseded</th>
            </tr>
          </thead>
          <tbody>
            {(timeline.data?.assignments ?? []).map((x) => (
              <tr key={x.assignmentId}>
                <td data-label="Kind">{humanize(x.assignmentKind)}</td>
                <td data-label="Assignee">{nameOf(x.assigneeUserId)}</td>
                <td data-label="Assigned">{formatUtc(x.assignedAt)}</td>
                <td data-label="Reason">
                  <Code>{x.reasonCode}</Code>
                </td>
                <td data-label="Next action due">{formatUtc(x.nextActionDueAt)}</td>
                <td data-label="Accepted">{x.acceptedAt ? formatUtc(x.acceptedAt) : 'Not accepted'}</td>
                <td data-label="Superseded">{x.supersededAt ? formatUtc(x.supersededAt) : 'Current'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Deadline({ detail, timeline, reloadAll, nameOf }: Props) {
  const announce = useAnnounce();
  const i = detail.incident;
  const proc = detail.procedure;
  const c = detail.commands;
  const [eventType, setEventType] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [shift, setShift] = useState<string | null>(null);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [message, setMessage] = useState<{ kind: 'warning' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const all: { value: 'PAUSE' | 'RESUME' | 'SHORTEN' | 'EXTEND'; label: string; key: string }[] = [
    { value: 'PAUSE', label: 'Pause', key: 'deadlinePause' },
    { value: 'RESUME', label: 'Resume', key: 'deadlineResume' },
    { value: 'SHORTEN', label: 'Shorten', key: 'deadlineShorten' },
    { value: 'EXTEND', label: 'Extend', key: 'deadlineExtend' },
  ];
  const allowed = all.filter((o) => c[o.key]?.allowed);
  const refused = all.filter((o) => !c[o.key]?.allowed);
  const shiftOptions: Option[] =
    eventType === 'EXTEND'
      ? [
          { value: '600000', label: 'Extend by 10 minutes' },
          {
            value: String(Math.min(proc.maxExtensionMs, 900_000)),
            label: `Extend by ${formatDuration(Math.min(proc.maxExtensionMs, 900_000))}`,
          },
        ]
      : [
          { value: '-600000', label: 'Shorten by 10 minutes' },
          { value: '-900000', label: 'Shorten by 15 minutes' },
        ];

  async function submit() {
    const errs: FieldProblem[] = [];
    if (!eventType) errs.push({ fieldId: 'dl-event', message: 'Choose a deadline event' });
    if (!reason) errs.push({ fieldId: 'dl-reason', message: 'Choose a reason' });
    if ((eventType === 'SHORTEN' || eventType === 'EXTEND') && !shift)
      errs.push({ fieldId: 'dl-shift', message: 'Choose the new deadline' });
    setProblems(errs);
    if (errs.length > 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const newDeadlineAt =
        eventType === 'SHORTEN' || eventType === 'EXTEND'
          ? new Date(Date.parse(i.currentResponseDeadlineAt) + Number(shift)).toISOString()
          : undefined;
      await api.adjustDeadline(
        i.incidentId,
        { eventType: eventType as 'PAUSE', reasonCode: reason!, ...(newDeadlineAt ? { newDeadlineAt } : {}) },
        { expectedVersion: i.version },
      );
      await reloadAll();
      announce(`Deadline event ${eventType} recorded. The original deadline is unchanged.`);
      setEventType(null);
      setReason(null);
      setShift(null);
    } catch (e) {
      if (isConflict(e)) {
        await reloadAll();
        const t =
          'This incident changed while you were working. The current deadline was reloaded and nothing was overwritten; review it and submit again if it still applies.';
        setMessage({ kind: 'warning', text: t });
        announce(t, { assertive: true });
      } else {
        const t = `The deadline event was not recorded. ${errorText(e).text}`;
        setMessage({ kind: 'error', text: t });
        announce(t, { assertive: true });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" role="region" aria-label="Response deadline">
      <h2>Response deadline</h2>
      <dl className="kv">
        <Field label="Pinned procedure">
          {proc.procedureKey} revision {proc.revision} <Code>{proc.procedureRevisionId}</Code>
        </Field>
        <Field label="Basis">
          {humanize(proc.deadlineKind)} deadline from {humanize(proc.deadlineBasis).toLowerCase()} ·{' '}
          {formatDuration(proc.responseDeadlineMs)} · timezone basis {i.deadlineTimezoneBasis}
        </Field>
        <Field label="Original deadline">
          {formatUtc(i.originalResponseDeadlineAt)} (never edited; later procedure publications do not move it)
        </Field>
        <Field label="Current deadline">
          {formatUtc(i.currentResponseDeadlineAt)} <AxisBadge axis="deadline" value={i.deadlineStatus} />
        </Field>
        <Field label="Procedure permits">
          {proc.pauseAllowed ? 'pause' : 'no pause'}, extension up to {formatDuration(proc.maxExtensionMs)}, adjustments
          by {proc.adjustRole}
        </Field>
      </dl>
      {message ? (
        <div className={`notice notice-${message.kind}`} role="alert">
          {message.text}
        </div>
      ) : null}
      <div
        className="table-wrap"
        data-scroll-region
        role="region"
        aria-label="Deadline event history table"
        tabIndex={0}
      >
        <table className="responsive">
          <caption>Deadline event history</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Event</th>
              <th scope="col">Prior deadline</th>
              <th scope="col">New deadline</th>
              <th scope="col">Status</th>
              <th scope="col">Authorized by</th>
              <th scope="col">Reason</th>
              <th scope="col">Effective</th>
            </tr>
          </thead>
          <tbody>
            {(timeline.data?.deadlineEvents ?? []).map((ev) => (
              <tr key={ev.sequence}>
                <td data-label="#">{ev.sequence}</td>
                <td data-label="Event">{ev.eventType}</td>
                <td data-label="Prior deadline">{formatUtc(ev.priorDeadlineAt)}</td>
                <td data-label="New deadline">{formatUtc(ev.newDeadlineAt)}</td>
                <td data-label="Status">{ev.newStatus}</td>
                <td data-label="Authorized by">
                  {ev.authorizedBy.kind === 'HUMAN' ? nameOf(ev.authorizedBy.id) : ev.authorizedBy.kind}
                  {ev.authorizedRole ? ` (${ev.authorizedRole})` : ''}
                </td>
                <td data-label="Reason">
                  <Code>{ev.reasonCode}</Code>
                </td>
                <td data-label="Effective">{formatUtc(ev.effectiveAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        aria-label="Record deadline event"
        className="command-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <ErrorSummary problems={problems} />
        {allowed.length === 0 ? (
          <p>No deadline event is available to you now.</p>
        ) : (
          <RadioGroup
            id="dl-event"
            name="dl-event"
            legend="Deadline event"
            options={allowed.map((o) => ({ value: o.value, label: o.label }))}
            value={eventType}
            onChange={(v) => {
              setEventType(v);
              setShift(null);
            }}
            error={problems.find((x) => x.fieldId === 'dl-event')?.message ?? null}
          />
        )}
        {refused.length > 0 ? (
          <ul className="muted small">
            {refused.map((o) => (
              <li key={o.value}>
                {o.label} is not offered: {humanize(c[o.key]?.reasonCode ?? 'NOT_PERMITTED')}.
              </li>
            ))}
          </ul>
        ) : null}
        {eventType === 'SHORTEN' || eventType === 'EXTEND' ? (
          <RadioGroup
            id="dl-shift"
            name="dl-shift"
            legend="New deadline"
            options={shiftOptions}
            value={shift}
            onChange={setShift}
            error={problems.find((x) => x.fieldId === 'dl-shift')?.message ?? null}
          />
        ) : null}
        <RadioGroup
          id="dl-reason"
          name="dl-reason"
          legend="Reason"
          options={DEADLINE_REASONS}
          value={reason}
          onChange={setReason}
          error={problems.find((x) => x.fieldId === 'dl-reason')?.message ?? null}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || allowed.length === 0}>
          Record deadline event
        </button>
      </form>
    </section>
  );
}
