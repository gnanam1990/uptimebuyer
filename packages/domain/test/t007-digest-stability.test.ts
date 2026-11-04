// T-007 — Revision and action digest stability: equivalent canonical input produces one stable digest; any material
// incident, immutable asset revision, evidence, policy, action, exact provider-account revision, merchant, amount,
// currency or purpose change produces a different digest, invalidates unexecuted authority, and leaves historical
// decisions reproducible.
import { createHash } from 'node:crypto';
import {
  ActionDigestInputSchema,
  DomainError,
  ID_PREFIXES,
  decodeWire,
  type ActionDigestInput,
  type EvidenceEnvelope,
} from '@uptimebuyer/contracts';
import { describe, expect, it } from 'vitest';
import {
  ACTION_DIGEST_BOUND_FIELDS,
  ACTION_DIGEST_DOMAIN,
  ACTION_DIGEST_VERSION,
  appendEvidence,
  assertActionDigestCurrent,
  canonicalDigest,
  canonicalize,
  causedBy,
  computeActionDigest,
  currentEvidenceRecord,
  rootCorrelation,
  verifyEvidenceChain,
} from '../src/index.js';

const id = (kind: keyof typeof ID_PREFIXES, body = 'fixture01') => `${ID_PREFIXES[kind]}_${body}`;

const wire = {
  tenantId: id('tenant'),
  incidentId: id('incident'),
  assetRevisionId: id('assetRevision'),
  evidenceRevisionId: id('evidenceRevision'),
  policyRevisionId: id('policyRevision'),
  action: {
    kind: 'PART_PURCHASE',
    subjectId: id('candidateAction'),
    quantity: 1,
    partNumber: 'MPN-4471-B',
    manufacturer: 'Acme Refrigeration',
  },
  providerAccountRevisionId: id('providerAccountRevision'),
  merchantId: id('merchant'),
  amount: { amountMinor: '48200', currency: 'USD' },
  purpose: 'COMPRESSOR_RELAY_REPLACEMENT',
};
const input = (): ActionDigestInput => decodeWire(ActionDigestInputSchema, structuredClone(wire));

function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .reverse()
        .map((k) => [k, reverseKeys((v as Record<string, unknown>)[k])]),
    );
  return v;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

/** One material change per bound field (and per action sub-field). */
const MUTATIONS: Record<string, (i: ActionDigestInput) => ActionDigestInput> = {
  tenantId: (i) => ({ ...i, tenantId: id('tenant', 'othertenant') as never }),
  incidentId: (i) => ({ ...i, incidentId: id('incident', 'sibling01') as never }),
  assetRevisionId: (i) => ({ ...i, assetRevisionId: id('assetRevision', 'superseded1') as never }),
  evidenceRevisionId: (i) => ({ ...i, evidenceRevisionId: id('evidenceRevision', 'revision05') as never }),
  policyRevisionId: (i) => ({ ...i, policyRevisionId: id('policyRevision', 'revision10') as never }),
  'action.kind': (i) => ({ ...i, action: { ...i.action, kind: 'SERVICE_JOB' } }),
  'action.subjectId': (i) => ({
    ...i,
    action: { ...i.action, subjectId: id('candidateAction', 'other0001') as never },
  }),
  'action.quantity': (i) => ({ ...i, action: { ...i.action, quantity: 2 } }),
  'action.partNumber': (i) => ({ ...i, action: { ...i.action, partNumber: 'MPN-4471-C' } }),
  'action.manufacturer': (i) => ({ ...i, action: { ...i.action, manufacturer: null } }),
  providerAccountRevisionId: (i) => ({
    ...i,
    providerAccountRevisionId: id('providerAccountRevision', 'rev0002') as never,
  }),
  merchantId: (i) => ({ ...i, merchantId: id('merchant', 'othermerch') as never }),
  amount: (i) => ({ ...i, amount: { ...i.amount, amountMinor: 48201n } }),
  currency: (i) => ({ ...i, amount: { ...i.amount, currency: 'EUR' } }),
  purpose: (i) => ({ ...i, purpose: 'TEMPORARY_CONTAINMENT' as never }),
};

