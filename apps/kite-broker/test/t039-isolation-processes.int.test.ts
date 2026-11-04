// T-039 — Credential and paid-egress isolation (separate processes). The kite-broker runs as its own process and is
// the ONLY holder of the LOCAL_STAND_IN credential (client certificate key + bearer capability, delivered on an fd-3
// pipe). General-worker-, API- and model-shaped processes (each separately spawned, each with only its own minimal
// environment) cannot reach the paid endpoint, cannot read the credential from the broker's environment, argv,
// logs or the database, and cannot drive the broker without a valid signed opaque reference. The legitimate path —
// signed references over the 0600 unix socket — works end to end and reloads everything from PostgreSQL.
// LOCAL_STAND_IN is not Kite; no real payment is made. Production network policy and a distinct OS identity: NOT_RUN.
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KiteBrokerPort, getCommercialIntent, intentRequestFor, issueReference } from '@uptimebuyer/commerce';
import { attemptOf, createBrokerWorld, issue, paidPlanAction, rejection, type BrokerWorld } from './helpers.js';
import {
  launchBroker,
  launchStandIn,
  mintSecrets,
  runProbe,
  type BrokerProc,
  type Secrets,
  type StandIn,
} from './support/procs.js';

let w: BrokerWorld;
let secrets: Secrets;
let standIn: StandIn;
let broker: BrokerProc;
let port: KiteBrokerPort;

beforeAll(async () => {
  w = await createBrokerWorld('t039p');
  secrets = mintSecrets();
  standIn = await launchStandIn(secrets);
  broker = await launchBroker(w, secrets, { standIn });
  port = new KiteBrokerPort(w.db.pool, {
    socketPath: broker.socketPath,
    referenceSigner: w.referenceSigner,
    contextFor: () => w.operator,
  });
});
afterAll(async () => {
  await broker?.stop();
  await standIn?.stop();
  await w?.close();
});

const secretNeedles = () => [
  secrets.capability,
  secrets.pki.client.key.split('\n').find((l) => l.length > 40 && !l.startsWith('-----'))!,
  Buffer.from(w.referenceSigner.key).toString('base64url'),
  // The full connection URL (the dev password itself is also a path component of the checkout, so it is not a needle).
  w.db.url,
];

