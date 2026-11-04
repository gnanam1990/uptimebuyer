import { DomainError } from '@uptimebuyer/contracts';

export const rejected = (reasonCode: string, message = 'Input failed validation.') =>
  new DomainError('VALIDATION_FAILED', message, { reasonCode });

export const policyHold = (reasonCode: string, message = 'The request cannot proceed under current evidence.') =>
  new DomainError('POLICY_HOLD', message, { reasonCode });
