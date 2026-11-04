// Typed M07 errors: every refusal is a DomainError with a stable machine reason and a safe authored message. No
// provider text, contact value or credential is ever placed in a message or detail.
import { DomainError } from '@uptimebuyer/contracts';

export const hold = (reasonCode: string, details: Record<string, unknown> = {}) =>
  new DomainError('POLICY_HOLD', 'Provider policy holds this request.', { reasonCode, ...details });

export const invalid = (reasonCode: string, details: Record<string, unknown> = {}) =>
  new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', { reasonCode, ...details });

export const keyReused = () =>
  new DomainError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different request.', {
    reasonCode: 'IDEMPOTENCY_KEY_REUSED',
  });

export const dependency = (reasonCode: string) =>
  new DomainError('DEPENDENCY_FAILED', 'A provider dependency is not available.', { reasonCode });
