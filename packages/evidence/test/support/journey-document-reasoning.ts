// T-058 real-input journey, document + reasoning parts only (FR-22, INV-12). ONE real SERV Reasoning (OpenServ) run,
// through the product's own code path, over a real published manual:
//   throwaway database (from DATABASE_URL, dropped at the end) -> migrate -> tenant, site, people, worker service,
//   AUTHORITY policy, SOP and rule (the M04 incident world) -> an asset revision for the Dixell XR60CX -> an incident
//   opened by a labelled SIMULATOR device (trigger origin SIMULATED_INPUT; the sensor part is NOT_RUN and never claimed)
//   -> ingestDocument of the real PDF (OEM_PUBLICATION, provenance = published URL + SHA-256) -> commitIncidentEvidence
//   -> runReasoning with ServReasoningAdapter.fromEnv() under a hard cost budget -> export evidence to
//   evidence/journeys/<journeyId>/ -> journey-gate manifest -> journey gate (file-only and --database cross-check
//   against the throwaway database) -> drop the database.
// The run refuses to start unless the tracked tree is clean, so the manifest's sourceSha is exactly the code that ran.
// The SERV key is read from the environment only; it is never printed, logged or written (a redaction check over
// every exported artifact and the product's stored model input/output proves its absence).
//
//   SERV_API_KEY=... SERV_REASONING_MODEL=serv-mini SERV_REASONING_EFFORT=low DATABASE_URL=postgres://... \
//     node --experimental-transform-types --no-warnings \
//       --import ./packages/domain/test/support/ts-register.mjs \
//       packages/evidence/test/support/journey-document-reasoning.ts \
//       --journey-id j-2026-11-12-serv-document --manual <path to XR60CX-GB.pdf>
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AssetId } from '@uptimebuyer/contracts';
import { registerAsset } from '@uptimebuyer/data';
import { evaluateIncidentRules, getIncident } from '@uptimebuyer/incidents';
import { createIncidentWorld, isoAt, liveRun, person, provisionDevice } from '../../../incidents/test/helpers.js';
import {
  ContractFakeReasoner,
  LocalFilesystemObjectStore,
  ServReasoningAdapter,
  commitIncidentEvidence,
  getReasoningRun,
  ingestDocument,
  listIncidentProposals,
  referencedCitationIds,
  reopenCitation,
  runReasoning,
  type FakeScript,
} from '../../src/index.js';

const repo = path.resolve(import.meta.dirname, '..', '..', '..', '..');
interface Exchange {
  seq: number;
  url: string;
  method: string;
  requestHeaderNames: string[];
  requestSha256: string;
  requestBytes: number;
  sentAt: string;
  endedAt?: string;
  status?: number;
  transportError?: string;
  responseSha256?: string;
  responseBytes?: number;
  response?: { id: string | null } & Record<string, unknown>;
  errorBody?: string;
}
interface Pricing {
  promptPerMillion: bigint;
  completionPerMillion: bigint;
}
interface RedactionReport {
  result: 'PASS' | 'FAIL';
  files: unknown[];
  findings: unknown[];
}
/** The pure helpers in scripts/release/journey-evidence.mjs (plain ESM, loaded by path like the gate scripts). */
interface JourneyEvidence {
  JOURNEY_ID: RegExp;
  SERV_CATALOG_PRICES_CENTS: Record<string, { input: number; output: number }>;
  sha256Hex(data: string | Uint8Array): string;
  pricingMicros(model: string): Pricing;
  servCostMicros(usage: { promptTokens: number | null; completionTokens: number | null }, p: Pricing): bigint | null;
  formatUsd(micros: bigint | null): string | null;
  createRecordingFetch(): { fetch: (url: string, init: RequestInit) => Promise<Response>; exchanges: Exchange[] };
  redactionCheck(
    files: { path: string; bytes: Uint8Array; binary?: boolean }[],
    secrets: { name: string; value: string }[],
  ): RedactionReport & Record<string, unknown>;
  buildJourneyManifest(input: Record<string, unknown>): Record<string, unknown>;
}
const ev = (await import(path.join(repo, 'scripts', 'release', 'journey-evidence.mjs'))) as JourneyEvidence;
const gate = (await import(path.join(repo, 'scripts', 'release', 'journey-gate.mjs'))) as {
  headSha(root: string): string | null;
};

