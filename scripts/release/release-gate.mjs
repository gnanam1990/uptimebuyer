#!/usr/bin/env node
// T-060 release authority (M14; DELIVERY.md Gate F, EVENT-NOTES submission truth rules). Repository publication, the
// X post, the video upload, a release or tag, a payment, the hackathon submission and a deployment are SEPARATE gates
// (config/release/gates.json). A gate opens only when:
//   1. an authorization record exists for that exact gate (records for another gate never count: the signed payload
//      names the gate, so relabelling a record breaks its signature);
//   2. the record is signed (Ed25519) by a key registered in config/release/authorizers.json - the private keys never
//      enter the repository, so a record cannot be minted by editing files here;
//   3. it is within its validity window and not already used (evidence/authorizations/consumed.json);
//   4. the requested scope matches the authorized scope exactly (a payment may be at most the authorized amount);
//   5. every preflight check of the gate passed.
// Opening a gate records a decision and tells the operator they may perform the action themselves. This script never
// performs an external action: it spawns nothing and makes no network call.
//   node scripts/release/release-gate.mjs status [--json]
//   node scripts/release/release-gate.mjs check <GATE> [--request <file>] [--preflight <file>] [--authorization <id>]
import { createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GATES = Object.freeze([
  'REPO_PUBLICATION',
  'X_POST',
  'VIDEO_UPLOAD',
  'RELEASE_TAG',
  'PAYMENT',
  'HACKATHON_SUBMISSION',
  'DEPLOY',
]);
const SIGNING_DOMAIN = 'uptimebuyer-release-authorization.v1';

export function loadGateConfig(root = repo) {
  const cfg = JSON.parse(readFileSync(path.join(root, 'config', 'release', 'gates.json'), 'utf8'));
  for (const g of GATES)
    if (!cfg.gates?.[g] || !Array.isArray(cfg.gates[g].scope) || !Array.isArray(cfg.gates[g].preflight))
      throw new Error(`gate ${g} is not configured`);
  return cfg;
}

export function loadAuthorizers(root = repo) {
  const f = path.join(root, 'config', 'release', 'authorizers.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')).authorizers ?? {}) : {};
}

export function loadAuthorizations(root = repo) {
  const dir = path.join(root, 'evidence', 'authorizations');
  if (!existsSync(dir)) return { records: [], consumed: new Set() };
  const records = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'consumed.json')
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
  const c = path.join(dir, 'consumed.json');
  const consumed = new Set(existsSync(c) ? (JSON.parse(readFileSync(c, 'utf8')).consumed ?? []) : []);
  return { records, consumed };
}

/** Canonical JSON (sorted keys, no whitespace) so a signature binds every field. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** The exact bytes an authorizer signs: every field of the record except the signature itself. */
export function signingInput(record) {
  const { signature: _signature, ...body } = record;
  return Buffer.from(`${SIGNING_DOMAIN}\n${canonical(body)}`, 'utf8');
}

/** Offline helper for the authorizer's own machine (and tests): attach an Ed25519 signature to a record. */
export function signAuthorization(record, privateKey, keyId) {
  const value = sign(null, signingInput(record), privateKey).toString('base64url');
  return { ...record, signature: { algorithm: 'ED25519', keyId, value } };
}

function signatureReasons(record, authorizers) {
  const sig = record.signature;
  if (!sig || sig.algorithm !== 'ED25519' || typeof sig.keyId !== 'string' || typeof sig.value !== 'string')
    return ['SIGNATURE_MISSING'];
  if (!Object.hasOwn(authorizers, sig.keyId)) return ['AUTHORIZER_UNKNOWN'];
  try {
    const key = createPublicKey({ key: Buffer.from(authorizers[sig.keyId], 'base64url'), format: 'der', type: 'spki' });
    return verify(null, signingInput(record), key, Buffer.from(sig.value, 'base64url')) ? [] : ['SIGNATURE_INVALID'];
  } catch {
    return ['SIGNATURE_INVALID'];
  }
}

const same = (a, b) => canonical(a) === canonical(b);

function scopeReasons(gateCfg, authorized, requested) {
  const reasons = [];
  for (const field of gateCfg.scope) {
    const a = authorized?.[field];
    const r = requested?.[field];
    if (a === undefined || r === undefined) {
      reasons.push(`SCOPE_MISMATCH:${field}`);
      continue;
    }
    if ((gateCfg.capFields ?? []).includes(field)) {
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(r) || r < 0 || r > a)
        reasons.push(`SCOPE_MISMATCH:${field}`);
    } else if (!same(a, r)) reasons.push(`SCOPE_MISMATCH:${field}`);
  }
  return reasons;
}

/**
 * Decide one gate. ctx: { authorizations, authorizers, consumed, now, preflight, authorizationId?, config? }.
 * Returns { gate, decision: 'AUTHORIZED' | 'REFUSED', reasons, authorizationId }.
 */
