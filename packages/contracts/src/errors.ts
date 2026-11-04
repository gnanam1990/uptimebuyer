// Error taxonomy (TDD §14) and the single typed error used across the shared contracts and domain.
import { z } from 'zod';

export const ERROR_CLASSES = [
  'VALIDATION',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CONFLICT',
  'POLICY_HOLD',
  'RATE_LIMIT',
  'DEPENDENCY_DEFINITE_FAILURE',
  'DEPENDENCY_UNKNOWN',
  'INTERNAL',
] as const;
export const ErrorClassSchema = z.enum(ERROR_CLASSES);
export type ErrorClass = z.infer<typeof ErrorClassSchema>;

/** HTTP/API behaviour per class. `DEPENDENCY_UNKNOWN` is 202: recorded, reconciling, never a fabricated result. */
export const ERROR_CLASS_HTTP_STATUS = Object.freeze({
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  POLICY_HOLD: 422,
  RATE_LIMIT: 429,
  DEPENDENCY_DEFINITE_FAILURE: 502,
  DEPENDENCY_UNKNOWN: 202,
  INTERNAL: 500,
} as const satisfies Record<ErrorClass, number>);

/** Stable machine codes and the taxonomy class each belongs to. */
export const ERROR_CODE_CLASS = Object.freeze({
  VALIDATION_FAILED: 'VALIDATION',
  PRECISION_LOSS: 'VALIDATION',
  CURRENCY_MISMATCH: 'VALIDATION',
  UNIT_MISMATCH: 'VALIDATION',
  MONEY_OUT_OF_RANGE: 'VALIDATION',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  TENANT_MISMATCH: 'FORBIDDEN',
  EXECUTION_REFERENCE_INVALID: 'FORBIDDEN',
  STATE_TRANSITION_INVALID: 'CONFLICT',
  VERSION_CONFLICT: 'CONFLICT',
  IDEMPOTENCY_KEY_REUSED: 'CONFLICT',
  INTENT_SUCCESSOR_BLOCKED: 'CONFLICT',
  DIGEST_MISMATCH: 'CONFLICT',
  EVIDENCE_APPEND_INVALID: 'CONFLICT',
  POLICY_HOLD: 'POLICY_HOLD',
  RATE_LIMITED: 'RATE_LIMIT',
  DEPENDENCY_FAILED: 'DEPENDENCY_DEFINITE_FAILURE',
  DEPENDENCY_OUTCOME_UNKNOWN: 'DEPENDENCY_UNKNOWN',
  INTERNAL: 'INTERNAL',
} as const satisfies Record<string, ErrorClass>);
export type ErrorCode = keyof typeof ERROR_CODE_CLASS;
export const ERROR_CODES = Object.freeze(Object.keys(ERROR_CODE_CLASS)) as readonly ErrorCode[];
export const ErrorCodeSchema = z.enum(ERROR_CODES as [ErrorCode, ...ErrorCode[]]);

export type FieldError = { readonly path: string; readonly issue: string };
export type DomainErrorDetails = Readonly<Record<string, unknown>> & { readonly fieldErrors?: readonly FieldError[] };

/**
 * The one typed error. `message` must be a safe, authored sentence: never secrets, raw provider authorization,
 * model-private content or echoed input values. Structured context goes in `details`.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly errorClass: ErrorClass;
  readonly httpStatus: number;
  readonly details: DomainErrorDetails;

  constructor(code: ErrorCode, message: string, details: DomainErrorDetails = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.errorClass = ERROR_CODE_CLASS[code];
    this.httpStatus = ERROR_CLASS_HTTP_STATUS[this.errorClass];
    this.details = Object.freeze({ ...details });
  }
}

export const isDomainError = (e: unknown): e is DomainError => e instanceof DomainError;