describe('T-039 credential and paid-egress isolation (separate processes)', () => {
  let intentId = '';

  it('the legitimate path: signed references over the 0600 socket; the broker reloads state and pays the stand-in once', async () => {
    const st = statSync(broker.socketPath);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(statSync(dirname(broker.socketPath)).mode & 0o777).toBe(0o700);

    const p = await paidPlanAction(w);
    const auth = await issue(w, p);
    const session = await port.activateSession(
      issueReference(w.referenceSigner, w.tenant.tenantId, {
        kind: 'EXECUTION_AUTHORITY',
        executionAuthorityId: auth.authority.executionAuthorityId,
      } as never),
    );
    expect(session.externalOutcomeState).toBe('CONFIRMED');
    const created = await port.createIntent(intentRequestFor(auth, w.operator, w.key('intent')));
    expect(created.resultOrigin).toBe('KITE_BROKER');
    intentId = created.intent.commercialIntentId;
    const before = await standIn.command({ cmd: 'stats' });
    const run = await port.execute(created.executionReference);
    expect(run.intent.state).toBe('CONFIRMED');
    expect(run.events.map((e) => e.payload.state)).toEqual(['RESERVED', 'SUBMITTED', 'CONFIRMED']);
    const after = await standIn.command({ cmd: 'stats' });
    expect(after.effectsCreated - before.effectsCreated).toBe(1);
    const a = await attemptOf(w, intentId);
    expect([a.result_origin, a.adapter_id]).toEqual(['LOCAL_STAND_IN', 'local-stand-in']);
    expect(a.provider_ref).toMatch(/^sfx_/);
    // Replaying the captured reference performs nothing.
    const replay = await port.execute(created.executionReference);
    expect(replay.events).toEqual([]);
    expect((await standIn.command({ cmd: 'stats' })).executeCalls).toBe(after.executeCalls);
    const view = await getCommercialIntent(w.db.pool, w.viewerCtx, intentId);
    expect(view.receipts.map((r) => r.kind)).toContain('PAYMENT_SETTLEMENT');
    expect(view.receipts.every((r) => r.resultOrigin === 'LOCAL_STAND_IN')).toBe(true);
  });

  it('worker-, API- and model-shaped processes cannot reach the paid endpoint, read the credential or forge broker input', async () => {
    const before = await standIn.command({ cmd: 'stats' });
    const base = {
      STANDIN_PORT: String(standIn.port),
      BROKER_SOCKET: broker.socketPath,
      BROKER_PID: String(broker.proc.pid),
      TENANT_ID: w.tenant.tenantId,
      INTENT_ID: intentId,
    };
    const reports = [
      await runProbe('general-worker', { ...base, DATABASE_URL: w.db.url }),
      await runProbe('api', { ...base, DATABASE_URL: w.db.url }),
      await runProbe('model-serv', base),
    ];
    for (const r of reports) {
      const paid = r.paid as Record<string, string>;
      expect(paid.noClientCert, `${r.role} without client cert`).toMatch(/^(ERROR_|HTTP_401)/);
      expect(paid.attackerCert, `${r.role} with attacker cert`).toMatch(/^(ERROR_|HTTP_401)/);
      expect(paid.plainHttp, `${r.role} plain http`).not.toMatch(/^HTTP_2/);
      expect(paid.rawTcp).toBe('REFUSED');
      const b = r.broker as Record<string, { status: number; body: string }>;
      expect(b.forged!.status).toBe(403);
      expect(b.embedded!.status).toBe(403);
      expect(b.wrongRoute!.status).toBe(404);
      expect(b.notJson!.status).toBe(400);
      for (const x of Object.values(b)) expect(x.body).not.toMatch(/stack|at .*\.ts|password|BEGIN/i);
      // No secret in the broker's environment/argv as seen from another process, nor anywhere in the database.
      expect(typeof r.env).toBe('string');
      for (const needle of secretNeedles()) {
        expect((r.env as string).includes(needle), `${r.role} broker env`).toBe(false);
        if (r.db !== null) expect((r.db as string).includes(needle), `${r.role} database dump`).toBe(false);
      }
    }
    expect((reports[0]!.db as string).length).toBeGreaterThan(1_000);
    expect(reports[2]!.db).toBeNull();
    const after = await standIn.command({ cmd: 'stats' });
    expect(after.authorized).toBe(before.authorized); // not one probe request was authorized at the paid endpoint
    expect(after.executeCalls).toBe(before.executeCalls);
    expect(after.rejected).toBeGreaterThan(before.rejected);
    // The broker's own logs never contain the credential, keys or the database password.
    const logs = broker.log.join('\n');
    expect(logs).toContain('broker.listening');
    for (const needle of secretNeedles()) expect(logs.includes(needle)).toBe(false);
  });

  it('a process holding only the database cannot pay: rows carry opaque references, and the broker refuses unsigned intent ids', async () => {
    const refs = await w.db.pool.query(`SELECT credential_ref FROM provider_account_revisions WHERE tenant_id = $1`, [
      w.tenant.tenantId,
    ]);
    for (const r of refs.rows) expect(r.credential_ref).toMatch(/^secretref:/);
    // A reference signed with any key the broker does not hold is refused before any lookup.
    const wrongKey = issueReference({ keyId: 'reference-k1', key: new Uint8Array(32).fill(7) }, w.tenant.tenantId, {
      kind: 'COMMERCIAL_INTENT',
      commercialIntentId: intentId,
    } as never);
    expect((await rejection(port.execute(wrongKey))).code).toBe('EXECUTION_REFERENCE_INVALID');
    // A reference of the right kind but naming another tenant's view of the intent resolves nothing.
    const otherTenant = issueReference(w.referenceSigner, 'ten_other-tenant-0001', {
      kind: 'COMMERCIAL_INTENT',
      commercialIntentId: intentId,
    } as never);
    expect((await rejection(port.execute(otherTenant))).code).toBe('EXECUTION_REFERENCE_INVALID');
  });
});
