// M12 end-to-end harness (T-049..T-052): seeds a throwaway database through the REAL module packages, hosts a test-only
// OIDC identity provider, and keeps a labelled SIMULATOR device streaming, so the operator web app (served by
// apps/api in a separate process) shows API truth rather than hand-written fixtures.
//
// It lives in apps/kite-broker/test because reaching EXECUTING/ordered/recovered states needs the in-process
// RECORDED_CONTRACT broker, importable only here (INV-06). Everything it produces is SEEDED TEST DATA: synthetic
// tenant, people, sensors (registered as SIMULATOR, every sample labelled SIMULATED_INPUT), recorded-contract payment
// outcomes, a contract-fake CMMS and synthetic citations. Nothing is real provider, payment, CMMS, sensor or recovery
// evidence, and the web app shows the environment label on every page.
//
// Protocol: run with `node --experimental-transform-types --import ./ts-register.mjs m12-e2e-stack.ts`, env
// DATABASE_URL and UB_E2E_WEB_ORIGIN (the API origin that will serve the web app). Prints one line
// `M12_STACK_READY <manifest JSON>` and keeps running (simulator + IdP) until SIGTERM, then drops the database.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerAsset, withTenantTransaction, type TenantContext } from '@uptimebuyer/data';
import { getIncident, reopenRecoveredIncident } from '@uptimebuyer/incidents';
import { dispatchOrder, reconcileOrder } from '@uptimebuyer/orders';
import {
  LocalNotificationInbox,
  dispatchNotifications,
  enqueueNotificationTrigger,
  handleNotificationEvent,
  type NotificationTrigger,
} from '@uptimebuyer/providers';
import { getCandidateAction } from '@uptimebuyer/compatibility';
import { buildSensorGateway } from '@uptimebuyer/sensor-gateway';
import { message, post, provisionDevice, temp, type TestDevice } from '../../../sensor-gateway/test/helpers.js';
import { issue, sessionRef } from '../helpers.js';
import { brokerDeps, orderFor, paidActionOf } from '../m10-helpers.js';
import {
  assess,
  createRecoveryWorld,
  dbNowMs,
  milestoneAt,
  readings,
  recoveredIncident,
  verifyingIncident,
} from '../m11-helpers.js';
import { pendingApproval } from '../m12-helpers.js';

const WEB_ORIGIN = process.env.UB_E2E_WEB_ORIGIN;
if (!WEB_ORIGIN || !/^http:\/\/127\.0\.0\.1:\d+$/.test(WEB_ORIGIN))
  throw new Error('UB_E2E_WEB_ORIGIN must be http://127.0.0.1:<port>');
const CLIENT_ID = 'uptimebuyer-web';
const REDIRECT_URI = `${WEB_ORIGIN}/auth/callback`;

let seq = 900_000;
/** A dedicated gateway with its own real-time clock, so the background feed never races the world's manual clock. */
type Feed = { gw: Awaited<ReturnType<typeof buildSensorGateway>>; clock: { now(): number } };
async function livePost(f: Feed, device: TestDevice, valueInt: number, quality = 'GOOD') {
  const res = await post(f as never, device, [
    message(++seq, f.clock.now(), [temp(device.channels.temp!, valueInt, { quality } as never)]),
  ]);
  const r = res.body.results?.[0];
  if (res.status !== 200 || !r || r.status !== 'ACCEPTED')
    throw new Error(`seed reading refused: ${res.status} ${JSON.stringify(res.body)}`);
}

