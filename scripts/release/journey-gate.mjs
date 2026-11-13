#!/usr/bin/env node
// T-058 real-input recovery journey gate (M14; FR-22, INV-12, DEMO-VALIDATION.md). The journey needs, in ONE source-bound
// run: a real authenticated sensor, a real document, a real SERV Reasoning (OpenServ) execution, a bounded real
// Kite-paid action under a recorded PAYMENT authorization, downstream fulfillment, independent recovery evidence, a
// duplicate request that returns the existing intent, and an injected timeout that becomes UNKNOWN and reconciles
// before any retry. Each part is classified PASS, FAIL, NOT_RUN, UNKNOWN or UNSUPPORTED:
//   NOT_RUN      no evidence supplied for the part;
//   UNSUPPORTED  the part was declared unsupported with a reason code;
//   FAIL         evidence of a non-real origin (simulator, replay, fixture, demo, recorded contract, contract fake,
//                local stand-in, seeded test data), a known simulated artifact, a tampered or out-of-root artifact,
//                evidence from another run or outside the run window, a missing authorization, a contradicting
//                database origin, or a required fact not shown;
//   UNKNOWN      an artifact is missing or an outcome is still ambiguous (unreconciled);
//   PASS         genuine, artifact-backed, in-window, source-bound evidence with every required fact.
// The journey PASSes only when every part does. The database cross-check (collectDatabaseFacts) can only REFUSE what
// the database itself labels non-real; it never proves realness. This script reads files and the database; it performs
// no external action.
//   node scripts/release/journey-gate.mjs [--manifest <file>] [--json] [--database --tenant <id> --incident <id>]
// With --database the URL is read from JOURNEY_DATABASE_URL (never argv, which other users can read).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rg from './release-gate.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const JOURNEY_PARTS = Object.freeze([
  'sensor',
  'document',
  'reasoning',
  'payment',
  'fulfillment',
  'recovery',
  'duplicate',
  'timeout',
]);
/** The only origin each part may carry to count as real-input evidence. */
export const REAL_ORIGINS = Object.freeze({
  sensor: 'PHYSICAL_SENSOR',
  document: 'PUBLISHED_DOCUMENT',
  reasoning: 'SERV_REASONING',
  payment: 'KITE_PASSPORT',
  fulfillment: 'PROVIDER_LIVE',
  recovery: 'PHYSICAL_SENSOR_AND_AUTHORITATIVE_SIGNOFF',
  duplicate: 'KITE_PASSPORT',
  timeout: 'KITE_PASSPORT',
});
export const NON_REAL_ORIGINS = Object.freeze([
  'SIMULATOR',
  'SIMULATED_INPUT',
  'REPLAY',
  'FIXTURE',
  'DEMO',
  'RECORDED_CONTRACT',
  'CONTRACT_FAKE',
  'LOCAL_STAND_IN',
  'SEEDED_TEST_DATA',
  'TEST',
  'MOCK',
  'OPERATOR_REPORT',
  'ABSENT',
]);
const SEVERITY = { PASS: 0, UNSUPPORTED: 1, NOT_RUN: 2, UNKNOWN: 3, FAIL: 4 };
const worst = (statuses) => statuses.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'PASS');
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Facts each part must show (beyond origin and artifacts). Return a reason when a fact is missing. */
function factReasons(part, p, ctx) {
  const f = p.facts ?? {};
  const r = [];
  switch (part) {
    case 'sensor':
      if (f.authenticated !== true) r.push('FACT_MISSING:authenticated');
      break;
    case 'reasoning':
      if (typeof f.runId !== 'string' || !f.runId) r.push('FACT_MISSING:runId');
      // A real call is not reasoning evidence on its own: the run must have COMPLETED and its validated proposal must
      // be stored. A REJECTED or FAILED run is recorded as what it is, never as a pass.
      if (f.runStatus !== 'COMPLETED') r.push(`REASONING_NOT_COMPLETED:${String(f.runStatus ?? 'ABSENT')}`);
      if (typeof f.proposalId !== 'string' || !f.proposalId.trim()) r.push('FACT_MISSING:proposalId');
      break;
    case 'payment': {
      // The cap is the signed authorization's scope (merchant, amount, currency, purpose, environment), checked by the
      // release-gate tooling; the manifest's own cap is only a consistency check.
      const window = { journeyId: ctx.journeyId, startedAt: ctx.startedAt, endedAt: ctx.endedAt };
      if (
        typeof p.authorizationId !== 'string' ||
        !ctx.isAuthorized?.('PAYMENT', p.authorizationId, f.request ?? f, window)
      )
        r.push('PAYMENT_NOT_AUTHORIZED');
      if (!Number.isSafeInteger(f.amountMinor) || !Number.isSafeInteger(f.capMinor) || f.amountMinor > f.capMinor)
        r.push('PAYMENT_OVER_CAP');
      // The boundary is the authorized request (the one the PAYMENT decision was bound to), never the manifest's own
      // capMinor: the recorded amount may not exceed it and currency, merchant and purpose must be the authorized ones.
      const req = f.request;
      if (!req || typeof req !== 'object') r.push('PAYMENT_REQUEST_MISSING');
      else {
        if (
          !Number.isSafeInteger(f.amountMinor) ||
          !Number.isSafeInteger(req.amountMinor) ||
          f.amountMinor > req.amountMinor
        )
          r.push('PAYMENT_OVER_AUTHORIZED');
        for (const k of ['currency', 'merchant', 'purpose'])
          if (typeof f[k] !== 'string' || f[k] !== req[k]) r.push(`PAYMENT_OUTSIDE_AUTHORIZATION:${k}`);
      }
      break;
    }
    case 'recovery':
      if (f.evaluation !== 'PASSED' || f.independentEvidence !== true) r.push('FACT_MISSING:independentEvidence');
      break;
    case 'duplicate':
      if (f.sameIntentReturned !== true) r.push('FACT_MISSING:sameIntentReturned');
      break;
    case 'timeout':
      if (f.injectedTimeout !== true || f.stateAfterTimeout !== 'UNKNOWN' || f.reconciledBeforeRetry !== true)
        r.push('FACT_MISSING:reconciledBeforeRetry');
      break;
  }
  return r;
}

