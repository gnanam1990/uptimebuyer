// Public API error body (API-EVENT-SPEC §4). Stable machine codes plus a safe message; never secrets, stacks,
// provider authorization or model-private content.
import { z } from 'zod';
import { ReasonCodeSchema, StateNameSchema } from './codes.js';
import { DomainError, ERROR_CODE_CLASS, ErrorClassSchema, ErrorCodeSchema } from './errors.js';
import { CorrelationIdSchema, type CorrelationId } from './ids.js';

export const ApiErrorBodySchema = z.strictObject({
  error: z
    .strictObject({
      code: ErrorCodeSchema,
      errorClass: ErrorClassSchema,
      message: z.string().min(1).max(500),
      correlationId: CorrelationIdSchema,
      reasonCode: ReasonCodeSchema.optional(),
      currentRevision: z.int().min(0).optional(),
      currentState: StateNameSchema.optional(),
      currentVersion: z.int().min(0).optional(),
      fieldErrors: z
        .array(z.strictObject({ path: z.string().max(256), issue: z.string().max(64) }))
        .max(100)
        .optional(),
    })
    .refine((e) => ERROR_CODE_CLASS[e.code] === e.errorClass, {
      path: ['errorClass'],
      message: 'Error class does not match the code.',
    }),
});
export type ApiErrorBody = z.output<typeof ApiErrorBodySchema>;

const optional = <S extends z.ZodType>(schema: S, v: unknown): z.output<S> | undefined => {
  const r = schema.safeParse(v);
  return r.success ? r.data : undefined;
};

/** Map any thrown value to a safe public body. Anything that is not a non-internal DomainError becomes opaque. */
export function toApiErrorBody(err: unknown, correlationId: CorrelationId): ApiErrorBody {
  if (!(err instanceof DomainError) || err.errorClass === 'INTERNAL')
    return { error: { code: 'INTERNAL', errorClass: 'INTERNAL', message: 'Internal error.', correlationId } };
  const d = err.details;
  const extra = {
    reasonCode: optional(ReasonCodeSchema, d['reasonCode']),
    currentRevision: optional(z.int().min(0), d['currentRevision']),
    currentState: optional(StateNameSchema, d['currentState']),
    currentVersion: optional(z.int().min(0), d['currentVersion']),
    fieldErrors: d.fieldErrors ? d.fieldErrors.slice(0, 100) : undefined,
  };
  const body: ApiErrorBody['error'] = {
    code: err.code,
    errorClass: err.errorClass,
    message: err.message.slice(0, 500) || 'Request failed.',
    correlationId,
  };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) (body as Record<string, unknown>)[k] = v;
  return { error: body };
}
