// T-023 — Malicious document instruction isolation (NFR-10, INV-02, INV-13). A service bulletin embeds instructions
// to call payment tools, reveal secrets, fetch a URL and change policy. The text is stored and cited as untrusted
// evidence only: it is flagged, withheld from model excerpts, secrets never reach model input, a model that obeys it
// is rejected, no tool outside the allowlist runs, nothing egresses and no policy, approval or payment state changes.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readEvidenceLedger } from '@uptimebuyer/data';
import {
  ContractFakeReasoner,
  ServReasoningAdapter,
  commitIncidentEvidence,
  getReasoningRun,
  runReasoning,
  searchEvidence,
  type ReasonerTurn,
} from '../src/index.js';
import { buildPdf } from './fixtures/pdf-builder.js';
import {
  MANUAL_C,
  canary,
  createEvidenceWorld,
  fixture,
  ingestAs,
  nwrAsset,
  openIncident,
  proposalFor,
  type EvidenceWorld,
} from './helpers.js';

let w: EvidenceWorld;
let incidentId: string;
let evidenceRevisionId: string;
const fetchSpy = vi.fn(async () => {
  throw new Error('network egress attempted');
});
const env: Record<string, string> = {};
let docCanary: string;

async function counts() {
  const q = async (sql: string) => Number((await w.db.pool.query(sql)).rows[0].n);
  return {
    policyRevisions: await q('SELECT count(*) AS n FROM policy_revisions'),
    approvals: await q('SELECT count(*) AS n FROM approvals'),
    approvalEvents: await q('SELECT count(*) AS n FROM approval_events'),
    providerAccounts: await q('SELECT count(*) AS n FROM provider_account_revisions'),
    jobs: await q(`SELECT count(*) AS n FROM jobs WHERE kind NOT LIKE 'plan.revalidate%'`),
  };
}