export function evaluateGate(gate, request, ctx) {
  const config = ctx.config ?? loadGateConfig(repo);
  if (!GATES.includes(gate)) return { gate, decision: 'REFUSED', reasons: ['UNKNOWN_GATE'], authorizationId: null };
  const gateCfg = config.gates[gate];
  const all = Array.isArray(ctx.authorizations) ? ctx.authorizations : [];
  if (ctx.authorizationId) {
    const named = all.find((r) => r?.authorizationId === ctx.authorizationId);
    if (named && named.gate !== gate)
      return {
        gate,
        decision: 'REFUSED',
        reasons: ['AUTHORIZATION_FOR_OTHER_GATE'],
        authorizationId: ctx.authorizationId,
      };
  }
  const candidates = all.filter(
    (r) => r?.gate === gate && (!ctx.authorizationId || r.authorizationId === ctx.authorizationId),
  );
  if (candidates.length === 0)
    return { gate, decision: 'REFUSED', reasons: ['NO_AUTHORIZATION'], authorizationId: null };
  const now = (ctx.now ?? new Date()).getTime();
  let best = null;
  for (const record of candidates) {
    const reasons = [];
    if (record.schema !== 'release-authorization.v1') reasons.push('SCHEMA_INVALID');
    reasons.push(...signatureReasons(record, ctx.authorizers ?? {}));
    const from = Date.parse(record.authorizedAt);
    const to = Date.parse(record.expiresAt);
    if (!Number.isFinite(from) || !Number.isFinite(to)) reasons.push('VALIDITY_INVALID');
    else {
      if (now < from) reasons.push('AUTHORIZATION_NOT_YET_VALID');
      if (now > to) reasons.push('AUTHORIZATION_EXPIRED');
    }
    if (ctx.consumed?.has(record.authorizationId)) reasons.push('AUTHORIZATION_ALREADY_USED');
    if (typeof record.statement !== 'string' || record.statement.length < 10) reasons.push('STATEMENT_MISSING');
    reasons.push(...scopeReasons(gateCfg, record.scope, request));
    for (const check of gateCfg.preflight)
      if (ctx.preflight?.[check] !== true) reasons.push(`PREFLIGHT_FAILED:${check}`);
    if (!best || reasons.length < best.reasons.length) best = { record, reasons };
    if (reasons.length === 0) break;
  }
  return {
    gate,
    decision: best.reasons.length === 0 ? 'AUTHORIZED' : 'REFUSED',
    reasons: best.reasons,
    authorizationId: best.record.authorizationId ?? null,
  };
}

/** True only for a signed, unexpired, unused record of exactly this gate (used by the journey gate for PAYMENT). */
export function authorizationVerifies(root, gate, authorizationId, now = new Date()) {
  const { records, consumed } = loadAuthorizations(root);
  const record = records.find((r) => r?.authorizationId === authorizationId);
  if (!record || record.gate !== gate) return false;
  if (signatureReasons(record, loadAuthorizers(root)).length) return false;
  const t = now.getTime();
  return Date.parse(record.authorizedAt) <= t && t <= Date.parse(record.expiresAt) && !consumed.has(authorizationId);
}

/** The repository's current decision for every gate (no request, no preflight). */
export function gateStatus(root = repo, now = new Date()) {
  const config = loadGateConfig(root);
  const { records, consumed } = loadAuthorizations(root);
  const authorizers = loadAuthorizers(root);
  return {
    schema: 'release-gate-status.v1',
    evaluatedAt: now.toISOString(),
    authorizers: Object.keys(authorizers),
    gates: GATES.map((gate) => ({
      ...evaluateGate(gate, {}, { authorizations: records, authorizers, consumed, now, preflight: {}, config }),
      action: config.gates[gate].action,
    })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, gate] = process.argv.slice(2);
  const args = process.argv.slice(2);
  const val = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const readJson = (f) => (f ? JSON.parse(readFileSync(f, 'utf8')) : {});
  if (cmd === 'status') {
    const s = gateStatus(repo);
    if (args.includes('--json')) console.log(JSON.stringify(s, null, 2));
    else {
      console.log('| Gate | Decision | Reasons |\n|---|---|---|');
      for (const g of s.gates) console.log(`| ${g.gate} | ${g.decision} | ${g.reasons.join(', ')} |`);
    }
  } else if (cmd === 'check' && gate) {
    const { records, consumed } = loadAuthorizations(repo);
    const d = evaluateGate(gate, readJson(val('--request')), {
      authorizations: records,
      authorizers: loadAuthorizers(repo),
      consumed,
      now: new Date(),
      preflight: readJson(val('--preflight')),
      ...(val('--authorization') ? { authorizationId: val('--authorization') } : {}),
    });
    console.log(JSON.stringify(d, null, 2));
    if (d.decision === 'AUTHORIZED')
      console.log(`AUTHORIZED: the operator may now perform "${loadGateConfig(repo).gates[gate].action}" themselves.`);
    process.exitCode = d.decision === 'AUTHORIZED' ? 0 : 3;
  } else {
    console.error(
      'usage: release-gate.mjs status [--json] | check <GATE> [--request f] [--preflight f] [--authorization id]',
    );
    process.exitCode = 2;
  }
}