export const MANUAL = Object.freeze({
  url: 'https://webapps.copeland.com/Dixell/Content/Pages/Manuals/XR-CX/XR60CX/XR60CX-GB.pdf',
  sha256: '5b6f58295e0bbb4ba547fdd6d3b80509f2d5ccf7e6879ddbcd077d8855fe095f',
  bytes: 1_022_749,
  publisher: 'Copeland (owner of Dixell)',
  title: 'Dixell XR60CX Installing and Operating Instructions (GB)',
  documentRevision: '1592020060 XR60CX GB r1.1 27.04.2015',
  manufacturer: 'Dixell',
  model: 'XR60CX',
});
/** Run cost ceiling: $0.25 (well inside the authorized $1.00 even with one further worst-case turn); 120k tokens. */
export const BUDGET = Object.freeze({ maxCostMicros: 250_000n, maxRunTokens: 120_000 });

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const die = (msg: string): never => {
  console.error(`journey refused: ${msg}`);
  process.exit(2);
};
const json = (v: unknown) =>
  `${JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2)}\n`;

async function main() {
  // ---- Preflight: nothing below sends a request until every check passes.
  const journeyId = arg('--journey-id') ?? die('--journey-id is required');
  if (!ev.JOURNEY_ID.test(journeyId)) die('journeyId must match ^[a-z0-9][a-z0-9-]{0,63}$');
  const manualPath = arg('--manual') ?? die('--manual is required');
  const model = (process.env.SERV_REASONING_MODEL ?? '').trim();
  if (!(model in ev.SERV_CATALOG_PRICES_CENTS)) die(`model ${model || '(unset)'} has no recorded SERV catalog price`);
  // --contract-fake-dry-run exercises the whole pipeline with the contract fake (no SERV request, no key): its
  // reasoning is CONTRACT_FAKE, so the manifest never records a reasoning part. Dry-run ids start with "dryrun-".
  const dryRun = process.argv.includes('--contract-fake-dry-run');
  if (dryRun && !journeyId.startsWith('dryrun-')) die('a dry run needs a journeyId starting with dryrun-');
  const servKey = dryRun ? '' : (process.env.SERV_API_KEY ?? '').trim();
  if (!dryRun && !servKey) die('SERV_API_KEY is not set');
  if (!process.env.DATABASE_URL) die('DATABASE_URL is not set');
  const status = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  if (!dryRun && (status.status !== 0 || status.stdout.trim() !== ''))
    die('the working tree is not clean; commit the runner first');
  const sourceSha = gate.headSha(repo) ?? die('cannot read HEAD');
  const relDir = `evidence/journeys/${journeyId}`;
  const outDir = path.join(repo, relDir);
  if (existsSync(outDir)) die(`${relDir} already exists; a journey is recorded once`);
  const pdf = readFileSync(manualPath);
  if (ev.sha256Hex(pdf) !== MANUAL.sha256 || pdf.length !== MANUAL.bytes) die('the manual digest or size does not match');
  const pricing = ev.pricingMicros(model);
  const probe = ServReasoningAdapter.fromEnv(process.env, { fetch: async () => die('preflight must not send') });
  if (!dryRun && probe.assess().kind !== 'ELIGIBLE')
    die(`the SERV adapter is not eligible: ${JSON.stringify(probe.assess())}`);

  const startedAt = new Date().toISOString();
  const w = await createIncidentWorld('j058doc');
  const storeRoot = mkdtempSync(path.join(tmpdir(), 'ub-j058-store-'));
  const store = new LocalFilesystemObjectStore(storeRoot);
  // After a request has been sent the database is dropped only once the evidence is exported; on a later failure it is
  // kept (and named) so the run can be inspected without repeating it.
  let keepDatabase = false;
  try {
    // ---- Asset revision for the controller the manual describes. The serial is synthetic (no physical unit).
    const librarian = await person(w, 'librarian', ['operator'], null);
    const asset = await registerAsset(w.db.pool, w.admin, {
      siteId: w.siteId,
      identity: {
        manufacturer: MANUAL.manufacturer,
        model: MANUAL.model,
        serial: `SIMULATED-J058-${randomBytes(3).toString('hex')}`,
        safetyClass: 'STANDARD',
        bomRevision: 'NO-BOM-SUPPLIED',
      },
      source: 'API',
    });
    // ---- Incident from a labelled SIMULATOR device: SIMULATED_INPUT, never a physical-sensor claim.
    const device = await provisionDevice(w, { siteId: w.siteId, assetId: asset.assetId, inputClass: 'SIMULATOR' });
    const telemetry = await liveRun(w, device, [4_000, 9_000, 9_200, 9_400, 9_600, 9_800]);
    const opened = (
      await evaluateIncidentRules(w.db.pool, w.service, { assetId: asset.assetId as AssetId, at: isoAt(telemetry.at) })
    ).evaluations[0];
    if (opened?.outcome !== 'OPENED' || !opened.incidentId) throw new Error(`incident not opened: ${json(opened)}`);
    const incidentId = opened.incidentId;
    const incident = await getIncident(w.db.pool, w.people.operator!.ctx, incidentId);
    if (incident.triggerInputOrigin !== 'SIMULATED_INPUT') throw new Error('incident trigger is not SIMULATED_INPUT');

    // ---- Document part: the real published PDF through the product's ingest path.
    const doc = await ingestDocument(w.db.pool, librarian.ctx, store, {
      role: 'MANUAL',
      mediaType: 'application/pdf',
      bytes: new Uint8Array(pdf),
      title: MANUAL.title,
      documentRevision: MANUAL.documentRevision,
      applicability: { manufacturer: MANUAL.manufacturer, model: MANUAL.model, bomRevision: null, serial: null, assetId: null },
      sourceKind: 'OEM_PUBLICATION',
      sourceRef: `published ${MANUAL.url} sha256:${MANUAL.sha256}`,
    });
    const documentCapturedAt = new Date().toISOString();
    const revision = await commitIncidentEvidence(w.db.pool, w.people.operator!.ctx, store, {
      incidentId: incidentId as never,
      reasonCode: 'TRIAGE_EVIDENCE',
    });

    // ---- Reasoning part: ONE runReasoning call with the real adapter under the cost budget. No retry on any outcome.
    const recorder = ev.createRecordingFetch();
    const adapter = dryRun
      ? new ContractFakeReasoner(dryRunScript)
      : ServReasoningAdapter.fromEnv(process.env, { fetch: recorder.fetch as never });
    keepDatabase = !dryRun;
    const run = await runReasoning(
      w.db.pool,
      w.service,
      {
        reasoner: adapter,
        store,
        budget: {
          maxRunTokens: BUDGET.maxRunTokens,
          maxCostMicros: BUDGET.maxCostMicros,
          pricePerMillionPromptMicros: pricing.promptPerMillion,
          pricePerMillionCompletionMicros: pricing.completionPerMillion,
        },
      },
      { incidentId },
    );
    console.error(`reasoning run ${run.reasoningRunId}: ${run.status} ${run.failureReason ?? ''}`);
    const view = await getReasoningRun(w.db.pool, w.people.operator!.ctx, run.reasoningRunId);
    const proposals = await listIncidentProposals(w.db.pool, w.people.operator!.ctx, incidentId);
    const proposal = proposals.find((p) => p.reasoningRunId === run.reasoningRunId) ?? null;
    const citations = [];
    for (const id of proposal ? [...new Set(referencedCitationIds(proposal.proposal))] : []) {
      const c = await reopenCitation(w.db.pool, w.people.operator!.ctx, store, id);
      citations.push({
        citationId: id,
        verified: c.verified,
        documentId: c.documentId,
        title: c.title,
        documentRevision: c.documentRevision,
        locator: c.citation.locator,
        sourceDigest: c.citation.sourceDigest,
        spanText: c.text.length > 600 ? `${c.text.slice(0, 600)}…` : c.text,
        spanChars: c.text.length,
      });
    }
    const usage = { promptTokens: view.promptTokens, completionTokens: view.completionTokens };
    const costMicros = ev.servCostMicros(usage, pricing);

    // ---- Export.
    mkdirSync(outDir, { recursive: true });
    const rel = (f: string) => `${relDir}/${f}`;
    copyFileSync(manualPath, path.join(outDir, 'XR60CX-GB.pdf'));
    const documentRecord = {
      schema: 'journey-document-record.v1',
      journeyId,
      origin: 'PUBLISHED_DOCUMENT',
      source: { url: MANUAL.url, publisher: MANUAL.publisher, sha256: MANUAL.sha256, bytes: pdf.length },
      documentId: doc.documentId,
      blobId: doc.blobId,
      sha256: doc.sha256,
      title: MANUAL.title,
      documentRevision: MANUAL.documentRevision,
      role: 'MANUAL',
      sourceKind: 'OEM_PUBLICATION',
      applicability: { manufacturer: MANUAL.manufacturer, model: MANUAL.model },
      mediaType: doc.mediaType,
      extractionMethod: doc.extractionMethod,
      pageCount: doc.pageCount,
      extractedSpanCount: doc.spanCount,
      factCount: doc.factCount,
      injectionFlaggedSpanCount: doc.injectionFlaggedSpanCount,
      activeContentRemoved: doc.activeContentRemoved,
      trustLevel: doc.trustLevel,
      evidenceRevisionId: revision.evidenceRevisionId,
      ingestedAt: documentCapturedAt,
      parserNote:
        'Bounded PDF text subset (ADR 0002): text set in fonts with custom encodings is extracted as shifted glyph codes and is unreadable in those spans; nothing was OCRed or hand-corrected.',
    };
    writeFileSync(path.join(outDir, 'document.json'), json(documentRecord));
    const reasoningRecord = {
      schema: 'journey-reasoning-record.v1',
      journeyId,
      origin: 'SERV_REASONING',
      adapter: view.adapter,
      resultOrigin: run.resultOrigin,
      endpoint: 'https://inference-api.openserv.ai/v1/chat/completions',
      modelRequested: model,
      reasoningEffort: (process.env.SERV_REASONING_EFFORT ?? '').trim().toLowerCase() || null,
      modelEchoed: view.modelId,
      modelVersion: view.modelVersion,
      reasoningRunId: run.reasoningRunId,
      status: run.status,
      disposition: run.disposition,
      capability: run.capability,
      failureReason: run.failureReason,
      rejectionReasons: run.rejectionReasons,
      injectionFlags: run.injectionFlags,
      turns: view.turns,
      toolCalls: view.toolCalls,
      latencyMs: view.latencyMs,
      startedAt: view.startedAt,
      completedAt: view.completedAt,
      usage,
      pricing: {
        source: 'SERV catalog GET /v1/models on 2026-11-12 (US cents per million tokens)',
        cents: ev.SERV_CATALOG_PRICES_CENTS[model],
        promptMicrosPerMillion: pricing.promptPerMillion,
        completionMicrosPerMillion: pricing.completionPerMillion,
      },
      costMicros,
      costUsd: ev.formatUsd(costMicros),
      budget: { maxCostMicros: BUDGET.maxCostMicros, maxCostUsd: ev.formatUsd(BUDGET.maxCostMicros), maxRunTokens: BUDGET.maxRunTokens, authorizedCapUsd: '1.000000' },
      digests: {
        inputDigest: view.inputDigest,
        outputDigest: view.outputDigest,
        configDigest: view.configDigest,
        promptTemplateDigest: view.promptTemplateDigest,
      },
      exchanges: recorder.exchanges.map((x) => ({
        seq: x.seq,
        url: x.url,
        method: x.method,
        requestHeaderNames: x.requestHeaderNames,
        requestSha256: x.requestSha256,
        requestBytes: x.requestBytes,
        sentAt: x.sentAt,
        endedAt: x.endedAt ?? null,
        status: x.status ?? null,
        transportError: x.transportError ?? null,
        responseSha256: x.responseSha256 ?? null,
        responseBytes: x.responseBytes ?? null,
        response: x.response ?? null,
        errorBody: x.errorBody ?? null,
      })),
      responseIds: recorder.exchanges.map((x) => x.response?.id).filter((v): v is string => typeof v === 'string'),
      proposal: proposal
        ? {
            proposalId: proposal.proposalId,
            proposalDigest: proposal.proposalDigest,
            authority: proposal.authority,
            label: proposal.label,
            lifecycle: proposal.lifecycle,
            verification: proposal.verification,
            reviewReasons: proposal.reviewReasons,
            candidates: proposal.candidates,
            body: proposal.proposal,
          }
        : null,
      citations,
      note: 'Request bodies are not exported (digests only); they are the product packet built from this manual and the synthetic incident.',
    };
    writeFileSync(path.join(outDir, 'reasoning.json'), json(reasoningRecord));

    // ---- Redaction check over every exported artifact, the product's stored (scrubbed) model input/output and the
    // request bodies the adapter sent. Only names of checked secrets are recorded, never their values.
    const secrets = [{ name: 'SERV_API_KEY', value: servKey }];
    const exported = [
      { path: rel('XR60CX-GB.pdf'), bytes: readFileSync(path.join(outDir, 'XR60CX-GB.pdf')), binary: true },
      { path: rel('document.json'), bytes: readFileSync(path.join(outDir, 'document.json')) },
      { path: rel('reasoning.json'), bytes: readFileSync(path.join(outDir, 'reasoning.json')) },
    ];
    const stored = [
      { path: 'store:reasoning-input', bytes: Buffer.from(await store.get(view.inputObjectKey)) },
      ...(view.outputObjectKey
        ? [{ path: 'store:reasoning-output', bytes: Buffer.from(await store.get(view.outputObjectKey)) }]
        : []),
    ];
    const exportedCheck = ev.redactionCheck(exported, secrets);
    const storedCheck = ev.redactionCheck(stored, secrets);
    const redaction = {
      ...exportedCheck,
      productStore: { result: storedCheck.result, files: storedCheck.files, findings: storedCheck.findings },
      result: exportedCheck.result === 'PASS' && storedCheck.result === 'PASS' ? 'PASS' : 'FAIL',
    };
    writeFileSync(path.join(outDir, 'redaction-check.json'), json(redaction));

    // ---- Manifest: the reasoning part is recorded only for a completed, validated proposal.
    const art = (f: string) => ({ path: rel(f), sha256: ev.sha256Hex(readFileSync(path.join(outDir, f))) });
    const reasoningPassed =
      run.status === 'COMPLETED' && proposal !== null && redaction.result === 'PASS' && view.adapter === 'SERV_REASONING';
    const endedAt = new Date().toISOString();
    const manifest = ev.buildJourneyManifest({
      journeyId,
      sourceSha,
      startedAt,
      endedAt,
      parts: {
        ...(redaction.result === 'PASS'
          ? {
              document: {
                capturedAt: documentCapturedAt,
                artifacts: [art('XR60CX-GB.pdf'), art('document.json')],
                facts: { documentId: doc.documentId, sha256: MANUAL.sha256, sourceUrl: MANUAL.url, pageCount: doc.pageCount, extractedSpanCount: doc.spanCount },
              },
            }
          : {}),
        ...(reasoningPassed
          ? {
              reasoning: {
                capturedAt: view.completedAt,
                artifacts: [art('reasoning.json'), art('redaction-check.json')],
                facts: { runId: run.reasoningRunId, runStatus: run.status, proposalId: proposal?.proposalId, model: view.modelId, responseIds: reasoningRecord.responseIds, costUsd: ev.formatUsd(costMicros) },
              },
            }
          : {}),
      },
      context: {
        incidentTrigger: 'SIMULATED_INPUT (labelled SIMULATOR device in a throwaway database; the sensor part is NOT_RUN)',
        tenant: 'synthetic tenant in a throwaway database, dropped after the gate ran',
        runner: 'packages/evidence/test/support/journey-document-reasoning.ts',
        reasoningOutcome: reasoningPassed
          ? 'COMPLETED'
          : `not recorded: ${view.adapter} ${run.status} ${run.failureReason ?? run.rejectionReasons.join(',')}`.trim(),
      },
    });
    const manifestRel = rel('manifest.journey.json');
    writeFileSync(path.join(repo, manifestRel), json(manifest));

    // ---- Journey gate: file-only, then the database cross-check against the throwaway database. The child gets no
    // SERV key; the database URL travels in JOURNEY_DATABASE_URL, never on argv.
    const childEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', JOURNEY_DATABASE_URL: w.db.url };
    const runGate = (extra: string[]) => {
      const r = spawnSync(
        process.execPath,
        ['scripts/release/journey-gate.mjs', '--manifest', manifestRel, '--json', ...extra],
        { cwd: repo, encoding: 'utf8', env: childEnv },
      );
      return { code: r.status, report: JSON.parse(r.stdout) as { result: string; parts: { part: string; status: string; reasons: string[] }[] } };
    };
    const fileOnly = runGate([]);
    const withDb = runGate(['--database', '--tenant', w.tenant.tenantId, '--incident', incidentId]);
    mkdirSync(path.join(repo, 'docs', 'release', 'evidence'), { recursive: true });
    const gateFile = `docs/release/evidence/t058-journey-${journeyId}.gate.json`;
    const gateDbFile = `docs/release/evidence/t058-journey-${journeyId}.gate-database.json`;
    writeFileSync(path.join(repo, gateFile), json(fileOnly.report));
    writeFileSync(path.join(repo, gateDbFile), json(withDb.report));
    const leak = ev.redactionCheck(
      [gateFile, gateDbFile, manifestRel].map((f) => ({ path: f, bytes: readFileSync(path.join(repo, f)) })),
      secrets,
    );
    const statusOf = (r: typeof fileOnly) => Object.fromEntries(r.report.parts.map((p) => [p.part, p.status]));
    console.log(
      json({
        journeyId,
        sourceSha,
        incidentId,
        tenantId: w.tenant.tenantId,
        reasoningRunId: run.reasoningRunId,
        status: run.status,
        disposition: run.disposition,
        failureReason: run.failureReason,
        rejectionReasons: run.rejectionReasons,
        modelEchoed: view.modelId,
        responseIds: reasoningRecord.responseIds,
        exchanges: recorder.exchanges.map((x) => ({ seq: x.seq, status: x.status ?? null, transportError: x.transportError ?? null, errorBody: x.errorBody ?? null })),
        usage,
        costUsd: ev.formatUsd(costMicros),
        redaction: redaction.result,
        gateArtifactsRedaction: leak.result,
        dryRun,
        gate: { fileOnly: { code: fileOnly.code, result: fileOnly.report.result, parts: statusOf(fileOnly) }, withDatabase: { code: withDb.code, result: withDb.report.result, parts: statusOf(withDb) } },
      }),
    );
    keepDatabase = false;
  } finally {
    if (keepDatabase) {
      console.error(`evidence export failed after the SERV request; database kept for inspection: ${new URL(w.db.url).pathname}`);
      await w.gw.close().catch(() => {});
      await w.db.pool.end().catch(() => {});
    } else {
      await w.close().catch(() => {});
      rmSync(storeRoot, { recursive: true, force: true });
    }
  }
}

