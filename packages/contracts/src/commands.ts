// Command envelope and acknowledgement (TDD §5, API §1). A 202 acknowledgement means accepted, never fulfilled.
import { z } from 'zod';
import { CommandTypeSchema, StateNameSchema } from './codes.js';
import { AggregateTypeSchema } from './events.js';
import {
  CausationIdSchema,
  CommandIdSchema,
  CorrelationIdSchema,
  DeviceIdSchema,
  IdempotencyKeySchema,
  OpaqueIdSchema,
  ServiceIdentityIdSchema,
  TenantIdSchema,
  UserIdSchema,
} from './ids.js';
import { UtcInstantSchema } from './time.js';

export const ActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('USER'), userId: UserIdSchema }),
  z.strictObject({ kind: z.literal('SERVICE'), serviceIdentityId: ServiceIdentityIdSchema }),
  z.strictObject({ kind: z.literal('DEVICE'), deviceId: DeviceIdSchema }),
]);
export type Actor = z.output<typeof ActorSchema>;

/**
 * `tenantId` is the requested context only; the server derives authority from the authenticated principal (INV-16).
 * `payload` is validated by the owning module's command schema.
 */
export const CommandEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  commandId: CommandIdSchema,
  commandType: CommandTypeSchema,
  tenantId: TenantIdSchema,
  actor: ActorSchema,
  idempotencyKey: IdempotencyKeySchema,
  expectedVersion: z.int().min(0).nullable(),
  correlationId: CorrelationIdSchema,
  causationId: CausationIdSchema.nullable(),
  issuedAt: UtcInstantSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type CommandEnvelope = z.output<typeof CommandEnvelopeSchema>;

export const CommandAcceptedSchema = z.strictObject({
  commandId: CommandIdSchema,
  aggregateType: AggregateTypeSchema,
  aggregateId: OpaqueIdSchema,
  aggregateVersion: z.int().min(1),
  state: StateNameSchema,
  acceptedAt: UtcInstantSchema,
});
export type CommandAccepted = z.output<typeof CommandAcceptedSchema>;
