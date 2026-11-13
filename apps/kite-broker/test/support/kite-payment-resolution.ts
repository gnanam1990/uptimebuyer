// T-058 manual resolution of an UNKNOWN Kite payment (INV-08, STATE-MACHINES §6). Used after a live journey run kept
// its throwaway database because the paid outcome stayed UNKNOWN (Kite has no lookup by client key). It:
//   1. checks the operator's out-of-band facts reconcile with the capture AND are bound to this run's payment (the
//      activity falls after the session approval and inside the run's paid call; the approval names the request the
//      run's session row recorded; activity, approval and session usage name one session; a settlement reference the
//      attempt recorded must match) before anything is written;
//   2. builds the reconciliation evidence, redaction-checks it in memory, writes it (0600) and takes its sha256 as the
//      evidence digest; progress is persisted (resolution-progress.json) at every stage;
//   3. records CAPTURED through the product's own resolveUnknownIntentManually as the world's finance approver,
//      authenticated through the real path (authenticateHuman + resolveTenantContext with the test identity provider);
//      it appends the CAPTURE, releases any remainder and confirms; nothing is re-sent and no row is edited directly.
//      A retry after the capture committed verifies the product's manual receipt (same intent, same evidence digest,
//      the CAPTURED amount) and resumes the exports: it never captures twice;
//   4. re-exports the payment from the database, keeps the run's manifest (manifest-run.journey.json) and its gate
//      outputs (*.run-gate*.json), records the journey again with a resolution section and runs the journey gate
//      file-only and with the database;
//   5. drops the database only when the payment reconciled and the payment part PASSes in both gate reports.
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { getCommercialIntent, resolveUnknownIntentManually } from '@uptimebuyer/commerce';
import { TestIdentityProvider, humanContext } from '../../../../packages/data/test/helpers.js';
import { conservation } from '../helpers.js';
import { LIONX402 } from './kite-payment-journey.js';

const repo = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const json = (v: unknown) => `${JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2)}\n`;
const HEX40 = /^[0-9a-f]{40}$/;
const MICROS_PER_CENT = 10_000n;

/** The operator's out-of-band, read-only observations (no secret: digests stand in for account identifiers). */
export interface ReconciliationFacts {
  walletBaseUsdc: { before: string; beforeSource: string; after: string; afterReadAt: string };
  activity: {
    id: string;
    kind: string;
    status: string;
    title: string;
    occurredAt: string;
    chainId: number;
    amountRaw: string;
    assetSymbol: string;
    assetAddress: string;
    txHash: string;
    merchantHost: string;
    requestUrl: string;
    /** sha256 of the Kite session id the payment activity names. */
    sessionIdSha256: string;
  };
  /** Kite's session_approval activity for the run's approval request. */
  sessionApproval: { activityId: string; at: string; requestRefSha256: string; sessionIdSha256: string };
  session: {
    idSha256: string;
    status: string;
    expiresAt: string;
    spentTotal: string;
    spentTotalRaw: string;
    reservedTotal: string;
  };
  chainDiscrepancy: { reportedChainId: number; expectedChainId: number; docCitation: string; note: string };
}

export interface ResolutionOptions {
  databaseName: string;
  /** Server URL whose path is replaced by databaseName (default DATABASE_URL). */
  adminDatabaseUrl?: string;
  journeyId: string;
  artifactRoot: string;
  gateEvidenceDir: string;
  /** The commit recording the resolution (HEAD, clean tracked tree for a real record). */
  sourceSha: string;
  intentId: string;
  capturedMinor: bigint;
  reasonCode: string;
  facts: ReconciliationFacts;
  ownerDecision: { decidedBy: string; role: string; decidedOn: string; statement: string; relayedBy?: string };
  isAuthorized(
    gate: string,
    id: string,
    request: unknown,
    window: { journeyId: string; startedAt: string; endedAt: string },
  ): boolean;
  secrets(): { name: string; value: string }[];
  log(line: string): void;
  runGateCli?(args: { manifestRel: string; database?: { url: string; tenantId: string; incidentId: string } }): {
    code: number | null;
    report: GateReport;
  };
  dropDatabase?: boolean;
  /** Test-only fault points. */
  faults?: { afterCapture?(): void };
}