/** Contract-fake script for --contract-fake-dry-run: one search tool call, then a proposal citing the first excerpt. */
const dryRunScript: FakeScript = (req, turn) => {
  const usage = { promptTokens: Math.ceil(req.packetText.length / 4), completionTokens: 200 };
  if (turn === 1)
    return { kind: 'TOOL_CALLS', calls: [{ id: 'call-1', name: 'search_evidence', arguments: '{"query":"temperature alarm"}' }], usage };
  const e = req.packet.excerpts[0];
  if (!e) throw new Error('dry run: the packet has no excerpt');
  const body = {
    schemaVersion: 1,
    incidentId: req.packet.incident.incidentId,
    evidenceRevisionId: req.packet.binding.evidenceRevisionId,
    inputDigest: req.inputDigest,
    faultHypotheses: [{ code: 'UNKNOWN', rationale: 'CONTRACT_FAKE dry run.', citationIds: [e.citationId] }],
    extractedFields: [
      { field: 'MODEL', component: null, value: 'XR60CX', citations: [{ citationId: e.citationId, sourceDigest: e.sourceDigest, locator: e.locator, quote: null }] },
    ],
    candidateActions: [],
    conflicts: [],
    uncertainty: ['INSUFFICIENT_EVIDENCE'],
    providerQueries: [],
    confidencePpm: 100_000,
    summary: 'CONTRACT_FAKE dry run proposal; not a SERV result.',
  };
  return { kind: 'FINAL', content: JSON.stringify(body), usage };
};

await main();