describe('T-007 canonical serialization', () => {
  it('sorts keys recursively, keeps array order and emits no whitespace', () => {
    expect(canonicalize({ b: 1, a: { d: [3, 1], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,1]},"b":1}');
    expect(canonicalize({ a: { y: 1, x: 2 } })).toBe(canonicalize({ a: { x: 2, y: 1 } }));
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('is bigint-safe and keeps bigint distinct from number and string', () => {
    expect(canonicalize({ n: 9007199254740993n })).toBe('{"n":9007199254740993n}');
    expect(canonicalize({ n: 1n })).not.toBe(canonicalize({ n: 1 }));
    expect(canonicalize({ n: 1n })).not.toBe(canonicalize({ n: '1' }));
  });

  it('rejects values without one canonical form', () => {
    for (const bad of [
      { a: 0.1 },
      { a: Number.NaN },
      { a: Infinity },
      { a: 2 ** 53 },
      { a: undefined },
      { a: new Date(0) },
    ])
      expect(() => canonicalize(bad), JSON.stringify(Object.keys(bad))).toThrow(DomainError);
    expect(() => canonicalize(new Map())).toThrow(DomainError);
    expect(() => canonicalize({ f: () => 1 })).toThrow(DomainError);
  });

  it('prefixes every digest with its domain and version, which are also hashed', () => {
    const d1 = canonicalDigest('example', 1, { a: 1 });
    expect(d1).toMatch(/^example\.v1:sha256:[0-9a-f]{64}$/);
    expect(canonicalDigest('example', 2, { a: 1 }).slice(-64)).not.toBe(d1.slice(-64));
    expect(canonicalDigest('other', 1, { a: 1 }).slice(-64)).not.toBe(d1.slice(-64));
    expect(() => canonicalDigest('Bad Domain', 1, {})).toThrow(DomainError);
    expect(() => canonicalDigest('example', 0, {})).toThrow(DomainError);
  });
});

describe('T-007 action digest stability', () => {
  it('binds exactly the contract fields', () => {
    expect([...ACTION_DIGEST_BOUND_FIELDS].sort()).toEqual(
      [
        'tenantId',
        'incidentId',
        'assetRevisionId',
        'evidenceRevisionId',
        'policyRevisionId',
        'action',
        'providerAccountRevisionId',
        'merchantId',
        'amount',
        'purpose',
      ].sort(),
    );
    expect(ACTION_DIGEST_DOMAIN).toBe('action');
    expect(ACTION_DIGEST_VERSION).toBe(1);
  });

  it('matches an independently computed digest of the documented canonical preimage (golden)', () => {
    const canonical =
      '{"action":{"kind":"PART_PURCHASE","manufacturer":"Acme Refrigeration","partNumber":"MPN-4471-B","quantity":1,' +
      `"subjectId":"${id('candidateAction')}"},"amount":{"amountMinor":48200n,"currency":"USD"},` +
      `"assetRevisionId":"${id('assetRevision')}","evidenceRevisionId":"${id('evidenceRevision')}",` +
      `"incidentId":"${id('incident')}","merchantId":"${id('merchant')}","policyRevisionId":"${id('policyRevision')}",` +
      `"providerAccountRevisionId":"${id('providerAccountRevision')}","purpose":"COMPRESSOR_RELAY_REPLACEMENT",` +
      `"tenantId":"${id('tenant')}"}`;
    const hex = createHash('sha256').update(`action.v1\n${canonical}`, 'utf8').digest('hex');
    expect(computeActionDigest(input())).toBe(`action.v1:sha256:${hex}`);
  });

  it('gives equivalent input one digest regardless of key order or wire number form', () => {
    const base = computeActionDigest(input());
    expect(computeActionDigest(reverseKeys(input()) as ActionDigestInput)).toBe(base);
    const numeric = decodeWire(ActionDigestInputSchema, { ...wire, amount: { amountMinor: 48200, currency: 'USD' } });
    expect(computeActionDigest(numeric)).toBe(base);
    expect(computeActionDigest(input())).toBe(base);
  });

  it('changes the digest when ANY bound field changes, with every mutation distinct', () => {
    const base = computeActionDigest(input());
    const seen = new Map<string, string>([[base, 'base']]);
    for (const [field, mutate] of Object.entries(MUTATIONS)) {
      const d = computeActionDigest(mutate(input()));
      expect(d, field).not.toBe(base);
      expect(seen.has(d), `${field} collides with ${seen.get(d)}`).toBe(false);
      seen.set(d, field);
    }
    const covered = new Set(Object.keys(MUTATIONS).map((k) => (k === 'currency' ? 'amount' : k.split('.')[0])));
    for (const f of ACTION_DIGEST_BOUND_FIELDS) expect(covered.has(f), f).toBe(true);
  });

  it('refuses unbound or malformed input instead of silently hashing it', () => {
    expect(() => computeActionDigest({ ...input(), note: 'free text' } as never)).toThrow(DomainError);
    expect(() => computeActionDigest({ ...input(), amount: { amountMinor: 482.5, currency: 'USD' } } as never)).toThrow(
      DomainError,
    );
    const { merchantId: _drop, ...missing } = input();
    expect(() => computeActionDigest(missing as never)).toThrow(DomainError);
  });

  it('invalidates authority bound to a prior digest and keeps historical decisions reproducible', () => {
    const original = deepFreeze(input());
    const authority = deepFreeze({ actionDigest: computeActionDigest(original) });
    expect(() => assertActionDigestCurrent(authority.actionDigest, original)).not.toThrow();
    for (const [field, mutate] of Object.entries(MUTATIONS)) {
      try {
        assertActionDigestCurrent(authority.actionDigest, mutate(original));
        expect.unreachable(field);
      } catch (e) {
        expect((e as DomainError).code, field).toBe('DIGEST_MISMATCH');
      }
    }
    // Computing digests never mutated the historical input; the historical decision still reproduces.
    expect(computeActionDigest(original)).toBe(authority.actionDigest);
    expect(original).toEqual(input());
  });
});

describe('T-007 append-only evidence lineage keeps historical records reproducible', () => {
  const tenantId = id('tenant');
  const draft = (n: number, extra: Partial<Record<string, unknown>> = {}) => ({
    evidenceId: id('evidence', `entry${String(n).padStart(4, '0')}`),
    tenantId,
    kind: 'MATERIAL_INPUT',
    trust: 'AUTHORITATIVE',
    subject: { aggregateType: 'evidence_revision', aggregateId: id('evidenceRevision') },
    incidentId: id('incident'),
    recordedAt: `2026-11-04T10:00:0${n}.000Z`,
    correlation: { correlationId: id('correlation'), causationId: null },
    payloadSchema: 'manual.extract.v1',
    payloadDigest: `sha256:${String(n).repeat(64)}`,
    payloadRef: null,
    supersedesEvidenceId: null,
    ...extra,
  });

  it('chains envelopes by digest, never mutating the prior ledger', () => {
    const l0: readonly EvidenceEnvelope[] = deepFreeze([]);
    const l1 = appendEvidence(l0, draft(1) as never);
    const l2 = appendEvidence(l1, draft(2) as never);
    expect(l0).toHaveLength(0);
    expect(l1).toHaveLength(1);
    expect(l2).toHaveLength(2);
    expect(l2[0]).toEqual(l1[0]);
    expect(l2[0]?.sequence).toBe(1);
    expect(l2[0]?.previousEnvelopeDigest).toBeNull();
    expect(l2[1]?.previousEnvelopeDigest).toBe(l2[0]?.envelopeDigest);
    expect(l2[1]?.envelopeDigest).toMatch(/^evidence-envelope\.v1:sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(l2)).toBe(true);
    expect(verifyEvidenceChain(l2)).toEqual({ ok: true });
  });

  it('records corrections as linked revisions and keeps the original reproducible', () => {
    const l2 = appendEvidence(appendEvidence([], draft(1) as never), draft(2) as never);
    const corrected = appendEvidence(l2, draft(3, { supersedesEvidenceId: id('evidence', 'entry0001') }) as never);
    expect(corrected[0]).toEqual(l2[0]);
    expect(currentEvidenceRecord(corrected, id('evidence', 'entry0001') as never)?.evidenceId).toBe(
      id('evidence', 'entry0003'),
    );
    expect(verifyEvidenceChain(corrected)).toEqual({ ok: true });
  });

  it('rejects appends that would break lineage', () => {
    const l1 = appendEvidence([], draft(1) as never);
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as DomainError).code;
      }
      return 'NO_ERROR';
    };
    expect(code(() => appendEvidence(l1, draft(1) as never))).toBe('EVIDENCE_APPEND_INVALID');
    expect(code(() => appendEvidence(l1, draft(2, { tenantId: id('tenant', 'othertenant') }) as never))).toBe(
      'TENANT_MISMATCH',
    );
    expect(
      code(() => appendEvidence(l1, draft(2, { supersedesEvidenceId: id('evidence', 'missing01') }) as never)),
    ).toBe('EVIDENCE_APPEND_INVALID');
    expect(code(() => appendEvidence(l1, draft(0) as never))).toBe('EVIDENCE_APPEND_INVALID');
    expect(code(() => appendEvidence(l1, { ...draft(2), payloadDigest: 'nope' } as never))).toBe('VALIDATION_FAILED');
  });

  it('detects tampering with any historical envelope', () => {
    const l2 = appendEvidence(appendEvidence([], draft(1) as never), draft(2) as never);
    const tampered = [{ ...l2[0], payloadDigest: `sha256:${'9'.repeat(64)}` }, l2[1]] as EvidenceEnvelope[];
    expect(verifyEvidenceChain(tampered)).toMatchObject({ ok: false, index: 0 });
    const reordered = [l2[1], l2[0]] as EvidenceEnvelope[];
    expect(verifyEvidenceChain(reordered)).toMatchObject({ ok: false, index: 0 });
  });

  it('derives correlation metadata from its cause without persistence coupling', () => {
    const root = rootCorrelation();
    expect(root.correlationId).toMatch(/^corr_/);
    expect(root.causationId).toBeNull();
    const child = causedBy({ correlationId: root.correlationId, eventId: id('event') as never });
    expect(child).toEqual({ correlationId: root.correlationId, causationId: id('event') });
    const fromCommand = causedBy({ correlationId: root.correlationId, commandId: id('command') as never });
    expect(fromCommand.causationId).toBe(id('command'));
  });
});
