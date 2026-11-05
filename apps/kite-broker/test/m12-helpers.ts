// Shared fixtures for the M12 operator-API integration tests. They live beside the M09-M11 tests because the full chain
// (paid plan action -> authority -> CONFIRMED Kite session -> order -> fulfillment -> VERIFYING -> recovery) needs the
// in-process RECORDED_CONTRACT broker, which is importable only inside apps/kite-broker (INV-06 lint boundary). The API
// itself (@uptimebuyer/api) never imports the broker: it receives a session-activation port.
// On top of the M11 recovery world: the API server over the same database (the test IdP's verifier, the world's object
// store and credential resolver, the world's authority signer and a recording session port), a second tenant with its
// own admin and operator, a site-2-only operator, and helpers that call routes with a minted bearer token. Nothing here
// is a real provider, payment, CMMS or sensor.
import { randomBytes } from 'node:crypto';
import { buildApiServer, type ApiServerOptions } from '@uptimebuyer/api';
import { addMembership, assignRole, upsertUser } from '@uptimebuyer/data';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createRecoveryPlan, prepareApprovalRequest } from '@uptimebuyer/planning';
import { seedTenant } from '../../../packages/data/test/helpers.js';
import { scenario } from '../../../packages/planning/test/helpers.js';
import { toAwaitingApproval } from './m10-helpers.js';
import { createRecoveryWorld, type RecoveryWorld } from './m11-helpers.js';

export interface ApiWorld extends RecoveryWorld {
  app: FastifyInstance;
  sessions: { tenantId: string; executionAuthorityId: string }[];
  subjects: Record<string, string>;
  /** Tenant B (a different tenant in the same database) and its operator. */
  tenantB: { tenantId: string; adminSubject: string; operatorSubject: string };
  /** A tenant-A operator whose only grant is at the other site. */
  farOperatorSubject: string;
}

export const PUBLIC_CONFIG = {
  oidc: {
    issuer: 'https://idp.test.invalid/',
    authorizationEndpoint: 'https://idp.test.invalid/authorize',
    tokenEndpoint: 'https://idp.test.invalid/token',
    clientId: 'uptimebuyer-web',
    audience: 'uptimebuyer-api',
    scope: 'openid',
  },
  environmentLabel: 'SEEDED_TEST_DATA',
} as const;

export async function buildApiFor(w: RecoveryWorld, over: Partial<ApiServerOptions> = {}) {
  const sessions: ApiWorld['sessions'] = [];
  const app = await buildApiServer({
    pool: w.db.pool,
    verifier: w.idp.verifier(),
    publicConfig: PUBLIC_CONFIG,
    store: w.store,
    credentials: w.creds,
    authority: {
      signer: w.authoritySigner,
      sessions: {
        async activate(input) {
          sessions.push(input);
        },
      },
    },
    ...over,
  });
  return { app, sessions };
}

export async function createApiWorld(label: string): Promise<ApiWorld> {
  const w = await createRecoveryWorld(label);
  const { app, sessions } = await buildApiFor(w);
  const b = await seedTenant(w.db.pool, w.idp, `${label}-beta`);
  const opB = `b-operator-${randomBytes(4).toString('hex')}`;
  const userB = await upsertUser(w.db.pool, {
    issuer: w.idp.issuer,
    externalSubject: opB,
    displayName: 'beta operator',
  });
  await addMembership(w.db.pool, b.admin, userB.userId);
  await assignRole(w.db.pool, b.admin, {
    principal: { kind: 'HUMAN', userId: userB.userId },
    role: 'operator',
    siteId: null,
  });
  const far = `far-operator-${randomBytes(4).toString('hex')}`;
  const farUser = await upsertUser(w.db.pool, {
    issuer: w.idp.issuer,
    externalSubject: far,
    displayName: 'far operator',
  });
  await addMembership(w.db.pool, w.admin, farUser.userId);
  for (const role of ['operator', 'maintenance_approver', 'finance_approver', 'viewer'] as const)
    await assignRole(w.db.pool, w.admin, {
      principal: { kind: 'HUMAN', userId: farUser.userId },
      role,
      siteId: w.otherSiteId as never,
    });
  const subjects: Record<string, string> = { admin: w.tenant.adminSubject };
  for (const [name, p] of Object.entries(w.people)) subjects[name] = p.subject;
  subjects.engineer = w.engineer.subject;
  subjects.finance = w.finance.subject;
  const close = w.close;
  return Object.assign(w, {
    app,
    sessions,
    subjects,
    tenantB: { tenantId: b.tenantId, adminSubject: b.adminSubject, operatorSubject: opB },
    farOperatorSubject: far,
    async close() {
      await app.close();
      await close();
    },
  });
}

export interface CallOpts {
  body?: unknown;
  rawBody?: string | Buffer;
  key?: string | null;
  version?: number | string | null;
  token?: string | null;
  tenant?: string;
  headers?: Record<string, string>;
}

let keyN = 0;
/** Call a route as `subject` (a minted ES256 bearer token from the world's test IdP). */
export async function call(
  w: { app: FastifyInstance; idp: RecoveryWorld['idp'] },
  subject: string | null,
  method: 'GET' | 'POST',
  url: string,
  o: CallOpts = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...o.headers };
  const token = o.token !== undefined ? o.token : subject ? await w.idp.mint(subject) : null;
  if (token) headers.authorization = `Bearer ${token}`;
  if (o.tenant) headers['x-tenant-id'] = o.tenant;
  if (method === 'POST') {
    headers['content-type'] ??= 'application/json';
    if (o.key !== null) headers['idempotency-key'] = o.key ?? `m12-api-${++keyN}-${randomBytes(4).toString('hex')}`;
    if (o.version !== null && o.version !== undefined) headers['if-match'] = `"${o.version}"`;
  }
  return w.app.inject({
    method,
    url,
    headers,
    ...(method === 'POST' ? { payload: o.rawBody ?? JSON.stringify(o.body ?? {}) } : {}),
  });
}

export const errorOf = (r: LightMyRequestResponse) => {
  const b = r.json() as { error?: { code?: string; reasonCode?: string; currentVersion?: number } };
  return {
    status: r.statusCode,
    code: b.error?.code,
    reasonCode: b.error?.reasonCode,
    currentVersion: b.error?.currentVersion,
  };
};

/** A RANKED paid plan action whose approval request is prepared but not yet approved (incident AWAITING_APPROVAL). */
export async function pendingApproval(
  w: RecoveryWorld,
  priceMinor = 18_500n,
  kind: 'PART_PURCHASE' | 'SERVICE_JOB' = 'PART_PURCHASE',
) {
  const s = await scenario(w, [{ label: 'A', priceMinor, etaMinutes: 120, kind }]);
  await toAwaitingApproval(w, s.incidentId);
  const plan = await createRecoveryPlan(
    w.db.pool,
    w.service,
    { incidentId: s.incidentId, candidates: s.refs },
    w.signing,
  );
  const action = plan.actions.find((a) => a.ordinal === 1)!;
  const req = await prepareApprovalRequest(
    w.db.pool,
    w.service,
    { planId: plan.planId, planHash: plan.planHash, planActionId: action.planActionId },
    w.signing,
  );
  return {
    incidentId: s.incidentId as string,
    assetId: s.assetId as string,
    planId: plan.planId,
    planHash: plan.planHash,
    planActionId: action.planActionId,
    candidateActionId: action.candidateActionId,
    approvalRequestId: req.approvalRequestId,
  };
}