function artifactReasons(p, ctx, journeyId) {
  const list = Array.isArray(p.artifacts) ? p.artifacts : [];
  if (list.length === 0) return { fail: [], unknown: ['NO_ARTIFACT'] };
  const fail = [];
  const unknown = [];
  const root = path.resolve(ctx.artifactRoot);
  const evidenceRoot = path.join(root, 'evidence');
  for (const a of list) {
    if (!a || typeof a.path !== 'string' || typeof a.sha256 !== 'string' || !HEX64.test(a.sha256)) {
      fail.push('ARTIFACT_INVALID');
      continue;
    }
    const full = path.resolve(root, a.path);
    if (!full.startsWith(`${evidenceRoot}${path.sep}`)) {
      fail.push('ARTIFACT_OUTSIDE_EVIDENCE_ROOT');
      continue;
    }
    // Artifacts are bound to their own run's directory (M14 security review R3): evidence of another journey cannot be
    // borrowed.
    const own = path.join(evidenceRoot, 'journeys', String(journeyId));
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(journeyId)) || !full.startsWith(`${own}${path.sep}`)) {
      fail.push('ARTIFACT_FROM_OTHER_JOURNEY');
      continue;
    }
    if (ctx.simulatedDigests?.has(a.sha256)) fail.push('KNOWN_SIMULATED_ARTIFACT');
    if (!existsSync(full) || !statSync(full).isFile()) {
      unknown.push('ARTIFACT_MISSING');
      continue;
    }
    const digest = sha256(readFileSync(full));
    if (digest !== a.sha256) fail.push('ARTIFACT_DIGEST_MISMATCH');
    else if (ctx.simulatedDigests?.has(digest) && !fail.includes('KNOWN_SIMULATED_ARTIFACT'))
      fail.push('KNOWN_SIMULATED_ARTIFACT');
  }
  return { fail, unknown };
}

/**
 * The reasoning facts must agree with the recorded reasoning artifact itself (M14 review): a valid hash alone cannot turn
 * a REJECTED run into a pass. One artifact must be a reasoning record whose run id, status, stored proposal and adapter
 * match the manifest facts.
 */
