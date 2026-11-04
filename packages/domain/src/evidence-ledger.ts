// Append-only evidence ledger helpers (FR-18, INV-10) without persistence coupling: each envelope is chained to its
// predecessor by digest, corrections are linked revisions, and appends return a new frozen ledger.
import {
  DomainError,
  EvidenceEnvelopeSchema,
  encodeWire,
  newId,
  type CommandId,
  type Correlation,
  type CorrelationId,
  type EventId,
  type EvidenceEnvelope,
  type EvidenceId,
  type VersionedDigest,
} from '@uptimebuyer/contracts';
import { canonicalDigest } from './canonical.js';

export const ENVELOPE_DIGEST_DOMAIN = 'evidence-envelope';
export const ENVELOPE_DIGEST_VERSION = 1;

export type EvidenceDraft = Omit<
  EvidenceEnvelope,
  'schemaVersion' | 'sequence' | 'previousEnvelopeDigest' | 'envelopeDigest'
>;

export function computeEnvelopeDigest(envelope: Omit<EvidenceEnvelope, 'envelopeDigest'>): VersionedDigest {
  const { envelopeDigest: _ignored, ...body } = envelope as EvidenceEnvelope;
  return canonicalDigest(ENVELOPE_DIGEST_DOMAIN, ENVELOPE_DIGEST_VERSION, body);
}

const appendInvalid = (reason: string) =>
  new DomainError('EVIDENCE_APPEND_INVALID', 'Evidence append would break append-only lineage.', { reason });

export function appendEvidence(ledger: readonly EvidenceEnvelope[], draft: EvidenceDraft): readonly EvidenceEnvelope[] {
  const last = ledger.at(-1);
  const first = ledger[0];
  if (first && draft.tenantId !== first.tenantId)
    throw new DomainError('TENANT_MISMATCH', 'Evidence belongs to another tenant ledger.');
  if (ledger.some((e) => e.evidenceId === draft.evidenceId)) throw appendInvalid('DUPLICATE_EVIDENCE_ID');
  if (draft.supersedesEvidenceId !== null && !ledger.some((e) => e.evidenceId === draft.supersedesEvidenceId))
    throw appendInvalid('SUPERSEDED_RECORD_NOT_IN_LEDGER');
  if (last && Date.parse(draft.recordedAt) < Date.parse(last.recordedAt))
    throw appendInvalid('NON_MONOTONIC_RECORDED_AT');
  const body = {
    ...draft,
    schemaVersion: 1 as const,
    sequence: ledger.length + 1,
    previousEnvelopeDigest: last ? last.envelopeDigest : null,
  };
  const envelope = { ...body, envelopeDigest: computeEnvelopeDigest(body as never) } as EvidenceEnvelope;
  encodeWire(EvidenceEnvelopeSchema, envelope); // strict validation of the whole record
  return Object.freeze([...ledger, Object.freeze(envelope)]);
}

export type ChainVerification = { ok: true } | { ok: false; index: number; reason: string };

export function verifyEvidenceChain(ledger: readonly EvidenceEnvelope[]): ChainVerification {
  for (let i = 0; i < ledger.length; i++) {
    const e = ledger[i] as EvidenceEnvelope;
    const fail = (reason: string): ChainVerification => ({ ok: false, index: i, reason });
    if (!EvidenceEnvelopeSchema.safeParse(e).success) return fail('SCHEMA_INVALID');
    if (e.sequence !== i + 1) return fail('SEQUENCE_GAP');
    if (e.tenantId !== ledger[0]?.tenantId) return fail('TENANT_MISMATCH');
    if (e.previousEnvelopeDigest !== (i === 0 ? null : (ledger[i - 1] as EvidenceEnvelope).envelopeDigest))
      return fail('BROKEN_LINK');
    let digest: string;
    try {
      digest = computeEnvelopeDigest(e);
    } catch {
      return fail('NOT_CANONICAL');
    }
    if (digest !== e.envelopeDigest) return fail('DIGEST_MISMATCH');
  }
  return { ok: true };
}

/** Follow the correction chain from `evidenceId` to its current (latest superseding) record. */
export function currentEvidenceRecord(
  ledger: readonly EvidenceEnvelope[],
  evidenceId: EvidenceId,
): EvidenceEnvelope | undefined {
  let current = ledger.find((e) => e.evidenceId === evidenceId);
  for (let guard = 0; current && guard <= ledger.length; guard++) {
    const id: EvidenceId = current.evidenceId;
    const next: EvidenceEnvelope | undefined = ledger.findLast((e) => e.supersedesEvidenceId === id);
    if (!next) return current;
    current = next;
  }
  return current;
}

/** Correlation for a new root cause (an inbound request with no prior command/event). */
export function rootCorrelation(correlationId?: CorrelationId): Correlation {
  return { correlationId: correlationId ?? newId('correlation'), causationId: null };
}

/** Correlation for work caused by a command or event: same correlation, causation = that command/event. */
export function causedBy(
  parent: { correlationId: CorrelationId } & ({ eventId: EventId } | { commandId: CommandId }),
): Correlation {
  const causationId = 'eventId' in parent ? parent.eventId : parent.commandId;
  return { correlationId: parent.correlationId, causationId };
}