interface GateReport {
  result: string;
  parts: { part: string; status: string; reasons: string[] }[];
}

export interface ResolutionReport {
  journeyId: string;
  intentState: string;
  capturedMinor: bigint;
  releasedMinor: bigint;
  openReservedMinor: bigint;
  evidenceDigest: string;
  resolvedAt: string;
  gate: {
    fileOnly: { result: string; parts: Record<string, string> };
    withDatabase: { result: string; parts: Record<string, string> };
  };
  databaseDropped: boolean;
  /** True when a previous attempt had already committed the capture and this one only finished the exports. */
  resumed: boolean;
  manualReceipts: number;
  captureEntries: number;
}

/** Decimal with up to 6 places to micro-units, or null. */
function micros(v: string): bigint | null {
  const m = /^([0-9]{1,12})(?:\.([0-9]{1,6}))?$/.exec(v);
  return m ? BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0')) : null;
}

/** What the run and its database recorded about the paid call the observations must belong to. */
export interface PaymentBinding {
  runStartedAt: string;
  /** When the attempt's SEND_STARTED was committed (the paid call started). */
  executeStartedAt: string;
  runEndedAt: string;
  /** sha256 of the approval request id the run's Kite session row recorded. */
  requestRefSha256: string;
  /** A settlement reference the attempt recorded, if any. */
  settlementReference: string | null;
}

/**
 * Every observation must agree with a capture of exactly `capturedMinor` cents to the bound merchant URL, AND belong to
 * this run's paid call: a matching amount and URL alone are not enough.
 */
export function factsReconcile(f: ReconciliationFacts, capturedMinor: bigint, b: PaymentBinding): string[] {
  const want = capturedMinor * MICROS_PER_CENT;
  const r: string[] = [];
  const before = micros(f.walletBaseUsdc.before);
  const after = micros(f.walletBaseUsdc.after);
  if (before === null || after === null || before - after !== want) r.push('WALLET_DELTA');
  if (f.activity.kind !== 'x402_payment' || f.activity.status !== 'completed') r.push('ACTIVITY_NOT_COMPLETED_PAYMENT');
  if (f.activity.amountRaw !== want.toString() || f.activity.assetSymbol !== 'USDC') r.push('ACTIVITY_AMOUNT');
  if (f.activity.assetAddress.toLowerCase() !== LIONX402.asset.toLowerCase()) r.push('ACTIVITY_ASSET');
  if (f.activity.merchantHost !== LIONX402.host || f.activity.requestUrl !== LIONX402.url) r.push('ACTIVITY_MERCHANT');
  // Time: the approval inside the run, the payment after the approval and inside the run's paid call.
  const at = Date.parse(f.activity.occurredAt);
  const approved = Date.parse(f.sessionApproval?.at);
  if (!(at >= Date.parse(b.executeStartedAt) && at <= Date.parse(b.runEndedAt))) r.push('ACTIVITY_OUTSIDE_PAYMENT');
  if (!(approved >= Date.parse(b.runStartedAt) && approved <= at)) r.push('APPROVAL_OUTSIDE_RUN');
  // Identity: the approval is for the run's own request; approval, payment and usage name one session.
  if (f.sessionApproval?.requestRefSha256 !== b.requestRefSha256) r.push('SESSION_REQUEST_MISMATCH');
  if (
    !/^[0-9a-f]{64}$/.test(String(f.session.idSha256)) ||
    f.activity.sessionIdSha256 !== f.session.idSha256 ||
    f.sessionApproval?.sessionIdSha256 !== f.session.idSha256
  )
    r.push('SESSION_MISMATCH');
  if (b.settlementReference !== null && f.activity.txHash.toLowerCase() !== b.settlementReference.toLowerCase())
    r.push('SETTLEMENT_REFERENCE_MISMATCH');
  if (micros(f.session.spentTotal) !== want || f.session.spentTotalRaw !== want.toString()) r.push('SESSION_SPENT');
  if (micros(f.session.reservedTotal) !== 0n) r.push('SESSION_RESERVED');
  if (!/^0x[0-9a-f]{64}$/i.test(f.activity.txHash)) r.push('TX_HASH');
  return r;
}

