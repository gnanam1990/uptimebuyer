// Storage-local identifier kinds owned by M05. Same opaque '<prefix>_<body>' form as @uptimebuyer/contracts, so
// OpaqueIdSchema accepts them; the SQL `ub_id_ok` checks enforce each prefix per table.
import { z } from 'zod';

export const EVIDENCE_ID_PREFIXES = Object.freeze({
  document: 'doc',
  documentEvent: 'dve',
  span: 'spn',
  fact: 'efc',
  revisionDocument: 'erd',
  conflict: 'ecf',
  reasoningRun: 'rsn',
  proposal: 'rpr',
} as const);
export type EvidenceIdKind = keyof typeof EVIDENCE_ID_PREFIXES;

const BODY = '[A-Za-z0-9][A-Za-z0-9-]{3,63}';
const schema = <K extends EvidenceIdKind>(kind: K) =>
  z
    .string()
    .regex(new RegExp(`^${EVIDENCE_ID_PREFIXES[kind]}_${BODY}$`))
    .brand<`${K}Id`>();

export const DocumentIdSchema = schema('document');
export const ReasoningRunIdSchema = schema('reasoningRun');
export const ProposalIdSchema = schema('proposal');
export const SpanIdSchema = schema('span');
export type DocumentId = z.infer<typeof DocumentIdSchema>;
export type ReasoningRunId = z.infer<typeof ReasoningRunIdSchema>;
export type ProposalId = z.infer<typeof ProposalIdSchema>;
export type SpanId = z.infer<typeof SpanIdSchema>;

export function newEvidenceId<K extends EvidenceIdKind>(kind: K): string {
  return `${EVIDENCE_ID_PREFIXES[kind]}_${globalThis.crypto.randomUUID()}`;
}