function reasoningRecordReasons(p, ctx, journeyId) {
  const f = p.facts ?? {};
  const own = path.join(path.resolve(ctx.artifactRoot), 'evidence', 'journeys', String(journeyId));
  const records = [];
  for (const a of Array.isArray(p.artifacts) ? p.artifacts : []) {
    if (!a || typeof a.path !== 'string' || !a.path.endsWith('.json')) continue;
    const full = path.resolve(ctx.artifactRoot, a.path);
    if (!full.startsWith(`${own}${path.sep}`) || !existsSync(full)) continue;
    try {
      const doc = JSON.parse(readFileSync(full, 'utf8'));
      if (doc && typeof doc === 'object' && typeof doc.reasoningRunId === 'string') records.push(doc);
    } catch {
      // not a JSON reasoning record
    }
  }
  if (records.length !== 1) return [records.length === 0 ? 'REASONING_RECORD_MISSING' : 'REASONING_RECORD_AMBIGUOUS'];
  const rec = records[0];
  const r = [];
  if (rec.reasoningRunId !== f.runId) r.push('REASONING_RECORD_MISMATCH:runId');
  if (rec.status !== f.runStatus) r.push('REASONING_RECORD_MISMATCH:status');
  if ((rec.proposal?.proposalId ?? null) !== (f.proposalId ?? null)) r.push('REASONING_RECORD_MISMATCH:proposalId');
  if (rec.adapter !== 'SERV_REASONING') r.push('REASONING_RECORD_MISMATCH:adapter');
  return r;
}

/**
 * A payment resolved after its run (INV-08): a finance approver's manual resolution of an UNKNOWN outcome, recorded with
 * a `resolution` section. These rules only add refusals to the ones every part already meets: the resolution is the
 * work of this manifest's sourceSha (HEAD), inside the window and after the run's payment, cites an evidence file by
 * digest that the payment part lists, keeps the run's own manifest (same journey, start, authorization and intent, the
 * payment UNKNOWN there, run under runSourceSha), captures exactly the recorded amount, and is repeated in the payment
 * facts. With the database, the product's own manual-resolution receipt for that intent must carry exactly that digest,
 * and a manually resolved intent recorded without a resolution section is refused.
 */
