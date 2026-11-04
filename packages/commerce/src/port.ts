// The client side of the M01 commercial-intent broker PORT, backed by the real M09 broker (resultOrigin KITE_BROKER).
// createIntent persists the CREATED intent in the caller's tenant context (credential-free); activateSession,
// execute and reconcile send ONLY the signed opaque execution reference to the separately running broker over its
// 0600 unix socket. The broker reloads every bound fact itself; nothing the caller sends can widen authority.
import http from 'node:http';
import {
  CommercialIntentSchema,
  DomainError,
  KiteSessionSchema,
  decodeWire,
  type CommercialIntent,
  type CommercialIntentId,
  type ErrorCode,
  type KiteSession,
  type TenantId,
} from '@uptimebuyer/contracts';
import type { Db, TenantContext } from '@uptimebuyer/data';
import {
  CommercialIntentStateChangedEventSchema,
  SignedExecutionReferenceSchema,
  type CommercialIntentBrokerPort,
  type CommercialIntentRequest,
  type CreateIntentResult,
  type IntentRunResult,
  type SignedExecutionReference,
} from '@uptimebuyer/kite-contracts';
import { z } from 'zod';
import type { ExecutionAuthorityView } from './authorities.js';
import { createCommercialIntent, getCommercialIntent } from './intents.js';
import type { ReferenceSigner } from './signing.js';

export const BROKER_ROUTES = Object.freeze({
  ACTIVATE_SESSION: '/v1/execution-references/activate-session',
  EXECUTE: '/v1/execution-references/execute',
  RECONCILE: '/v1/execution-references/reconcile',
} as const);

const RunResultWire = z.strictObject({
  intent: CommercialIntentSchema,
  events: z.array(CommercialIntentStateChangedEventSchema),
});

/** Post one reference to the broker socket. The body is exactly the strict reference: no other field exists. */
export async function postReference(
  socketPath: string,
  route: string,
  reference: unknown,
  timeoutMs = 30_000,
): Promise<unknown> {
  const body = JSON.stringify(reference);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: route,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          let parsed: any; // eslint-disable-line @typescript-eslint/no-explicit-any
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            reject(new DomainError('DEPENDENCY_OUTCOME_UNKNOWN', 'The broker response was unreadable.'));
            return;
          }
          if (res.statusCode === 200) resolve(parsed);
          else {
            const e = parsed?.error ?? {};
            reject(
              new DomainError((e.code as ErrorCode) ?? 'INTERNAL', String(e.message ?? 'Broker request failed.'), {
                reasonCode: e.reasonCode ?? null,
                httpStatus: res.statusCode,
              }),
            );
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('broker timeout')));
    req.on('error', () =>
      reject(new DomainError('DEPENDENCY_OUTCOME_UNKNOWN', 'The broker did not answer; the outcome is unknown.')),
    );
    req.end(body);
  });
}

export interface KiteBrokerPortOptions {
  socketPath: string;
  referenceSigner: ReferenceSigner;
  /** Composition root: the server-issued tenant context under which intents are created for a tenant. */
  contextFor: (tenantId: TenantId) => TenantContext;
}

export class KiteBrokerPort implements CommercialIntentBrokerPort {
  constructor(
    private readonly pool: Db,
    private readonly opts: KiteBrokerPortOptions,
  ) {}

  async createIntent(request: CommercialIntentRequest): Promise<CreateIntentResult> {
    const ctx = this.opts.contextFor(request.tenantId);
    return createCommercialIntent(this.pool, ctx, request, this.opts.referenceSigner);
  }

  async activateSession(reference: SignedExecutionReference): Promise<KiteSession> {
    const out = await postReference(this.opts.socketPath, BROKER_ROUTES.ACTIVATE_SESSION, reference);
    return decodeWire(KiteSessionSchema, (out as { session: unknown }).session);
  }

  async execute(reference: SignedExecutionReference): Promise<IntentRunResult> {
    return decodeWire(RunResultWire, await postReference(this.opts.socketPath, BROKER_ROUTES.EXECUTE, reference));
  }

  async reconcile(reference: SignedExecutionReference): Promise<IntentRunResult> {
    return decodeWire(RunResultWire, await postReference(this.opts.socketPath, BROKER_ROUTES.RECONCILE, reference));
  }

  async getIntent(tenantId: TenantId, commercialIntentId: CommercialIntentId): Promise<CommercialIntent | null> {
    try {
      return (await getCommercialIntent(this.pool, this.opts.contextFor(tenantId), commercialIntentId)).intent;
    } catch (e) {
      if (e instanceof DomainError && e.code === 'FORBIDDEN') return null;
      throw e;
    }
  }
}

/** The intent request for the subject of an issued authority (plan actions use this; M07 builds its own). */
export function intentRequestFor(
  view: ExecutionAuthorityView,
  ctx: TenantContext,
  idempotencyKey: string,
): CommercialIntentRequest {
  const a = view.authority;
  return {
    tenantId: a.tenantId,
    incidentId: a.incidentId,
    assetRevisionId: a.assetRevisionId,
    evidenceRevisionId: a.evidenceRevisionId,
    policyRevisionId: a.policyRevisionId,
    planHash: a.planHash,
    actionDigest: a.actionDigest,
    approvalId: a.approvalId,
    executionAuthorityId: a.executionAuthorityId,
    providerAccountRevisionId: a.providerAccountRevisionId,
    subject: view.scope.subject,
    semanticOperation: view.scope.semanticOperation,
    expectedMax: a.perActionLimit,
    requestedBy:
      ctx.principal.kind === 'HUMAN'
        ? { kind: 'USER', userId: ctx.principal.id }
        : {
            kind: 'SERVICE',
            serviceIdentityId: ctx.principal.kind === 'SERVICE' ? ctx.principal.id : 'svc_kite-intent-engine',
          },
    correlationId: ctx.correlationId,
    idempotencyKey,
  } as unknown as CommercialIntentRequest;
}

export { SignedExecutionReferenceSchema };
