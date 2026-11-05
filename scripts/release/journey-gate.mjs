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
//   node scripts/release/journey-gate.mjs [--manifest <file>] [--json] [--database-url <url> --tenant <id> --incident <id>]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
      break;
    case 'payment': {
      if (typeof p.authorizationId !== 'string' || !ctx.isAuthorized?.('PAYMENT', p.authorizationId))
        r.push('PAYMENT_NOT_AUTHORIZED');
      if (!Number.isSafeInteger(f.amountMinor) || !Number.isSafeInteger(f.capMinor) || f.amountMinor > f.capMinor)
        r.push('PAYMENT_OVER_CAP');
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

function artifactReasons(p, ctx) {
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
  const art = artifactReasons(p, ctx);
  fail.push(...art.fail);
  unknown.push(...art.unknown);
  const facts = factReasons(part, p, ctx);
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
export async function collectDatabaseFacts(pool, { tenantId, incidentId }) {
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
  const reasoning =
    adapters.length === 0
      ? absent
      : {
          origin: adapters.find((a) => a !== 'SERV_REASONING') ?? 'SERV_REASONING',
          real: adapters.every((a) => a === 'SERV_REASONING'),
        };
  const origins = (
    await q(
      `SELECT DISTINCT a.result_origin FROM external_attempts a
         JOIN commercial_intents i ON i.tenant_id = a.tenant_id AND i.id = a.intent_id
        WHERE a.tenant_id = $1 AND i.incident_id = $2`,
      [tenantId, incidentId],
    )
  ).map((r) => r.result_origin);
  const payment =
    origins.length === 0
      ? absent
      : {
          origin: origins.find((o) => o !== 'KITE_PASSPORT') ?? 'KITE_PASSPORT',
          real: origins.every((o) => o === 'KITE_PASSPORT'),
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
  let databaseFacts;
  if (val('--database-url')) {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: val('--database-url'), max: 2 });
    try {
      databaseFacts = await collectDatabaseFacts(pool, { tenantId: val('--tenant'), incidentId: val('--incident') });
    } finally {
      await pool.end();
    }
  }
  // No authorization registry is consulted for payments here: scripts/release/release-gate.mjs owns it, and with no
  // registered authorizer no PAYMENT authorization can verify.
  const rg = await import('./release-gate.mjs');
  const isAuthorized = (gate, id) => rg.authorizationVerifies(repo, gate, id);
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
