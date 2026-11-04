// JSON wire boundary. Schemas are zod codecs: `decodeWire` turns JSON-safe wire input into domain values (e.g. bigint
// money), `encodeWire` validates a domain value and turns it back into JSON-safe wire output.
import { z } from 'zod';
import { DomainError, type FieldError } from './errors.js';

function toFieldErrors(error: z.ZodError): FieldError[] {
  // Report paths and issue codes only: never echo the offending value.
  return error.issues.map((i) => ({ path: i.path.map(String).join('.'), issue: i.code }));
}

export function validationError(error: z.ZodError, message = 'Input failed contract validation.'): DomainError {
  return new DomainError('VALIDATION_FAILED', message, { fieldErrors: toFieldErrors(error) });
}

export function decodeWire<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = z.safeDecode(schema, input as z.input<S>);
  if (!r.success) throw validationError(r.error);
  return r.data;
}

export function encodeWire<S extends z.ZodType>(schema: S, value: z.output<S>): z.input<S> {
  const r = z.safeEncode(schema, value);
  if (!r.success) throw validationError(r.error, 'Value failed contract validation.');
  return r.data;
}