async function main() {
  const w = await createRecoveryWorld('m12e2e');
  // Every seeded device is a labelled SIMULATOR with one temperature channel (a device's freshness is its worst
  // channel, so a channel that never reports would make it OFFLINE).
  const sim = (assetId: string) =>
    provisionDevice(w, {
      siteId: w.siteId,
      assetId: assetId as never,
      inputClass: 'SIMULATOR',
      channels: [{ name: 'temp', kind: 'TEMPERATURE', sourceUnit: 'CELSIUS' }],
    });
  // Registry effective dates come from the database clock (which may run slightly ahead of this host), so the feed
  // stamps readings one second ahead of host time, well inside the gateway's future-skew bound.
  const feedNow = () => Date.now() + 1_000;
  const feed: Feed = {
    clock: { now: feedNow },
    gw: await buildSensorGateway({ pool: w.db.pool, credentials: w.creds, clock: { now: feedNow } }),
  };
  const mkAsset = async (label: string) =>
    (
      await registerAsset(w.db.pool, w.admin, {
        siteId: w.siteId,
        identity: {
          manufacturer: 'True',
          model: 'T-49',
          serial: `M12-${label}-${randomBytes(2).toString('hex')}`,
          safetyClass: 'STANDARD',
          bomRevision: 'BOM-3',
        },
        source: 'API',
      })
    ).assetId;

  // --- T-049 critical path: an AWAITING_APPROVAL incident with evidence, compatibility, a plan and a pending request.
  const approval = await pendingApproval(w);
  const approval2 = await pendingApproval(w, 21_000n);
  const approvalDevice = await sim(approval.assetId);
  // Freshness states (bindings start now, so history cannot be backdated): STALE needs a reading older than the
  // 120 s freshness threshold, so the stale device reports once now and the harness waits before READY.
  const staleAsset = await mkAsset('STALE');
  const offlineAsset = await mkAsset('OFFLINE');
  const invalidAsset = await mkAsset('INVALID');
  const noSignalAsset = await mkAsset('NOSIGNAL');
  const staleDevice = await sim(staleAsset);
  await sim(offlineAsset); // bound, never reports: OFFLINE (NO_LIVE_TELEMETRY)
  const invalidDevice = await sim(invalidAsset);
  await livePost(feed, staleDevice, 4_200);
  await livePost(feed, invalidDevice, 4_300, 'SENSOR_FAULT');
  const t0 = Date.now();
  // Live feed for the approval asset every 3 s, with a 30 s excursion above the pinned 8.0 °C threshold (anomaly cue).
  let feeding = true;
  const feedLoop = (async () => {
    while (feeding) {
      const since = Date.now() - t0;
      const value = since > 40_000 && since < 70_000 ? 9_400 : 4_000 + Math.round(Math.sin(Date.now() / 20_000) * 300);
      await livePost(feed, approvalDevice, value).catch(() => {});
      await new Promise((r) => setTimeout(r, 3_000));
    }
  })();

  // --- Recovery proof: one RECOVERED incident (closeout) and one VERIFYING incident with an OBSERVING evaluation.
  const recovered = await recoveredIncident(w);
  const reopenedBase = await recoveredIncident(w);
  const verifying = await verifyingIncident(w);
  const vm = await milestoneAt(w, verifying, (await dbNowMs(w)) + 2_000);
  await readings(w, verifying.device, [{ at: vm.boundaryMs + 1_000 }, { at: vm.boundaryMs + 11_000 }]);
  await assess(w, verifying, vm.boundaryMs + 12_000);
  // Reopen the second recovered incident through the engine (repeat fault) so INCIDENT_REOPENED routes for real.
  const ri = await getIncident(w.db.pool, w.service, reopenedBase.inc.incidentId);
  await reopenRecoveredIncident(w.db.pool, w.service, ri.incidentId, {
    expectedVersion: ri.version,
    idempotencyKey: w.key('reopen'),
    reasonCode: 'REPEAT_FAULT',
    guardRef: ri.incidentId,
  });

  // --- External-outcome states on separate axes.
  // Service job (distinct lifecycle from purchase orders), dispatched and accepted.
  const job = await orderFor(w, 'SERVICE_JOB');
  await dispatchOrder(w.db.pool, w.operator, job.orderId, brokerDeps(w));
  // Post-egress UNKNOWN whose reconciliation capability then becomes UNSUPPORTED: it must stay UNKNOWN.
  const unknown = await orderFor(w, 'PART_PURCHASE');
  w.adapter.nextModes = ['DROP_RESPONSE'];
  await dispatchOrder(w.db.pool, w.operator, unknown.orderId, brokerDeps(w));
  w.adapter.lookupMode = 'UNSUPPORTED';
  w.adapter.capability = { lookupByClientOperation: false, sameKeyReplay: false };
  await reconcileOrder(w.db.pool, w.operator, unknown.orderId, brokerDeps(w)).catch(() => {});
  w.adapter.lookupMode = 'NORMAL';
  w.adapter.capability = { lookupByClientOperation: true, sameKeyReplay: true };
  // A declined payment (definite FAILED, no fulfillment).
  const declined = await orderFor(w, 'PART_PURCHASE');
  w.adapter.nextModes = ['DECLINE'];
  await dispatchOrder(w.db.pool, w.operator, declined.orderId, brokerDeps(w));
  // Kite sessions: UNKNOWN (dropped response), FAILED (declined) and never requested (issued only).
  const sessionUnknown = await paidActionOf(w, 'PART_PURCHASE');
  const suAuth = await issue(w, sessionUnknown);
  w.adapter.sessionModes = ['DROP_RESPONSE'];
  await w.broker.activateSession(sessionRef(w, suAuth.authority.executionAuthorityId)).catch(() => {});
  const sessionFailed = await paidActionOf(w, 'PART_PURCHASE');
  const sfAuth = await issue(w, sessionFailed);
  w.adapter.sessionModes = ['DECLINE'];
  await w.broker.activateSession(sessionRef(w, sfAuth.authority.executionAuthorityId)).catch(() => {});
  const sessionPending = await paidActionOf(w, 'PART_PURCHASE');
  const spAuth = await issue(w, sessionPending);

  // --- Notifications (FR-20): route the real outbox events through M07, plus the triggers M09/M10/M11 own.
  for (const type of [
    'incident.opened.v1',
    'incident.reopened.v1',
    'incident.state_changed.v1',
    'incident.assignment_changed.v1',
    'incident.deadline_changed.v1',
  ]) {
    const { rows } = await w.db.pool.query(
      `SELECT * FROM outbox_events WHERE tenant_id = $1 AND event_type = $2 ORDER BY seq`,
      [w.tenant.tenantId, type],
    );
    for (const r of rows)
      await handleNotificationEvent(w.db.pool, {
        eventId: r.id,
        eventType: r.event_type,
        occurredAt: r.occurred_at.toISOString(),
        tenantId: r.tenant_id,
        aggregateType: r.aggregate_type,
        aggregateId: r.aggregate_id,
        aggregateVersion: r.aggregate_version,
        correlationId: r.correlation_id,
        causationId: r.causation_id,
        schemaVersion: 1,
        payload: r.payload,
      } as never);
  }
  const trigger = (t: Omit<NotificationTrigger, 'sourceEventId'>, ctx: TenantContext = w.service) =>
    withTenantTransaction(w.db.pool, ctx, (c) =>
      enqueueNotificationTrigger(c, ctx, { ...t, sourceEventId: `evt_${randomBytes(8).toString('hex')}` }),
    );
  for (const key of ['a', 'b'])
    await trigger({
      triggerKind: 'APPROVAL_REQUIRED',
      sourceEventType: 'plan.created.v1',
      logicalKey: `approval-required:${approval.approvalRequestId}:${key}`,
      incidentId: approval.incidentId,
      reasonCode: 'APPROVAL_PENDING',
      deepLink: `/incidents/${approval.incidentId}/plan`,
    });
  await trigger({
    triggerKind: 'CRITICAL_INCIDENT',
    sourceEventType: 'incident.opened.v1',
    titleCode: 'CRITICAL_INCIDENT_OPENED',
    logicalKey: `incident-opened:${approval.incidentId}`,
    incidentId: approval.incidentId,
    reasonCode: 'CRITICAL_INCIDENT_OPENED',
  });
  await trigger({
    triggerKind: 'SPEND_EXCEPTION',
    sourceEventType: 'commercial_intent.state_changed.v1',
    titleCode: 'SPEND_UNKNOWN',
    logicalKey: `spend-exception:${unknown.out.order.commercialIntentId}:UNKNOWN`,
    incidentId: unknown.action.incidentId,
    reasonCode: 'INTENT_UNKNOWN',
    deepLink: `/incidents/${unknown.action.incidentId}/spend`,
  });
  await trigger({
    triggerKind: 'PROVIDER_CHANGE',
    sourceEventType: 'service_job.state_changed.v1',
    titleCode: 'PROVIDER_OUTCOME_UNKNOWN',
    logicalKey: `provider-change:${job.orderId}`,
    incidentId: job.action.incidentId,
    reasonCode: 'PROVIDER_OUTCOME_UNKNOWN',
    deepLink: `/incidents/${job.action.incidentId}/spend`,
  });
  await trigger({
    triggerKind: 'RECOVERY',
    sourceEventType: 'incident.recovered.v1',
    titleCode: 'INCIDENT_RECOVERED',
    logicalKey: `recovered:${recovered.inc.incidentId}`,
    incidentId: recovered.inc.incidentId,
    reasonCode: 'RECOVERY_PASSED',
    deepLink: `/incidents/${recovered.inc.incidentId}/verification`,
  });
  await dispatchNotifications(w.db.pool, new LocalNotificationInbox(), { limit: 500 });
  // An evidence gap whose delivery timed out: its delivery state stays UNKNOWN (never shown as delivered).
  await trigger({
    triggerKind: 'EVIDENCE_GAP',
    sourceEventType: 'evidence.revision_committed.v1',
    logicalKey: `evidence-gap:${approval2.incidentId}`,
    incidentId: approval2.incidentId,
    reasonCode: 'BOM_MISSING',
    deepLink: `/incidents/${approval2.incidentId}/evidence`,
  });
  await dispatchNotifications(w.db.pool, new LocalNotificationInbox({ hangFirst: 50 }), { limit: 500, timeoutMs: 60 });

  const cand = await getCandidateAction(w.db.pool, w.service, approval.candidateActionId);

  // --- Test-only OIDC identity provider (authorization code + PKCE S256), loopback only.
  const people: Record<string, { subject: string; userId: string }> = {
    admin: { subject: w.tenant.adminSubject, userId: w.tenant.adminUserId },
  };
  for (const [name, p] of Object.entries(w.people)) people[name] = { subject: p.subject, userId: p.userId };
  people.engineer = { subject: w.engineer.subject, userId: w.engineer.userId };
  people.finance = { subject: w.finance.subject, userId: w.finance.userId };
  const codes = new Map<string, { subject: string; challenge: string; expires: number }>();
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let s = '';
      req.on('data', (d) => {
        s += d;
        if (s.length > 8192) reject(new Error('too large'));
      });
      req.on('end', () => resolve(s));
    });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/jwks') return send(res, 200, w.idp.jwks);
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const q = url.searchParams;
        const who = people[q.get('login_hint') ?? ''];
        // Exact client and redirect URI match: the IdP never redirects anywhere else (no open redirect).
        if (
          q.get('client_id') !== CLIENT_ID ||
          q.get('redirect_uri') !== REDIRECT_URI ||
          q.get('response_type') !== 'code'
        )
          return send(res, 400, { error: 'invalid_request' });
        if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge') ?? ''))
          return send(res, 400, { error: 'invalid_request' });
        if (!who) return send(res, 400, { error: 'login_required' });
        const code = randomBytes(24).toString('base64url');
        codes.set(code, { subject: who.subject, challenge: q.get('code_challenge')!, expires: Date.now() + 60_000 });
        const to = new URL(REDIRECT_URI);
        to.searchParams.set('code', code);
        to.searchParams.set('state', q.get('state') ?? '');
        res.writeHead(302, { location: to.toString(), 'cache-control': 'no-store' });
        return res.end();
      }
      if (url.pathname === '/token') {
        const cors = { 'access-control-allow-origin': WEB_ORIGIN!, vary: 'origin' };
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            ...cors,
            'access-control-allow-methods': 'POST',
            'access-control-allow-headers': 'content-type',
          });
          return res.end();
        }
        if (req.method !== 'POST') return send(res, 405, { error: 'invalid_request' }, cors);
        const f = new URLSearchParams(await readBody(req));
        const entry = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? '');
        const verifier = f.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (
          !entry ||
          entry.expires < Date.now() ||
          f.get('grant_type') !== 'authorization_code' ||
          f.get('client_id') !== CLIENT_ID ||
          f.get('redirect_uri') !== REDIRECT_URI ||
          challenge !== entry.challenge
        )
          return send(res, 400, { error: 'invalid_grant' }, cors);
        return send(
          res,
          200,
          { access_token: await w.idp.mint(entry.subject), token_type: 'Bearer', expires_in: 600 },
          cors,
        );
      }
      send(res, 404, { error: 'not_found' });
    } catch {
      send(res, 500, { error: 'server_error' });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const idpOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // --- Wait until the stale device's only reading is past the 120 s threshold (and well short of 600 s offline).
  while (Date.now() < t0 + 125_000) await new Promise((r) => setTimeout(r, 1_000));
  const tick = setInterval(
    () => void livePost(feed, approvalDevice, 4_000 + Math.round(Math.sin(Date.now() / 20_000) * 300)).catch(() => {}),
    4_000,
  );
  feeding = false;
  await feedLoop;

  const manifest = {
    databaseUrl: w.db.url,
    storeRoot: w.storeRoot,
    idp: {
      issuer: w.idp.issuer,
      audience: w.idp.audience,
      clientId: CLIENT_ID,
      jwksUrl: `${idpOrigin}/jwks`,
      authorizationEndpoint: `${idpOrigin}/authorize`,
      tokenEndpoint: `${idpOrigin}/token`,
    },
    tenantId: w.tenant.tenantId,
    siteId: w.siteId,
    otherSiteId: w.otherSiteId,
    users: Object.fromEntries(Object.entries(people).map(([k, v]) => [k, { userId: v.userId }])),
    incidents: {
      approval: {
        incidentId: approval.incidentId,
        assetId: approval.assetId,
        planId: approval.planId,
        approvalRequestId: approval.approvalRequestId,
        merchantId: cand.merchantId,
        purpose: cand.purpose,
        amountMinor: '18500',
        currency: 'USD',
      },
      approval2: {
        incidentId: approval2.incidentId,
        planId: approval2.planId,
        approvalRequestId: approval2.approvalRequestId,
      },
      recovered: { incidentId: recovered.inc.incidentId, orderId: recovered.inc.orderId },
      reopened: { incidentId: reopenedBase.inc.incidentId },
      verifying: { incidentId: verifying.incidentId, orderId: verifying.orderId },
      serviceJob: { incidentId: job.action.incidentId, orderId: job.orderId },
      unknownIntent: { incidentId: unknown.action.incidentId, orderId: unknown.orderId },
      declined: { incidentId: declined.action.incidentId, orderId: declined.orderId },
      sessionUnknown: { incidentId: sessionUnknown.incidentId, authorityId: suAuth.authority.executionAuthorityId },
      sessionFailed: { incidentId: sessionFailed.incidentId, authorityId: sfAuth.authority.executionAuthorityId },
      sessionPending: { incidentId: sessionPending.incidentId, authorityId: spAuth.authority.executionAuthorityId },
    },
    assets: {
      fresh: approval.assetId,
      stale: staleAsset,
      offline: offlineAsset,
      invalid: invalidAsset,
      noSignal: noSignalAsset,
    },
  };
  console.log(`M12_STACK_READY ${JSON.stringify(manifest)}`);

  const stop = async () => {
    clearInterval(tick);
    server.close();
    await feed.gw.close().catch(() => {});
    await w.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

main().catch((e) => {
  console.error(`M12_STACK_FAILED ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
