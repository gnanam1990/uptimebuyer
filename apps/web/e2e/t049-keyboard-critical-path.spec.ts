// T-049 — Keyboard and screen-reader critical path (FR-19, NFR-07, FR-11, INV-12).
// Keyboard only (Tab to reach a control, Enter/Space/arrow keys to act; no mouse): register -> incident, inspect cited
// evidence in a focus-trapped drawer, compare the advisory plan, assign / accept / hand off with reason and
// next-action deadline (including a version conflict that is announced and recovered by reloading, and a validation
// error summary), review the pinned SOP and its deadline-event history and record an authorized deadline event,
// approve with the spending-session bounds displayed AND announced before approval, hold another approval, and review
// the recovery closeout. Screen-reader surface: landmarks, accessible names, live-region announcements, dialog
// semantics, visible focus and an axe-core WCAG 2.2 AA scan on every visited view. API truth is re-read to confirm.
import { expect, test } from '@playwright/test';
import {
  announcements,
  apiGet,
  apiPost,
  chooseRadio,
  expectAccessible,
  manifest,
  press,
  signIn,
  tabTo,
} from './support/fixtures.js';

test.describe.configure({ mode: 'serial' });

test('T-049 keyboard and screen-reader critical path', async ({ page }) => {
  test.setTimeout(240_000);
  const m = manifest();
  const inc = m.incidents.approval!;

  // --- Shell semantics and sign-in (popup authorization-code + PKCE; nothing stored in browser storage).
  await signIn(page, 'approver');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeAttached();
  await expect(page.getByRole('banner')).toContainText('UptimeBuyer Operations');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('note', { name: 'Environment' })).toContainText('SEEDED_TEST_DATA');
  await expect(page.getByRole('heading', { level: 1, name: /^Command Center/ })).toBeVisible();
  const storage = await page.evaluate(() => [localStorage.length, sessionStorage.length]);
  expect(storage).toEqual([0, 0]);
  await expectAccessible(page, 'command center');

  // --- Register -> incident by keyboard; visible focus on the link.
  const open = page.getByRole('link', { name: `Open incident ${inc.incidentId}` }).first();
  await tabTo(page, open);
  const outline = await open.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/incidents/${inc.incidentId}$`));
  await expect(page.getByRole('heading', { level: 1, name: `Incident ${inc.incidentId}` })).toBeVisible();
  const status = page.getByRole('region', { name: 'Incident status' });
  await expect(status).toContainText('Awaiting approval');
  await expect(status).toContainText('Current deadline');
  await expect(status).toContainText('Next safe action');
  await expect(status).toContainText('Owner');
  await expectAccessible(page, 'incident overview');

  // --- Evidence: cited facts open in a focus-trapped dialog; Escape returns focus to the trigger.
  await press(
    page,
    page.getByRole('navigation', { name: 'Incident sections' }).getByRole('link', { name: 'Evidence' }),
  );
  await expect(page).toHaveURL(new RegExp(`/incidents/${inc.incidentId}/evidence$`));
  await expect(page.getByRole('region', { name: 'Evidence revision' })).toContainText('Revision');
  await expect(
    page
      .getByText('MODEL PROPOSAL', { exact: false })
      .or(page.getByText('No model proposal', { exact: false }))
      .first(),
  ).toBeVisible();
  const cite = page.getByRole('button', { name: /^Open citation/ }).first();
  await press(page, cite);
  const drawer = page.getByRole('dialog', { name: 'Citation' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Document checksum');
  await expect(drawer).toContainText('Revision');
  await expect(drawer).toContainText('Verified against the stored document');
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await expectAccessible(page, 'citation dialog');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(cite).toBeFocused();

  // --- Plan comparison: deterministic decision and advisory ranking.
  await press(
    page,
    page.getByRole('navigation', { name: 'Incident sections' }).getByRole('link', { name: 'Recovery plan' }),
  );
  await expect(page.getByRole('table', { name: 'Compatibility decisions' })).toContainText('Allow');
  const plans = page.getByRole('table', { name: 'Recovery plan comparison (advisory ranking)' });
  await expect(plans).toBeVisible();
  await expect(plans.getByRole('row')).not.toHaveCount(1);
  await expectAccessible(page, 'recovery plan');

  // --- Assign to self, accept, then hand off with reason and next-action deadline.
  await press(
    page,
    page.getByRole('navigation', { name: 'Incident sections' }).getByRole('link', { name: 'Overview' }),
  );
  const owner = page.getByRole('region', { name: 'Ownership' });
  await press(page, owner.getByRole('button', { name: 'Assign incident…' }));
  const assignForm = owner.getByRole('form', { name: 'Assign incident' });
  await chooseRadio(page, assignForm.getByRole('radiogroup', { name: 'Assignee' }), 'approver');
  await chooseRadio(page, assignForm.getByRole('radiogroup', { name: 'Reason' }), 'Shift plan');
  await chooseRadio(page, assignForm.getByRole('radiogroup', { name: 'Next-action deadline' }), 'In 1 hour');
  await press(page, assignForm.getByRole('button', { name: 'Assign incident' }));
  await expect.poll(() => announcements(page)).toContain('Incident assigned to approver');
  await press(page, owner.getByRole('button', { name: 'Accept assignment' }));
  await expect.poll(() => announcements(page)).toContain('Assignment accepted');

  // Another operator changes the incident meanwhile (acknowledgement bumps the version).
  const detail = await apiGet<{ incident: { version: number } }>('operator', `/v1/incidents/${inc.incidentId}`);
  const ack = await apiPost('operator', `/v1/incidents/${inc.incidentId}:acknowledge`, {}, detail.incident.version);
  expect(ack.status).toBe(200);

  await press(page, owner.getByRole('button', { name: 'Hand off incident…' }));
  const handoff = owner.getByRole('form', { name: 'Hand off incident' });
  await chooseRadio(page, handoff.getByRole('radiogroup', { name: 'Next owner' }), 'operator2');
  // Submitting without a reason shows a linked error summary that receives focus.
  await press(page, handoff.getByRole('button', { name: 'Hand off incident' }));
  const summary = page.getByRole('alert').filter({ hasText: 'There is a problem' });
  await expect(summary).toBeVisible();
  await expect(summary.getByRole('link', { name: 'Choose a reason' })).toBeVisible();
  await press(page, summary.getByRole('link', { name: 'Choose a reason' }));
  await chooseRadio(page, handoff.getByRole('radiogroup', { name: 'Reason' }), 'Shift change');
  await chooseRadio(page, handoff.getByRole('radiogroup', { name: 'Next-action deadline' }), 'In 2 hours');
  await press(page, handoff.getByRole('button', { name: 'Hand off incident' }));
  // The stale version is a 409: announced assertively, current state reloaded, nothing overwritten.
  const conflict = page.getByRole('alert').filter({ hasText: 'changed while you were working' });
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText('reloaded');
  await press(page, handoff.getByRole('button', { name: 'Hand off incident' }));
  await expect.poll(() => announcements(page)).toContain('Handed off to operator2');
  const history = page.getByRole('table', { name: 'Assignment history' });
  await expect(history).toContainText('Handoff');
  await expect(history).toContainText('SHIFT_CHANGE');
  const truth = await apiGet<{ incident: { currentAssignment: { assigneeUserId: string; nextActionDueAt: string } } }>(
    'operator',
    `/v1/incidents/${inc.incidentId}`,
  );
  expect(truth.incident.currentAssignment.assigneeUserId).toBe(m.users.operator2!.userId);
  expect(truth.incident.currentAssignment.nextActionDueAt).not.toBeNull();

  // --- Pinned SOP: procedure revision, original and current deadline, authorized event history.
  const deadline = page.getByRole('region', { name: 'Response deadline' });
  await expect(deadline).toContainText('cold-chain');
  await expect(deadline).toContainText('Original deadline');
  await expect(deadline).toContainText('Current deadline');
  const events = deadline.getByRole('table', { name: 'Deadline event history' });
  await expect(events).toContainText('SET');
  const before = await apiGet<{ incident: { originalResponseDeadlineAt: string } }>(
    'operator',
    `/v1/incidents/${inc.incidentId}`,
  );
  const adjust = deadline.getByRole('form', { name: 'Record deadline event' });
  await chooseRadio(page, adjust.getByRole('radiogroup', { name: 'Deadline event' }), 'Pause');
  await chooseRadio(page, adjust.getByRole('radiogroup', { name: 'Reason' }), 'Containment in place');
  await press(page, adjust.getByRole('button', { name: 'Record deadline event' }));
  await expect.poll(() => announcements(page)).toContain('Deadline event PAUSE recorded');
  await expect(events).toContainText('PAUSE');
  await expect(events).toContainText('CONTAINMENT_IN_PLACE');
  const after = await apiGet<{ incident: { originalResponseDeadlineAt: string; deadlineStatus: string } }>(
    'operator',
    `/v1/incidents/${inc.incidentId}`,
  );
  expect(after.incident.originalResponseDeadlineAt).toBe(before.incident.originalResponseDeadlineAt);
  expect(after.incident.deadlineStatus).toBe('PAUSED');
  await expectAccessible(page, 'ownership and deadline');

  // --- Approval: the bounded spending session is displayed and announced BEFORE approval.
  await press(
    page,
    page.getByRole('navigation', { name: 'Incident sections' }).getByRole('link', { name: 'Recovery plan' }),
  );
  const approvalPanel = page.getByRole('region', { name: 'Approval' });
  const bounds = approvalPanel.getByRole('group', { name: 'Spending session bounds' });
  for (const text of [inc.incidentId, inc.merchantId!, 'PART_PURCHASE', '185.00', 'USD', inc.purpose!, 'Expires'])
    await expect(bounds).toContainText(text);
  const approveBtn = approvalPanel.getByRole('button', {
    name: `Approve up to 185.00 USD for incident ${inc.incidentId}`,
  });
  await press(page, approveBtn);
  const confirm = page.getByRole('dialog', { name: 'Confirm spending approval' });
  await expect(confirm).toBeVisible();
  const said = await announcements(page);
  for (const text of [inc.incidentId, inc.merchantId!, 'PART_PURCHASE', '185.00', 'USD', inc.purpose!, 'expires'])
    expect(said).toContain(text);
  await expect(confirm).toContainText('No money moves when you approve');
  await expectAccessible(page, 'approval confirmation');
  await press(page, confirm.getByRole('button', { name: 'Confirm approval' }));
  await expect.poll(() => announcements(page)).toContain('Approval recorded');
  await expect(approvalPanel).toContainText('Kite session not confirmed');
  const planTruth = await apiGet<{
    plans: { approvalRequests: { approvalRequestId: string; approvalId: string | null }[] }[];
  }>('operator', `/v1/incidents/${inc.incidentId}/plans`);
  const req = planTruth.plans
    .flatMap((p) => p.approvalRequests)
    .find((r) => r.approvalRequestId === inc.approvalRequestId)!;
  expect(req.approvalId).toMatch(/^apr_/);
  await expect(approvalPanel).toContainText(req.approvalId!);

  // --- Hold on a second incident: an attested decision that authorizes nothing.
  const inc2 = m.incidents.approval2!;
  // In-app navigation only: the access token lives in memory, so a reload would (correctly) require sign-in again.
  await press(page, page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Incidents' }));
  await press(page, page.getByRole('link', { name: `Open incident ${inc2.incidentId}` }));
  await expect(page.getByRole('heading', { level: 1, name: `Incident ${inc2.incidentId}` })).toBeVisible();
  await press(
    page,
    page.getByRole('navigation', { name: 'Incident sections' }).getByRole('link', { name: 'Recovery plan' }),
  );
  const panel2 = page.getByRole('region', { name: 'Approval' });
  await press(page, panel2.getByRole('button', { name: 'Hold approval…' }));
  const holdDialog = page.getByRole('dialog', { name: 'Hold approval' });
  await chooseRadio(page, holdDialog.getByRole('radiogroup', { name: 'Reason' }), 'Need a second quote');
  await press(page, holdDialog.getByRole('button', { name: 'Confirm hold' }));
  await expect.poll(() => announcements(page)).toContain('Hold recorded');
  await expect.poll(() => announcements(page)).toContain('nothing was approved');
  const held = await apiGet<{ plans: { approvalRequests: { state: string; approvalId: string | null }[] }[] }>(
    'operator',
    `/v1/incidents/${inc2.incidentId}/plans`,
  );
  expect(held.plans[0]!.approvalRequests[0]).toMatchObject({ state: 'PENDING', approvalId: null });

  // --- Closeout review on the recovered incident.
  const rec = m.incidents.recovered!;
  await press(page, page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Incidents' }));
  await press(page, page.getByRole('link', { name: `Open incident ${rec.incidentId}` }));
  await press(
    page,
    page.getByRole('navigation', { name: 'Incident sections' }).getByRole('link', { name: 'Verification' }),
  );
  const verification = page.getByRole('region', { name: 'Recovery verification' });
  const gate = await apiGet<{ gate: { recovered: boolean; closeoutId: string } }>(
    'operator',
    `/v1/incidents/${rec.incidentId}/recovery`,
  );
  expect(gate.gate.recovered).toBe(true);
  await expect(verification).toContainText(gate.gate.closeoutId);
  await expect(verification.locator('[data-axis="recovery"][data-value="RECOVERED"]')).toBeVisible();
  await expect(verification).toContainText('Provider completion is shown but never proves recovery');
  await expectAccessible(page, 'verification');
});
