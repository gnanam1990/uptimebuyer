// Notifications (FR-20): the signed-in person's own role-routed notifications, collapsed per trigger/incident/reason,
// with the recovery path and an in-app deep link that is used only when it is an allowlisted application route.
// Delivery state is its own axis; unknown outcomes are never phrased or colored as success.
import { api, useResource } from '../api';
import { AxisBadge } from '../components/AxisBadge';
import { formatUtc } from '../format';
import { collapseNotifications, notificationTitle, recoveryPathText, safeDeepLink } from '../notifications';
import { Link } from '../router';
import { Code, Loadable } from './common';

export function Notifications() {
  const res = useResource(() => api.notifications(), [], { pollMs: 30_000 });
  const groups = res.data ? collapseNotifications(res.data.notifications) : [];
  return (
    <>
      <h1 tabIndex={-1}>Notifications{res.data ? ` — ${groups.length}` : ''}</h1>
      <section className="panel" aria-labelledby="notes-h">
        <h2 id="notes-h">Your notifications</h2>
        <Loadable res={res} what="notifications">
          {() =>
            groups.length === 0 ? (
              <p>No notifications for your roles.</p>
            ) : (
              <ul className="notifications" aria-label="Notifications">
                {groups.map((g) => {
                  const n = g.latest;
                  const ctx = n.context as Record<string, unknown>;
                  const link = safeDeepLink(n.deepLink);
                  const incidentId = typeof ctx.incidentId === 'string' ? ctx.incidentId : null;
                  return (
                    <li key={g.key} data-trigger-kind={n.triggerKind} className="card">
                      <h3>{notificationTitle(n.titleCode, n.triggerKind)}</h3>
                      <div className="badges">
                        <AxisBadge axis="urgency" value={n.severity} prefix="Severity" />
                        <AxisBadge axis="notification-delivery" value={n.state} />
                      </div>
                      <p>
                        Next step: <strong>{recoveryPathText(ctx.recoveryPath)}</strong>
                        {g.count > 1 ? ` · ${g.count} updates` : ''} · routed to you as {n.recipientRole} ·{' '}
                        {formatUtc(n.createdAt)}
                      </p>
                      {typeof ctx.reasonCode === 'string' ? (
                        <p className="muted small">
                          Reason <Code>{ctx.reasonCode}</Code>
                        </p>
                      ) : null}
                      {link && incidentId ? (
                        <Link to={link} className="link-button">
                          Open incident {incidentId} context
                        </Link>
                      ) : (
                        <p className="muted small">Link withheld: not an application route.</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )
          }
        </Loadable>
      </section>
    </>
  );
}