function resolutionReasons(manifest, p, ctx) {
  const r = [];
  const res = manifest.resolution;
  const fres = p.facts?.resolution;
  const manual = ctx.databaseFacts?.payment?.manual;
  if (!res) {
    if (fres !== undefined) r.push('RESOLUTION_UNDECLARED');
    if (Array.isArray(manual) && manual.some((m) => m?.intentId === p.facts?.intentId))
      r.push('DATABASE_RESOLUTION_UNDECLARED');
    return r;
  }
  const own = path.join(path.resolve(ctx.artifactRoot), 'evidence', 'journeys', String(manifest.journeyId));
  const readOwn = (a) => {
    if (!a || typeof a.path !== 'string' || typeof a.sha256 !== 'string' || !HEX64.test(a.sha256)) return null;
    const full = path.resolve(ctx.artifactRoot, a.path);
    if (!full.startsWith(`${own}${path.sep}`) || !existsSync(full) || !statSync(full).isFile()) return null;
    const bytes = readFileSync(full);
    return sha256(bytes) === a.sha256 ? bytes : null;
  };
  if (res.kind !== 'MANUAL_FINANCE_RESOLUTION' || res.resolution !== 'CAPTURED') r.push('RESOLUTION_FACTS_MISMATCH');
  if (res.sourceSha !== manifest.sourceSha) r.push('RESOLUTION_SOURCE_SHA_MISMATCH');
  const at = Date.parse(res.resolvedAt);
  if (!Number.isFinite(at) || at < Date.parse(manifest.startedAt) || at > Date.parse(manifest.endedAt))
    r.push('RESOLUTION_OUTSIDE_WINDOW');
  // The evidence the finance approver cited: an own-journey file whose digest is the cited one, listed by the part.
  const evidence = readOwn(res.evidence);
  if (!evidence || res.evidenceDigest !== `sha256:${sha256(evidence)}`) r.push('RESOLUTION_EVIDENCE_MISMATCH');
  if (!(p.artifacts ?? []).some((a) => a?.path === res.evidence?.path && a?.sha256 === res.evidence?.sha256))
    r.push('RESOLUTION_EVIDENCE_NOT_CITED');
  // The run's own manifest, unchanged.
  const runBytes = readOwn(res.runManifest);
  const run = (() => {
    try {
      return runBytes ? JSON.parse(runBytes.toString('utf8')) : null;
    } catch {
      return null;
    }
  })();
  const runPay = run?.parts?.payment;
  if (
    !run ||
    run.journeyId !== manifest.journeyId ||
    run.startedAt !== manifest.startedAt ||
    run.resolution !== undefined ||
    !runPay ||
    runPay.authorizationId !== p.authorizationId ||
    runPay.facts?.intentId === undefined ||
    runPay.facts.intentId !== p.facts?.intentId ||
    res.intentId !== p.facts?.intentId
  )
    r.push('RESOLUTION_RUN_MANIFEST_MISMATCH');
  else {
    if (runPay.facts.state !== 'UNKNOWN') r.push('RESOLUTION_RUN_NOT_UNKNOWN');
    if (!HEX40.test(String(manifest.runSourceSha)) || run.sourceSha !== manifest.runSourceSha)
      r.push('RESOLUTION_RUN_SOURCE_SHA_MISMATCH');
    if (Number.isFinite(at) && at < Date.parse(runPay.capturedAt)) r.push('RESOLUTION_OUTSIDE_WINDOW');
  }
  if (!Number.isSafeInteger(res.capturedMinor) || res.capturedMinor !== p.facts?.amountMinor)
    r.push('RESOLUTION_AMOUNT_MISMATCH');
  if (
    !fres ||
    fres.kind !== res.kind ||
    fres.resolution !== res.resolution ||
    fres.evidenceDigest !== res.evidenceDigest ||
    fres.resolvedAt !== res.resolvedAt
  )
    r.push('RESOLUTION_FACTS_MISMATCH');
  if (Array.isArray(manual)) {
    const mine = manual.filter((m) => m?.intentId === res.intentId);
    if (mine.length === 0) r.push('DATABASE_RESOLUTION_MISSING');
    else if (!mine.some((m) => m.evidenceDigest === res.evidenceDigest && m.kind === 'PAYMENT_SETTLEMENT'))
      r.push('DATABASE_RESOLUTION_MISMATCH');
  }
  return r;
}

function classifyPart(part, manifest, ctx) {
  const p = manifest?.parts?.[part];
  if (!p || typeof p !== 'object') return { part, status: 'NOT_RUN', reasons: ['NOT_PROVIDED'] };
  if (p.status === 'UNSUPPORTED')
    return {
      part,
      status: 'UNSUPPORTED',
      reasons: [typeof p.reasonCode === 'string' ? p.reasonCode : 'UNSUPPORTED_WITHOUT_REASON'],
    };
  const fail = [];
  const unknown = [];
  if (typeof p.origin !== 'string') fail.push('ORIGIN_MISSING');
  else if (NON_REAL_ORIGINS.includes(p.origin)) fail.push(`NON_REAL_ORIGIN:${p.origin}`);
  else if (p.origin !== REAL_ORIGINS[part]) fail.push(`ORIGIN_NOT_REAL:${p.origin}`);
  if (p.replayOf !== undefined || p.replayed === true) fail.push('REPLAYED_EVIDENCE');
  if (p.journeyId !== undefined && p.journeyId !== manifest.journeyId) fail.push('PART_FROM_DIFFERENT_RUN');
  const t = Date.parse(p.capturedAt);
  const start = Date.parse(manifest.startedAt);
  const end = Date.parse(manifest.endedAt);
  if (!Number.isFinite(t) || !Number.isFinite(start) || !Number.isFinite(end) || t < start || t > end)
    fail.push('OUTSIDE_JOURNEY_WINDOW');
  if (manifest.sourceSha !== ctx.expectedSha) fail.push('SOURCE_SHA_MISMATCH');
  const db = ctx.databaseFacts?.[part];
  if (db && db.real !== true) fail.push(`DATABASE_ORIGIN:${db.origin}`);
  const art = artifactReasons(p, ctx, manifest.journeyId);
  fail.push(...art.fail);
  unknown.push(...art.unknown);
  const facts = factReasons(part, p, {
    ...ctx,
    journeyId: manifest.journeyId,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
  });
  // A missing artifact is UNKNOWN (above); the record is compared only once every listed artifact is present.
  if (part === 'reasoning' && art.unknown.length === 0)
    facts.push(...reasoningRecordReasons(p, ctx, manifest.journeyId));
  if (part === 'payment') facts.push(...resolutionReasons(manifest, p, ctx));
  // An ambiguous outcome is UNKNOWN until reconciled; other missing facts fail the part.
  if (part === 'payment' && (p.facts?.state === 'UNKNOWN' || p.facts?.reconciled !== true))
    unknown.push('OUTCOME_UNRECONCILED');
  else if (part === 'payment' && p.facts?.state !== 'CONFIRMED') fail.push('PAYMENT_NOT_CONFIRMED');
  fail.push(...facts);
  if (fail.length) return { part, status: 'FAIL', reasons: [...fail, ...unknown] };
  if (unknown.length) return { part, status: 'UNKNOWN', reasons: unknown };
  return { part, status: 'PASS', reasons: [] };
}