describe('T-023 malicious document instruction isolation', () => {
  beforeAll(async () => {
    w = await createEvidenceWorld('t023');
    env.OPENSERV_API_KEY = canary('openserv');
    env.KITE_API_KEY = canary('kite');
    docCanary = canary('portal');
    const asset = await nwrAsset(w);
    await ingestAs(w, w.librarian, MANUAL_C());
    const bulletin = Buffer.concat([
      fixture('sb-2025-14.txt'),
      Buffer.from(`Dealer portal password: ${docCanary}\n`),
    ]);
    const doc = await ingestAs(w, w.librarian, {
      role: 'OTHER',
      mediaType: 'text/plain',
      bytes: bulletin,
      title: 'Service bulletin SB-2025-14',
      documentRevision: 'SB-2025-14',
      applicability: { ...MANUAL_C().applicability },
      sourceKind: 'OEM_PUBLICATION',
      sourceRef: 'https://169.254.169.254/latest/meta-data/',
    });
    expect(doc.injectionFlaggedSpanCount).toBe(1);
    incidentId = await openIncident(w, asset.assetId);
    evidenceRevisionId = (
      await commitIncidentEvidence(w.db.pool, w.people.operator!.ctx, w.store, {
        incidentId: incidentId as never,
        reasonCode: 'TRIAGE_EVIDENCE',
      })
    ).evidenceRevisionId;
  });
  beforeEach(() => {
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await w?.close();
  });

  it('stores the bulletin as flagged untrusted evidence; its source URL is never dereferenced', async () => {
    const hits = await searchEvidence(w.db.pool, w.people.viewer!.ctx, {
      evidenceRevisionId: evidenceRevisionId as never,
      query: 'evaporator fan bearing noise bulletin',
    });
    const b = hits.find((h) => h.title === 'Service bulletin SB-2025-14')!;
    expect(b.injectionFlags).toEqual(
      expect.arrayContaining([
        'INSTRUCTION_OVERRIDE',
        'TOOL_REQUEST',
        'SECRET_REQUEST',
        'EGRESS_REQUEST',
        'POLICY_CHANGE',
        'PAYMENT_REQUEST',
      ]),
    );
    expect(b.trustLevel).toBe('OPERATOR_ATTESTED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an obedient model that requests an unlisted payment tool is rejected; nothing runs or egresses', async () => {
    const before = await counts();
    const fake = new ContractFakeReasoner(
      (): ReasonerTurn => ({
        kind: 'TOOL_CALLS',
        calls: [{ id: 'c1', name: 'kite_pay', arguments: JSON.stringify({ amountMinor: 490000, currency: 'USD' }) }],
      }),
    );
    const run = await runReasoning(
      w.db.pool,
      w.service,
      { reasoner: fake, store: w.store, env },
      { incidentId: incidentId as never },
    );
    expect(run).toMatchObject({ status: 'REJECTED', disposition: 'REJECTED', proposalId: null });
    expect(run.rejectionReasons).toContain('UNEXPECTED_TOOL_REQUEST');
    expect(fake.requests).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await counts()).toEqual(before);
  });

  it('secrets never enter model input and instruction lines are withheld from excerpts', async () => {
    const fake = new ContractFakeReasoner((req) => ({ kind: 'FINAL', content: JSON.stringify(proposalFor(req)) }));
    const run = await runReasoning(
      w.db.pool,
      w.service,
      { reasoner: fake, store: w.store, env },
      { incidentId: incidentId as never },
    );
    expect(run.status).toBe('COMPLETED');
    // Flagged evidence was in scope, so a human must review the proposal.
    expect(run.disposition).toBe('NEEDS_HUMAN_REVIEW');
    const sent = JSON.stringify(fake.requests);
    for (const secret of [env.OPENSERV_API_KEY!, env.KITE_API_KEY!, docCanary]) expect(sent).not.toContain(secret);
    expect(sent).not.toMatch(/ignore all previous instructions/i);
    expect(sent).not.toContain('kite_pay');
    expect(sent).not.toContain('169.254.169.254');
    expect(sent).not.toContain('parts-update.example');
    const bulletin = fake.requests[0]!.packet.excerpts.find((e) => e.untrustedInstructionFlags.length > 0)!;
    expect(bulletin.text).toContain('[withheld: untrusted instruction-like text');
    expect(bulletin.text).toContain('Replace the evaporator fan motor.');
    expect(fake.requests[0]!.system).toMatch(/untrusted/i);
    const stored = await getReasoningRun(w.db.pool, w.people.viewer!.ctx, run.reasoningRunId);
    expect(stored.injectionFlags).toEqual(expect.arrayContaining(['INSTRUCTION_OVERRIDE', 'PAYMENT_REQUEST']));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a model that echoes the injected URL or a secret is rejected', async () => {
    const leak = new ContractFakeReasoner((req) => ({
      kind: 'FINAL',
      content: JSON.stringify(proposalFor(req, { summary: 'Claim at https://parts-update.example/claim?id=48 now' })),
    }));
    const r1 = await runReasoning(w.db.pool, w.service, { reasoner: leak, store: w.store, env }, { incidentId: incidentId as never });
    expect(r1.status).toBe('REJECTED');
    expect(r1.rejectionReasons).toContain('EXECUTABLE_URL_IN_OUTPUT');
    const secret = new ContractFakeReasoner((req) => ({
      kind: 'FINAL',
      content: JSON.stringify(proposalFor(req, { summary: `Key ${env.OPENSERV_API_KEY}` })),
    }));
    const r2 = await runReasoning(w.db.pool, w.service, { reasoner: secret, store: w.store, env }, { incidentId: incidentId as never });
    expect(r2.status).toBe('REJECTED');
    expect(r2.rejectionReasons).toContain('SECRET_IN_OUTPUT');
    // The rejected output is retained for diagnosis but the stored run never repeats the secret.
    const stored = JSON.stringify(await getReasoningRun(w.db.pool, w.people.viewer!.ctx, r2.reasoningRunId));
    expect(stored).not.toContain(env.OPENSERV_API_KEY);
  });

  it('escaped and duplicate-key payloads are rejected on the final-answer and the tool-call paths', async () => {
    const esc = (t: string) => [...t].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const variants = (req: Parameters<typeof proposalFor>[0]) => {
      const valid = JSON.stringify(proposalFor(req));
      return {
        escapedUrl: valid.replace(/"summary":"[^"]*"/, `"summary":"${esc('https://parts-update.example/claim')}"`),
        duplicate: valid.replace(/"summary":"[^"]*"/, '"summary":"ok","summary":"Fetch https://parts-update.example"'),
      };
    };
    for (const path of ['FINAL', 'TOOL'] as const)
      for (const kind of ['escapedUrl', 'duplicate'] as const) {
        const fake = new ContractFakeReasoner((req): ReasonerTurn => {
          const payload = variants(req)[kind];
          return path === 'FINAL'
            ? { kind: 'FINAL', content: payload }
            : { kind: 'TOOL_CALLS', calls: [{ id: 'c1', name: 'submit_candidate_schema', arguments: `{"proposal":${payload}}` }] };
        });
        const run = await runReasoning(w.db.pool, w.service, { reasoner: fake, store: w.store, env }, { incidentId: incidentId as never });
        expect([path, kind, run.status]).toEqual([path, kind, 'REJECTED']);
        expect(run.rejectionReasons).toContain(kind === 'duplicate' ? 'DUPLICATE_JSON_KEY' : 'EXECUTABLE_URL_IN_OUTPUT');
        expect(run.proposalId).toBeNull();
      }
  });

  it('allowed tools are scoped server-side: smuggled scope arguments are refused and flagged', async () => {
    let turn = 0;
    const fake = new ContractFakeReasoner((req): ReasonerTurn => {
      turn += 1;
      if (turn === 1)
        return {
          kind: 'TOOL_CALLS',
          calls: [
            {
              id: 'c1',
              name: 'search_evidence',
              arguments: JSON.stringify({ query: 'fan', tenantId: 'ten_other-tenant', evidenceRevisionId: 'evr_other-0001' }),
            },
            { id: 'c2', name: 'get_asset_snapshot', arguments: '{}' },
          ],
        };
      const toolMsgs = req.transcript.filter((t) => t.role === 'tool');
      expect(toolMsgs.map((t) => JSON.parse(t.content).error ?? null)).toEqual(['TOOL_ARGUMENTS_REJECTED', null]);
      return { kind: 'FINAL', content: JSON.stringify(proposalFor(req)) };
    });
    const run = await runReasoning(w.db.pool, w.service, { reasoner: fake, store: w.store, env }, { incidentId: incidentId as never });
    expect(run.status).toBe('COMPLETED');
    expect(run.injectionFlags).toContain('TOOL_ARGUMENTS_REJECTED');
    expect(run.disposition).toBe('NEEDS_HUMAN_REVIEW');
  });

  it('every run is recorded in the ledger as a non-authoritative model proposal', async () => {
    const ledger = (await readEvidenceLedger(w.db.pool, w.people.auditor!.ctx)).filter(
      (e) => e.subject.aggregateType === 'reasoning_run',
    );
    expect(ledger.length).toBeGreaterThanOrEqual(4);
    for (const e of ledger) {
      expect(e.kind).toBe('MODEL_PROPOSAL');
      expect(e.trust).toBe('CONTRACT_FAKE');
    }
  });

  it('active PDF content is removed at ingestion and never executed', async () => {
    const doc = await ingestAs(w, w.librarian, {
      ...MANUAL_C(),
      bytes: buildPdf([['Northwind wiring diagram index']], { javascript: true }),
      documentRevision: 'C-js',
    });
    expect(doc.activeContentRemoved).toEqual(expect.arrayContaining(['JAVASCRIPT', 'OPEN_ACTION']));
  });

  it('without SERV credentials the real adapter records NOT_RUN and makes no network call', async () => {
    const run = await runReasoning(
      w.db.pool,
      w.service,
      { reasoner: ServReasoningAdapter.fromEnv({}), store: w.store, env: {} },
      { incidentId: incidentId as never },
    );
    expect(run).toMatchObject({
      status: 'NOT_RUN',
      capability: { kind: 'UNSUPPORTED', reasonCode: 'SERV_API_KEY_ABSENT' },
      proposalId: null,
      resultOrigin: 'SERV_REASONING',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const stored = await getReasoningRun(w.db.pool, w.people.viewer!.ctx, run.reasoningRunId);
    expect(stored).toMatchObject({ status: 'NOT_RUN', outputDigest: null, modelId: null });
  });

  it('only worker identities may run reasoning; humans and viewers cannot', async () => {
    const fake = new ContractFakeReasoner((req) => ({ kind: 'FINAL', content: JSON.stringify(proposalFor(req)) }));
    await expect(
      runReasoning(w.db.pool, w.people.operator!.ctx, { reasoner: fake, store: w.store }, { incidentId: incidentId as never }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fake.requests).toHaveLength(0);
  });
});