/** A private (0600) file; derived exports are rewritten on a resumed run. */
function writePrivate(file: string, text: string | Uint8Array) {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

interface Progress {
  schema: 'journey-resolution-progress.v1';
  journeyId: string;
  intentId: string;
  evidenceDigest: string;
  capturedMinor: string;
  reasonCode: string;
  stage: 'EVIDENCE_WRITTEN' | 'CAPTURED' | 'EXPORTED';
  resolvedAt: string | null;
  updatedAt: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function resolveKitePayment(o: ResolutionOptions): Promise<ResolutionReport> {
  const relDir = `evidence/journeys/${o.journeyId}`;
  const dir = path.join(o.artifactRoot, relDir);
  const rel = (f: string) => `${relDir}/${f}`;
  const manifestFile = path.join(dir, 'manifest.journey.json');
  const runCopyFile = path.join(dir, 'manifest-run.journey.json');
  const progressFile = path.join(dir, 'resolution-progress.json');
  const evidenceFile = path.join(dir, 'reconciliation.json');
  if (!HEX40.test(o.sourceSha)) throw new Error('sourceSha must be a 40-hex commit');
  const progress: Progress | null = existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, 'utf8')) : null;
  if (progress?.stage === 'EXPORTED') throw new Error('this journey is already resolved');
  if (progress && (progress.intentId !== o.intentId || progress.journeyId !== o.journeyId))
    throw new Error('the recorded resolution progress is for another intent');
  // The run's manifest: its kept copy once a previous attempt reached the export, else the manifest itself.
  const runSource = existsSync(runCopyFile) ? runCopyFile : manifestFile;
  if (!existsSync(runSource)) throw new Error(`no run manifest in ${relDir}`);
  if (runSource === runCopyFile && !progress) throw new Error('this journey is already resolved');
  const run = JSON.parse(readFileSync(runSource, 'utf8'));
  if (run.resolution !== undefined) throw new Error('this journey is already resolved');
  const runPay = run.parts?.payment;
  if (
    run.journeyId !== o.journeyId ||
    !runPay ||
    runPay.facts?.state !== 'UNKNOWN' ||
    runPay.facts?.intentId !== o.intentId
  )
    throw new Error('the run manifest does not record this intent as UNKNOWN');
  if (!HEX40.test(String(run.sourceSha))) throw new Error('the run manifest has no source commit');
  const merchant = JSON.parse(readFileSync(path.join(dir, 'merchant-response.json'), 'utf8'));
  const runPayment = JSON.parse(readFileSync(path.join(dir, 'payment.json'), 'utf8'));
  const ev = (await import(path.join(repo, 'scripts', 'release', 'journey-evidence.mjs'))) as any;
  const jg = (await import(path.join(repo, 'scripts', 'release', 'journey-gate.mjs'))) as any;
  const secrets = o.secrets();
  const fileSha = (f: string) => sha256(readFileSync(path.join(dir, f)));
  const saveProgress = (p: Omit<Progress, 'schema' | 'journeyId' | 'intentId' | 'updatedAt'>) =>
    writePrivate(
      progressFile,
      json({
        schema: 'journey-resolution-progress.v1',
        journeyId: o.journeyId,
        intentId: o.intentId,
        ...p,
        updatedAt: new Date().toISOString(),
      }),
    );

  const admin = o.adminDatabaseUrl ?? process.env.DATABASE_URL;
  if (!admin) throw new Error('DATABASE_URL is not set');
  const url = new URL(admin);
  url.pathname = `/${o.databaseName}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  pool.on('error', () => {});
  let dropped = false;
  try {
    const intent = (await pool.query(`SELECT * FROM commercial_intents WHERE id = $1`, [o.intentId])).rows[0];
    const attempt = (await pool.query(`SELECT * FROM external_attempts WHERE intent_id = $1`, [o.intentId])).rows[0];
    if (!intent || !attempt) throw new Error('the intent or its attempt is missing');
    const tenantId = intent.tenant_id as string;
    const sessionRow = (
      await pool.query(
        `SELECT * FROM execution_authority_sessions WHERE tenant_id = $1 AND execution_authority_id = $2`,
        [tenantId, intent.execution_authority_id],
      )
    ).rows[0];
    const finance = (
      await pool.query(
        `SELECT u.external_subject FROM users u JOIN role_assignments r ON r.user_id = u.id
          WHERE r.tenant_id = $1 AND r.role = 'finance_approver' ORDER BY u.external_subject LIMIT 1`,
        [tenantId],
      )
    ).rows[0];
    if (!finance) throw new Error('the world has no finance approver');
    const idp = await TestIdentityProvider.create();
    const ctx = await humanContext(pool, idp, finance.external_subject, tenantId);

    let evidenceDigest: string;
    let resolvedAt: string;
    let resumed = false;
    if (intent.state === 'UNKNOWN') {
      // ---- nothing was captured yet: bind and check the observations, then write the evidence and capture
      if (attempt.adapter_capability !== 'UNSUPPORTED')
        throw new Error('the intent is not an UNKNOWN effect awaiting manual resolution');
      const requestRef = sessionRow?.provider_session_ref as string | null | undefined;
      const requestRefSha256 = requestRef ? sha256(requestRef) : '';
      if (!requestRef || (runPayment.kiteSession?.requestRefSha256 ?? requestRefSha256) !== requestRefSha256)
        throw new Error('the run did not record the Kite session request this payment ran under');
      const problems = factsReconcile(o.facts, o.capturedMinor, {
        runStartedAt: run.startedAt,
        executeStartedAt: new Date(attempt.created_at).toISOString(),
        runEndedAt: run.endedAt,
        requestRefSha256,
        settlementReference: (attempt.provider_ref as string | null) ?? null,
      });
      if (problems.length) throw new Error(`the facts do not reconcile with the capture: ${problems.join(', ')}`);
      const bytes = Buffer.from(
        json({
          schema: 'journey-payment-reconciliation.v1',
          journeyId: o.journeyId,
          intentId: o.intentId,
          externalAttemptId: attempt.id,
          authorizationId: runPay.authorizationId,
          run: {
            sourceSha: run.sourceSha,
            manifestSha256: sha256(readFileSync(runSource)),
            paymentRecordSha256: fileSha('payment.json'),
            executeStartedAt: new Date(attempt.created_at).toISOString(),
            requestRefSha256,
            brokerOutcome: {
              intentState: intent.state,
              externalOutcomeState: attempt.external_outcome_state,
              adapterCapability: attempt.adapter_capability,
              reasonCode: attempt.reason_code,
              rawResponseDigest: attempt.raw_response_digest,
            },
          },
          observations: o.facts,
          merchantResponse: {
            origin: merchant.origin,
            statusCode: merchant.statusCode,
            resultCount: merchant.resultCount,
            responseSha256: merchant.responseSha256,
            artifactSha256: fileSha('merchant-response.json'),
          },
          openQuestion: {
            topic: 'settlement chain reported by kpass',
            ...o.facts.chainDiscrepancy,
            adapterPolicy:
              'unchanged: the adapter keeps refusing to confirm any chain id other than 8453 automatically',
          },
          ownerDecision: o.ownerDecision,
          resolution: { resolution: 'CAPTURED', capturedMinor: o.capturedMinor, reasonCode: o.reasonCode },
          recordedAt: new Date().toISOString(),
          note: 'Read-only observations (kpass wallet balance, activity, session list in the broker state root). Account identifiers are recorded as digests or left out; nothing was re-sent.',
        }),
      );
      // Redaction BEFORE the digest is cited and before any capture: a leak stops here with nothing written.
      const pre = ev.redactionCheck([{ path: rel('reconciliation.json'), bytes }], secrets);
      ev.enforceRedaction(pre, [], 'reconciliation evidence (before capture)');
      evidenceDigest = `sha256:${sha256(bytes)}`;
      // Progress first, then the evidence: a retry while the intent is still UNKNOWN simply starts over.
      saveProgress({
        evidenceDigest,
        capturedMinor: o.capturedMinor.toString(),
        reasonCode: o.reasonCode,
        stage: 'EVIDENCE_WRITTEN',
        resolvedAt: null,
      });
      writePrivate(evidenceFile, bytes);
      await resolveUnknownIntentManually(pool, ctx, {
        commercialIntentId: o.intentId as never,
        resolution: 'CAPTURED',
        capturedMinor: o.capturedMinor,
        evidenceDigest,
        reasonCode: o.reasonCode,
      });
      resolvedAt = new Date().toISOString();
      saveProgress({
        evidenceDigest,
        capturedMinor: o.capturedMinor.toString(),
        reasonCode: o.reasonCode,
        stage: 'CAPTURED',
        resolvedAt,
      });
    } else {
      // ---- a previous attempt committed the capture: verify it is exactly ours, then only finish the exports
      if (!progress || intent.state !== 'CONFIRMED')
        throw new Error(`the intent is ${intent.state}, not an UNKNOWN effect awaiting manual resolution`);
      if (!existsSync(evidenceFile) || `sha256:${fileSha('reconciliation.json')}` !== progress.evidenceDigest)
        throw new Error('the recorded reconciliation evidence does not match the recorded progress');
      const receipts = (
        await pool.query(
          `SELECT kind, raw_response_digest, observed_at FROM external_receipts
            WHERE tenant_id = $1 AND intent_id = $2 AND provider_status LIKE 'manual\\_%'`,
          [tenantId, o.intentId],
        )
      ).rows;
      const captures = (
        await pool.query(
          `SELECT coalesce(sum(amount_minor), 0) AS n, count(*) AS c FROM budget_ledger_entries
            WHERE tenant_id = $1 AND intent_id = $2 AND movement_type = 'CAPTURE'`,
          [tenantId, o.intentId],
        )
      ).rows[0];
      if (
        receipts.length !== 1 ||
        receipts[0].kind !== 'PAYMENT_SETTLEMENT' ||
        receipts[0].raw_response_digest !== progress.evidenceDigest ||
        BigInt(captures.n) !== o.capturedMinor ||
        Number(captures.c) !== 1 ||
        progress.capturedMinor !== o.capturedMinor.toString() ||
        attempt.reason_code !== o.reasonCode
      )
        throw new Error('the intent was resolved with other evidence or another amount; refusing to export');
      evidenceDigest = progress.evidenceDigest;
      resolvedAt = progress.resolvedAt ?? new Date(receipts[0].observed_at).toISOString();
      resumed = true;
      saveProgress({
        evidenceDigest,
        capturedMinor: o.capturedMinor.toString(),
        reasonCode: o.reasonCode,
        stage: 'CAPTURED',
        resolvedAt,
      });
    }
    o.faults?.afterCapture?.();

    // ---- exports from the database
    const view = await getCommercialIntent(pool, ctx, o.intentId);
    const ledger = await conservation({ db: { pool }, tenant: { tenantId } } as never);
    const counts = (
      await pool.query(
        `SELECT
           (SELECT coalesce(sum(amount_minor), 0) FROM budget_ledger_entries WHERE tenant_id = $1 AND intent_id = $2
              AND movement_type = 'RELEASE') AS released,
           (SELECT count(*) FROM budget_ledger_entries WHERE tenant_id = $1 AND intent_id = $2
              AND movement_type = 'CAPTURE') AS captures,
           (SELECT count(*) FROM external_receipts WHERE tenant_id = $1 AND intent_id = $2
              AND provider_status LIKE 'manual\\_%') AS receipts`,
        [tenantId, o.intentId],
      )
    ).rows[0];
    const released = BigInt(counts.released);
    const state = view.intent.state as string;
    const captured = view.money.capturedGrossMinor;
    const reconciled =
      state === 'CONFIRMED' &&
      captured === o.capturedMinor &&
      view.money.openReservedMinor === 0n &&
      ledger.problems.length === 0 &&
      Number(counts.receipts) === 1 &&
      Number(counts.captures) === 1;
    writePrivate(
      path.join(dir, 'payment-resolved.json'),
      json({
        schema: 'journey-kite-payment-record.v1',
        journeyId: o.journeyId,
        origin: 'KITE_PASSPORT',
        intentId: o.intentId,
        externalAttemptId: attempt.id,
        authorizationId: runPay.authorizationId,
        state,
        amountMinor: captured,
        releasedMinor: released,
        money: view.money,
        attempt: view.attempt,
        receipts: view.receipts,
        transitions: view.transitions,
        ledgerConservation: ledger.problems.length === 0 ? 'HOLDS' : ledger.problems,
        resolution: {
          kind: 'MANUAL_FINANCE_RESOLUTION',
          resolution: 'CAPTURED',
          capturedMinor: o.capturedMinor,
          evidenceDigest,
          reasonCode: o.reasonCode,
          resolvedBy: 'finance_approver of the synthetic tenant (product path resolveUnknownIntentManually)',
          resolvedAt,
          resumedExport: resumed,
        },
        settlement: {
          reference: o.facts.activity.txHash,
          reportedChainId: o.facts.activity.chainId,
          payTo: LIONX402.host,
        },
        reconciled,
        reSent: false,
      }),
    );
    const check = ev.redactionCheck(
      ['reconciliation.json', 'payment-resolved.json'].map((f) => ({
        path: rel(f),
        bytes: readFileSync(path.join(dir, f)),
      })),
      secrets,
    );
    writePrivate(path.join(dir, 'redaction-check-resolution.json'), json(check));
    // The capture is committed by now; a leak in the export removes only the export (the evidence stays for review).
    ev.enforceRedaction(check, [path.join(dir, 'payment-resolved.json')], 'resolution export');

    // ---- keep the run's manifest and gate outputs; record the journey again with its resolution
    if (!existsSync(runCopyFile)) {
      copyFileSync(manifestFile, runCopyFile);
      chmodSync(runCopyFile, 0o600);
    }
    for (const [from, to] of [
      [`t058-journey-${o.journeyId}.gate.json`, `t058-journey-${o.journeyId}.run-gate.json`],
      [`t058-journey-${o.journeyId}.gate-database.json`, `t058-journey-${o.journeyId}.run-gate-database.json`],
    ] as const)
      if (existsSync(path.join(o.gateEvidenceDir, from)) && !existsSync(path.join(o.gateEvidenceDir, to)))
        renameSync(path.join(o.gateEvidenceDir, from), path.join(o.gateEvidenceDir, to));
    const art = (f: string) => ({ path: rel(f), sha256: fileSha(f) });
    const resolution = {
      kind: 'MANUAL_FINANCE_RESOLUTION',
      resolution: 'CAPTURED',
      capturedMinor: Number(captured),
      intentId: o.intentId,
      sourceSha: o.sourceSha,
      resolvedAt,
      reasonCode: o.reasonCode,
      evidence: art('reconciliation.json'),
      evidenceDigest,
      runManifest: art('manifest-run.journey.json'),
    };
    const parts: Record<string, unknown> = {
      payment: {
        capturedAt: resolvedAt,
        authorizationId: runPay.authorizationId,
        artifacts: [
          art('payment-resolved.json'),
          art('reconciliation.json'),
          art('redaction-check-resolution.json'),
          art('payment.json'),
          art('gate-decision.json'),
        ],
        facts: {
          ...runPay.facts,
          state,
          reconciled,
          amountMinor: Number(captured),
          settlementReference: o.facts.activity.txHash,
          resolution: { kind: resolution.kind, resolution: 'CAPTURED', evidenceDigest, resolvedAt },
        },
      },
    };
    if (merchant.origin === 'PROVIDER_LIVE' && merchant.statusCode >= 200 && merchant.statusCode < 300)
      parts.fulfillment = {
        capturedAt: merchant.observedAt,
        artifacts: [art('merchant-response.json')],
        facts: {
          statusCode: merchant.statusCode,
          resultCount: merchant.resultCount,
          responseSha256: merchant.responseSha256,
        },
      };
    if (run.parts.duplicate)
      parts.duplicate = {
        capturedAt: run.parts.duplicate.capturedAt,
        artifacts: run.parts.duplicate.artifacts,
        facts: run.parts.duplicate.facts,
      };
    const endedAt = new Date().toISOString();
    const manifest = ev.buildJourneyManifest({
      journeyId: o.journeyId,
      sourceSha: o.sourceSha,
      runSourceSha: run.sourceSha,
      startedAt: run.startedAt,
      endedAt,
      parts,
      recordable: ev.PAYMENT_RECORDED_PARTS,
      resolution,
      context: {
        ...run.context,
        resolution:
          'The paid outcome stayed UNKNOWN in the run (KITE_UNEXPECTED_CHAIN); the owner, as finance approver, resolved it CAPTURED from read-only evidence (reconciliation.json). The run manifest is manifest-run.journey.json.',
        resolutionRunner: 'apps/kite-broker/test/support/journey-kite-resolution.ts',
      },
    });
    writePrivate(manifestFile, json(manifest));

    // ---- journey gate: file-only and with the database (before any drop)
    const gateCtx = {
      artifactRoot: o.artifactRoot,
      expectedSha: o.sourceSha,
      simulatedDigests: jg.loadSimulatedDigests(repo),
      isAuthorized: o.isAuthorized,
    };
    const fileOnly = jg.evaluateJourney(manifest, gateCtx) as GateReport;
    const facts = await jg.collectDatabaseFacts(pool, { tenantId, incidentId: intent.incident_id });
    const withDatabase = jg.evaluateJourney(manifest, { ...gateCtx, databaseFacts: facts }) as GateReport;
    const manifestRel = rel('manifest.journey.json');
    const cli = o.runGateCli
      ? {
          fileOnly: o.runGateCli({ manifestRel }),
          withDatabase: o.runGateCli({
            manifestRel,
            database: { url: url.toString(), tenantId, incidentId: intent.incident_id },
          }),
        }
      : null;
    const fileReport = cli?.fileOnly.report ?? fileOnly;
    const dbReport = cli?.withDatabase.report ?? withDatabase;
    const gateFile = path.join(o.gateEvidenceDir, `t058-journey-${o.journeyId}.gate.json`);
    const gateDbFile = path.join(o.gateEvidenceDir, `t058-journey-${o.journeyId}.gate-database.json`);
    writePrivate(gateFile, json(fileReport));
    writePrivate(gateDbFile, json(dbReport));
    const leak = ev.redactionCheck(
      [gateFile, gateDbFile, manifestFile].map((f) => ({ path: f, bytes: readFileSync(f) })),
      secrets,
    );
    ev.enforceRedaction(leak, [gateFile, gateDbFile], 'gate artifacts');
    saveProgress({
      evidenceDigest,
      capturedMinor: o.capturedMinor.toString(),
      reasonCode: o.reasonCode,
      stage: 'EXPORTED',
      resolvedAt,
    });

    // ---- the database goes only when the payment reconciled and PASSes in both gate reports
    const passes = (r: GateReport) => r.parts.find((p) => p.part === 'payment')?.status === 'PASS';
    const settled = reconciled && passes(fileReport) && passes(dbReport) && passes(fileOnly) && passes(withDatabase);
    await pool.end();
    if (settled && o.dropDatabase !== false) {
      const a = new pg.Pool({ connectionString: admin, max: 1 });
      try {
        await a.query(`DROP DATABASE IF EXISTS "${o.databaseName.replace(/"/g, '')}" WITH (FORCE)`);
        dropped = true;
      } finally {
        await a.end();
      }
    } else o.log(`database kept for review: ${o.databaseName}`);
    const statusOf = (r: GateReport) => Object.fromEntries(r.parts.map((p) => [p.part, p.status]));
    o.log(`resolved ${o.intentId}: ${state}, captured ${captured}, released ${released}${resumed ? ' (resumed)' : ''}`);
    return {
      journeyId: o.journeyId,
      intentState: state,
      capturedMinor: captured,
      releasedMinor: released,
      openReservedMinor: view.money.openReservedMinor,
      evidenceDigest,
      resolvedAt,
      gate: {
        fileOnly: { result: fileOnly.result, parts: statusOf(fileOnly) },
        withDatabase: { result: withDatabase.result, parts: statusOf(withDatabase) },
      },
      databaseDropped: dropped,
      resumed,
      manualReceipts: Number(counts.receipts),
      captureEntries: Number(counts.captures),
    };
  } finally {
    await pool.end().catch(() => {});
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
