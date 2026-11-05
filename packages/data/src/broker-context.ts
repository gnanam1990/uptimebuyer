// Worker context for the exclusive Kite broker (M09; narrowed in M13, INV-06, NFR-05). This module is exposed only as
// the `@uptimebuyer/data/broker` subpath, which ESLint lets only the broker application's own source import; a
// structural test proves no other source file reaches it. A general @uptimebuyer/data consumer therefore cannot mint
// a broker-scoped context.
import { DomainError, TenantIdSchema, newId, type CorrelationId, type TenantId } from '@uptimebuyer/contracts';
import { issueWorkerContext, type TenantContext } from './context.js';

/**
 * `sourceId` names what the broker acts on: the nonce of ONE verified signed execution reference (whose signed tenant
 * is `tenantId`), or a durable broker-owned attempt/session row being reconciled. Like an outbox/job worker context it
 * grants only worker-permitted actions.
 */
export function issueBrokerWorkerContext(
  tenantId: TenantId,
  sourceId: string,
  correlationId: CorrelationId = newId('correlation'),
): TenantContext {
  if (!TenantIdSchema.safeParse(tenantId).success || !/^[A-Za-z0-9_-]{4,80}$/.test(sourceId))
    throw new DomainError('UNAUTHENTICATED', 'A server-issued authenticated context is required.', {
      reasonCode: 'CONTEXT_NOT_ISSUED',
    });
  return issueWorkerContext(tenantId, { kind: 'WORKER', id: 'kite-broker', source: 'BROKER', sourceId }, correlationId);
}
