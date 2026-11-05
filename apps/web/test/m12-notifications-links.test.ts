// FR-20 (UI layer) and the M12 open-redirect review item: deep links from notifications are accepted only as
// same-origin application paths on the route allowlist (no scheme, host, protocol-relative, backslash, encoded
// traversal or javascript: URLs), repeated notifications for the same trigger/incident/reason collapse into one item
// with a count, titles for unknown outcomes never read as success, and delivery is never acknowledgement.
import { describe, expect, it } from 'vitest';
import { collapseNotifications, notificationTitle, recoveryPathText, safeDeepLink } from '../src/notifications.js';

describe('M12 notification deep links and dedupe', () => {
  it('accepts only allowlisted same-origin application paths', () => {
    expect(safeDeepLink('/incidents/inc_abcd-1234')).toBe('/incidents/inc_abcd-1234');
    expect(safeDeepLink('/incidents/inc_abcd-1234/plan')).toBe('/incidents/inc_abcd-1234/plan');
    expect(safeDeepLink('/incidents/inc_abcd-1234/providers/contacts/pcr_abcd-1234')).toBe(
      '/incidents/inc_abcd-1234/providers/contacts/pcr_abcd-1234',
    );
    for (const bad of [
      'https://evil.example/incidents/inc_abcd-1234',
      '//evil.example/incidents',
      '/\\evil.example',
      'javascript:alert(1)',
      '/incidents/../../admin',
      '/incidents/%2e%2e/x',
      '/incidents/inc_abcd-1234?next=https://evil.example',
      '/login?redirect=//evil',
      ' /incidents/inc_abcd-1234',
      '/incidents/inc_abcd-1234#x',
      '',
    ])
      expect(safeDeepLink(bad), bad).toBeNull();
  });

  it('collapses repeats of the same trigger, incident and reason, newest first, with a count', () => {
    const n = (
      id: string,
      kind: string,
      inc: string,
      reason: string,
      at: string,
      state: 'DELIVERED' | 'UNKNOWN' = 'DELIVERED',
    ) => ({
      notificationId: id,
      triggerKind: kind,
      titleCode: kind,
      severity: 'HIGH',
      deepLink: `/incidents/${inc}`,
      context: { incidentId: inc, reasonCode: reason, recoveryPath: 'REVIEW_APPROVAL' },
      state,
      recipientRole: 'maintenance_approver',
      createdAt: at,
    });
    const groups = collapseNotifications([
      n('ntf_1', 'APPROVAL_REQUIRED', 'inc_a', 'APPROVAL_PENDING', '2026-11-05T10:00:00.000Z'),
      n('ntf_2', 'APPROVAL_REQUIRED', 'inc_a', 'APPROVAL_PENDING', '2026-11-05T10:05:00.000Z'),
      n('ntf_2', 'APPROVAL_REQUIRED', 'inc_a', 'APPROVAL_PENDING', '2026-11-05T10:05:00.000Z'),
      n('ntf_3', 'APPROVAL_REQUIRED', 'inc_b', 'APPROVAL_PENDING', '2026-11-05T09:00:00.000Z'),
      n('ntf_4', 'SPEND_EXCEPTION', 'inc_a', 'INTENT_UNKNOWN', '2026-11-05T11:00:00.000Z', 'UNKNOWN'),
    ]);
    expect(groups.map((g) => [g.latest.notificationId, g.count])).toEqual([
      ['ntf_4', 1],
      ['ntf_2', 2],
      ['ntf_3', 1],
    ]);
  });

  it('titles and recovery paths for unknown outcomes never read as success', () => {
    for (const code of ['SPEND_UNKNOWN', 'PROVIDER_OUTCOME_UNKNOWN', 'PROVIDER_OUTCOME_MANUAL_REVIEW'])
      expect(notificationTitle(code, 'SPEND_EXCEPTION')).not.toMatch(/success|confirmed|complete|paid/i);
    expect(notificationTitle('SPEND_UNKNOWN', 'SPEND_EXCEPTION')).toBe('Spend outcome unknown');
    expect(notificationTitle('NOT_A_KNOWN_CODE', 'EVIDENCE_GAP')).toMatch(/evidence gap/i);
    expect(recoveryPathText('REVIEW_APPROVAL')).toBe('Review approval');
    expect(recoveryPathText('UNMAPPED_PATH')).toMatch(/open the incident/i);
  });
});