/** Evaluate a journey manifest (or null) into per-part statuses and one result. */
export function evaluateJourney(manifest, ctx) {
  const parts = JOURNEY_PARTS.map((part) => classifyPart(part, manifest, ctx));
  return {
    schema: 'journey-gate-result.v1',
    journeyId: manifest?.journeyId ?? null,
    sourceSha: manifest?.sourceSha ?? null,
    result: worst(parts.map((p) => p.status)),
    parts,
  };
}

/**
 * A PAYMENT authorization covers this journey's payment when the request names this journey and either (a) the record
 * verifies now and is unused (release-gate authorizationVerifies), or (b) it was consumed by the one AUTHORIZED decision
 * the release gate recorded for exactly this request (canonical digest), made inside the journey window. A decision for
 * another journey, request or time never counts.
 */
export function paymentAuthorized(root, authorizationId, request, { journeyId, startedAt, endedAt, now = new Date() }) {
  if (!request || typeof request !== 'object' || request.journeyId !== journeyId) return false;
  if (rg.authorizationVerifies(root, 'PAYMENT', authorizationId, now, request)) return true;
  const d = rg.authorizationDecidedFor(root, 'PAYMENT', authorizationId, request);
  if (!d.ok) return false;
  const t = Date.parse(d.decidedAt);
  return Date.parse(startedAt) <= t && t <= Date.parse(endedAt);
}

/**
 * Evidence of a COMPLETED payment counts only with the consumed, request-bound decision: the one AUTHORIZED decision the
 * release gate recorded for exactly this request (canonical digest, which includes the journey id), whose recorded
 * journey id is this journey and whose time falls inside the journey window. An unconsumed record proves nothing
 * happened under it, so it never counts here (PR #21 review 10). The journey id is bound in the decision record, not in
 * the signed scope, because the authorization is signed before a run (and its id) exists and single use already ties
 * one record to one decision.
 */
export function paymentEvidenceAuthorized(root, authorizationId, request, { journeyId, startedAt, endedAt }) {
  if (!request || typeof request !== 'object' || request.journeyId !== journeyId) return false;
  const d = rg.authorizationDecidedFor(root, 'PAYMENT', authorizationId, request);
  if (!d.ok || d.journeyId !== journeyId) return false;
  const t = Date.parse(d.decidedAt);
  return Date.parse(startedAt) <= t && t <= Date.parse(endedAt);
}

/** The journey gate's payment authorizer over a repository root (the CLI's). */
export function evidenceAuthorizer(root, now = () => new Date()) {
  return (gate, id, request, window) =>
    gate === 'PAYMENT' && paymentEvidenceAuthorized(root, id, request, { ...window, now: now() });
}

/** Digests of every artifact the local simulated demo produced (docs/release/demo/simulated-artifacts.json). */
export function loadSimulatedDigests(root = repo) {
  const file = path.join(root, 'docs', 'release', 'demo', 'simulated-artifacts.json');
  if (!existsSync(file)) return new Set();
  const reg = JSON.parse(readFileSync(file, 'utf8'));
  return new Set((reg.artifacts ?? []).map((a) => a.sha256).filter((d) => HEX64.test(d)));
}

/** HEAD commit read from .git without spawning git. */
export function headSha(root = repo) {
  try {
    let gitDir = path.join(root, '.git');
    if (statSync(gitDir).isFile())
      gitDir = path.resolve(
        root,
        readFileSync(gitDir, 'utf8')
          .replace(/^gitdir:\s*/, '')
          .trim(),
      );
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = head.replace(/^ref:\s*/, '');
    const common = existsSync(path.join(gitDir, 'commondir'))
      ? path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim())
      : gitDir;
    for (const dir of [gitDir, common]) {
      const f = path.join(dir, ref);
      if (existsSync(f)) return readFileSync(f, 'utf8').trim();
    }
    const packed = path.join(common, 'packed-refs');
    if (existsSync(packed))
      for (const line of readFileSync(packed, 'utf8').split('\n')) {
        const [sha, name] = line.trim().split(' ');
        if (name === ref) return sha;
      }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Database cross-check for one incident: the origin the database itself records for the sensor trigger and the
 * recovery-window samples, the reasoning runs, the broker attempts and the recovery close-out (with any CMMS write
 * made by a contract-fake adapter). An unknown incident (or one of another tenant) reads as ABSENT for every part.
 */
export async function collectDatabaseFacts(pool, { tenantId, incidentId, reasoningRunId, proposalId }) {
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const absent = { origin: 'ABSENT', real: false };
  const inc = (
    await q(`SELECT trigger_input_origin FROM incidents WHERE tenant_id = $1 AND id = $2`, [tenantId, incidentId])
  )[0];
  if (!inc) return { sensor: absent, reasoning: absent, payment: absent, recovery: absent };
  const samples = (
    await q(
      `SELECT DISTINCT s.input_origin FROM recovery_evaluations e
         JOIN recovery_evaluation_samples rs ON rs.tenant_id = e.tenant_id AND rs.evaluation_id = e.id
         JOIN telemetry_samples s ON s.tenant_id = rs.tenant_id AND s.id = rs.sample_id
        WHERE e.tenant_id = $1 AND e.incident_id = $2`,
      [tenantId, incidentId],
    )
  ).map((r) => r.input_origin);
  const sensorOrigins = [inc.trigger_input_origin, ...samples];
  const nonPhysical = sensorOrigins.find((o) => o !== 'PHYSICAL_SENSOR');
  const sensor = { origin: nonPhysical ?? 'PHYSICAL_SENSOR', real: !nonPhysical };
  const adapters = (
    await q(`SELECT DISTINCT adapter FROM reasoning_runs WHERE tenant_id = $1 AND incident_id = $2`, [
      tenantId,
      incidentId,
    ])
  ).map((r) => r.adapter);
  // A SERV run counts only when it COMPLETED and its validated proposal is stored; a REJECTED or FAILED run is refused.
  // Bound to the run and proposal the manifest reports (M14 review): another completed run on the incident cannot vouch
  // for a fabricated or rejected one. Without both ids nothing is counted.
  const bound = typeof reasoningRunId === 'string' && reasoningRunId && typeof proposalId === 'string' && proposalId;
  const completed = bound
    ? (
        await q(
          `SELECT count(*)::int AS n FROM reasoning_runs r
             JOIN reasoning_proposals p ON p.tenant_id = r.tenant_id AND p.reasoning_run_id = r.id
            WHERE r.tenant_id = $1 AND r.incident_id = $2 AND r.adapter = 'SERV_REASONING' AND r.status = 'COMPLETED'
              AND r.id = $3 AND p.id = $4`,
          [tenantId, incidentId, reasoningRunId, proposalId],
        )
      )[0]?.n
    : 0;
  const reasoning =
    adapters.length === 0
      ? absent
      : adapters.some((a) => a !== 'SERV_REASONING')
        ? { origin: adapters.find((a) => a !== 'SERV_REASONING'), real: false }
        : completed > 0
          ? { origin: 'SERV_REASONING', real: true }
          : { origin: 'SERV_REASONING_NOT_COMPLETED', real: false };
  const origins = (
    await q(
      `SELECT DISTINCT a.result_origin FROM external_attempts a
         JOIN commercial_intents i ON i.tenant_id = a.tenant_id AND i.id = a.intent_id
        WHERE a.tenant_id = $1 AND i.incident_id = $2`,
      [tenantId, incidentId],
    )
  ).map((r) => r.result_origin);
  // Manual resolutions the product recorded (commerce resolveUnknownIntentManually): receipts with a manual_ status
  // whose raw digest is the finance approver's evidence digest.
  const manual = (
    await q(
      `SELECT r.intent_id, r.kind, r.raw_response_digest FROM external_receipts r
         JOIN commercial_intents i ON i.tenant_id = r.tenant_id AND i.id = r.intent_id
        WHERE r.tenant_id = $1 AND i.incident_id = $2 AND r.provider_status LIKE 'manual\\_%'`,
      [tenantId, incidentId],
    )
  ).map((m) => ({ intentId: m.intent_id, kind: m.kind, evidenceDigest: m.raw_response_digest }));
  const payment =
    origins.length === 0
      ? { ...absent, manual }
      : {
          origin: origins.find((o) => o !== 'KITE_PASSPORT') ?? 'KITE_PASSPORT',
          real: origins.every((o) => o === 'KITE_PASSPORT'),
          manual,
        };
  const closeouts = (
    await q(`SELECT count(*)::int AS n FROM recovery_closeouts WHERE tenant_id = $1 AND incident_id = $2`, [
      tenantId,
      incidentId,
    ])
  )[0].n;
  const fakeCmms = (
    await q(
      `SELECT count(*)::int AS n FROM cmms_write_attempts a
         JOIN cmms_work_order_updates u ON u.tenant_id = a.tenant_id AND u.id = a.update_id
        WHERE a.tenant_id = $1 AND u.incident_id = $2 AND a.adapter_label = 'CONTRACT_FAKE'`,
      [tenantId, incidentId],
    )
  )[0].n;
  let recovery;
  if (closeouts === 0) recovery = absent;
  else if (!sensor.real) recovery = { origin: sensor.origin, real: false };
  else if (fakeCmms > 0) recovery = { origin: 'CONTRACT_FAKE', real: false };
  else recovery = { origin: 'PHYSICAL_SENSOR_AND_AUTHORITATIVE_SIGNOFF', real: true };
  return { sensor, reasoning, payment, recovery };
}

function findManifests(root) {
  const dir = path.join(root, 'evidence', 'journeys');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.journey.json'))
    .map((f) => path.join(dir, f));
}

function render(r) {
  const lines = [`journey ${r.journeyId ?? '(none)'}: ${r.result}`, '| Part | Status | Reasons |', '|---|---|---|'];
  for (const p of r.parts) lines.push(`| ${p.part} | ${p.status} | ${p.reasons.join(', ') || '-'} |`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const manifestFile = val('--manifest') ?? findManifests(repo)[0];
  const manifest = manifestFile ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null;
  if (args.includes('--database-url')) {
    console.error('refusing a database URL on argv; set JOURNEY_DATABASE_URL and pass --database');
    process.exit(2);
  }
  let databaseFacts;
  if (args.includes('--database')) {
    if (!process.env.JOURNEY_DATABASE_URL) {
      console.error('JOURNEY_DATABASE_URL is required with --database');
      process.exit(2);
    }
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: process.env.JOURNEY_DATABASE_URL, max: 2 });
    try {
      databaseFacts = await collectDatabaseFacts(pool, {
        tenantId: val('--tenant'),
        incidentId: val('--incident'),
        reasoningRunId: manifest?.parts?.reasoning?.facts?.runId,
        proposalId: manifest?.parts?.reasoning?.facts?.proposalId,
      });
    } finally {
      await pool.end();
    }
  }
  // The authorization registry is scripts/release/release-gate.mjs's; with no registered authorizer no PAYMENT
  // authorization can verify.
  const isAuthorized = evidenceAuthorizer(repo);
  const r = evaluateJourney(manifest, {
    artifactRoot: repo,
    expectedSha: headSha(repo),
    simulatedDigests: loadSimulatedDigests(repo),
    isAuthorized,
    ...(databaseFacts ? { databaseFacts } : {}),
  });
  console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
  process.exitCode = r.result === 'PASS' ? 0 : 2;
}
