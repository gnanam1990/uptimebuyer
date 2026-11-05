// T-060 (M14) release authority. Repository publication, the X post, the video upload, a release or tag, a payment,
// the hackathon submission and a deployment are SEPARATE gates. Each refuses unless an explicit authorization record
// for that exact gate exists, is signed by a registered authorizer key, is unexpired and unused, matches the requested
// scope exactly, and every preflight check of that gate passed. An authorization is not transferable between gates.
// The gate script decides and records; it contains no code that performs any external action.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, run } from '../m00/helpers.js';

const rg = await import(path.join(repoRoot, 'scripts', 'release', 'release-gate.mjs'));

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const authorizers = { 'owner-k1': publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') };
const now = new Date('2026-11-12T12:00:00.000Z');
const sha = 'f'.repeat(40);
const image = `sha256:${'9'.repeat(64)}`;

const SCOPES: Record<string, Record<string, unknown>> = {
  REPO_PUBLICATION: { repository: 'gnanam1990/uptimebuyer', visibility: 'public', sourceSha: sha },
  X_POST: { account: 'project-account', contentSha256: 'a'.repeat(64) },
  VIDEO_UPLOAD: { destination: 'video-host', fileSha256: 'b'.repeat(64) },
  RELEASE_TAG: { tag: 'v0.1.0', sourceSha: sha },
  PAYMENT: {
    merchant: 'merchant-1',
    amountMinor: 2000,
    currency: 'USD',
    purpose: 'diagnostic visit',
    environment: 'pilot',
  },
  HACKATHON_SUBMISSION: { destination: 'event-form', contentSha256: 'c'.repeat(64), sourceSha: sha },
  DEPLOY: { environment: 'staging', sourceSha: sha, imageIds: { api: image } },
};
const record = (gate: string, over: Record<string, unknown> = {}, key = privateKey, keyId = 'owner-k1') =>
  rg.signAuthorization(
    {
      schema: 'release-authorization.v1',
      gate,
      authorizationId: `auth-${gate.toLowerCase()}-1`,
      authorizedBy: 'repository-owner',
      authorizedAt: '2026-11-12T11:00:00.000Z',
      expiresAt: '2026-11-12T13:00:00.000Z',
      statement: `Authorize ${gate} with exactly this scope.`,
      scope: SCOPES[gate],
      ...over,
    },
    key,
    keyId,
  );
const allPreflight = (gate: string) =>
  Object.fromEntries((rg.loadGateConfig(repoRoot).gates[gate].preflight as string[]).map((c) => [c, true]));
const ctx = (records: unknown[], gate: string, over: Record<string, unknown> = {}) => ({
  authorizations: records,
  authorizers,
  consumed: new Set<string>(),
  now,
  preflight: allPreflight(gate),
  ...over,
});

describe('T-060 release gates are separate and explicit', () => {
  it('configures exactly the seven external-action gates, each with scope fields and preflight checks', () => {
    const cfg = rg.loadGateConfig(repoRoot);
    expect(Object.keys(cfg.gates).sort()).toEqual([...rg.GATES].sort());
    expect([...rg.GATES].sort()).toEqual(
      ['DEPLOY', 'HACKATHON_SUBMISSION', 'PAYMENT', 'RELEASE_TAG', 'REPO_PUBLICATION', 'VIDEO_UPLOAD', 'X_POST'].sort(),
    );
    for (const g of rg.GATES) {
      expect(cfg.gates[g].scope.length, g).toBeGreaterThan(0);
      expect(cfg.gates[g].preflight.length, g).toBeGreaterThan(0);
    }
  });

  it.each(['REPO_PUBLICATION', 'X_POST', 'VIDEO_UPLOAD', 'RELEASE_TAG', 'PAYMENT', 'HACKATHON_SUBMISSION', 'DEPLOY'])(
    '%s refuses without an authorization record',
    (gate) => {
      const d = rg.evaluateGate(gate, SCOPES[gate], ctx([], gate));
      expect(d.decision).toBe('REFUSED');
      expect(d.reasons).toContain('NO_AUTHORIZATION');
    },
  );

  it.each(['REPO_PUBLICATION', 'X_POST', 'VIDEO_UPLOAD', 'RELEASE_TAG', 'PAYMENT', 'HACKATHON_SUBMISSION', 'DEPLOY'])(
    '%s authorizes with its own signed, scoped, unexpired record and passing preflight',
    (gate) => {
      const d = rg.evaluateGate(gate, SCOPES[gate], ctx([record(gate)], gate));
      expect(d.reasons).toEqual([]);
      expect(d.decision).toBe('AUTHORIZED');
    },
  );

  it('an authorization never transfers to another gate', () => {
    for (const from of rg.GATES)
      for (const to of rg.GATES) {
        if (from === to) continue;
        const d = rg.evaluateGate(
          to,
          SCOPES[to],
          ctx([record(from)], to, { authorizationId: `auth-${from.toLowerCase()}-1` }),
        );
        expect(d.decision, `${from} -> ${to}`).toBe('REFUSED');
        expect(d.reasons.join(' '), `${from} -> ${to}`).toMatch(/AUTHORIZATION_FOR_OTHER_GATE|NO_AUTHORIZATION/);
      }
  });

  it('a record re-labelled for another gate fails its signature', () => {
    const deploy = record('DEPLOY');
    const relabelled = { ...deploy, gate: 'RELEASE_TAG', scope: SCOPES.RELEASE_TAG };
    const d = rg.evaluateGate('RELEASE_TAG', SCOPES.RELEASE_TAG, ctx([relabelled], 'RELEASE_TAG'));
    expect(d.decision).toBe('REFUSED');
    expect(d.reasons).toContain('SIGNATURE_INVALID');
  });

  it('refuses an unknown authorizer, an expired or future record, and a used record', () => {
    expect(
      rg.evaluateGate('DEPLOY', SCOPES.DEPLOY, ctx([record('DEPLOY', {}, other.privateKey, 'stranger')], 'DEPLOY'))
        .reasons,
    ).toContain('AUTHORIZER_UNKNOWN');
    expect(
      rg.evaluateGate('DEPLOY', SCOPES.DEPLOY, ctx([record('DEPLOY', {}, other.privateKey)], 'DEPLOY')).reasons,
    ).toContain('SIGNATURE_INVALID');
    expect(
      rg.evaluateGate(
        'DEPLOY',
        SCOPES.DEPLOY,
        ctx([record('DEPLOY', { expiresAt: '2026-11-12T11:30:00.000Z' })], 'DEPLOY'),
      ).reasons,
    ).toContain('AUTHORIZATION_EXPIRED');
    expect(
      rg.evaluateGate(
        'DEPLOY',
        SCOPES.DEPLOY,
        ctx([record('DEPLOY', { authorizedAt: '2026-11-12T12:30:00.000Z' })], 'DEPLOY'),
      ).reasons,
    ).toContain('AUTHORIZATION_NOT_YET_VALID');
    expect(
      rg.evaluateGate(
        'DEPLOY',
        SCOPES.DEPLOY,
        ctx([record('DEPLOY')], 'DEPLOY', { consumed: new Set(['auth-deploy-1']) }),
      ).reasons,
    ).toContain('AUTHORIZATION_ALREADY_USED');
  });

  it('refuses any request outside the authorized scope', () => {
    expect(
      rg.evaluateGate('DEPLOY', { ...SCOPES.DEPLOY, sourceSha: 'e'.repeat(40) }, ctx([record('DEPLOY')], 'DEPLOY'))
        .reasons,
    ).toContain('SCOPE_MISMATCH:sourceSha');
    expect(
      rg.evaluateGate(
        'DEPLOY',
        { ...SCOPES.DEPLOY, imageIds: { api: `sha256:${'8'.repeat(64)}` } },
        ctx([record('DEPLOY')], 'DEPLOY'),
      ).reasons,
    ).toContain('SCOPE_MISMATCH:imageIds');
    expect(
      rg.evaluateGate('PAYMENT', { ...SCOPES.PAYMENT, amountMinor: 2001 }, ctx([record('PAYMENT')], 'PAYMENT')).reasons,
    ).toContain('SCOPE_MISMATCH:amountMinor');
    expect(
      rg.evaluateGate('PAYMENT', { ...SCOPES.PAYMENT, amountMinor: 1500 }, ctx([record('PAYMENT')], 'PAYMENT'))
        .decision,
    ).toBe('AUTHORIZED');
    expect(
      rg.evaluateGate('PAYMENT', { ...SCOPES.PAYMENT, merchant: 'other' }, ctx([record('PAYMENT')], 'PAYMENT')).reasons,
    ).toContain('SCOPE_MISMATCH:merchant');
  });

  it('refuses when any preflight check of the gate did not pass', () => {
    const pf = allPreflight('DEPLOY');
    const first = Object.keys(pf)[0]!;
    const d = rg.evaluateGate(
      'DEPLOY',
      SCOPES.DEPLOY,
      ctx([record('DEPLOY')], 'DEPLOY', { preflight: { ...pf, [first]: false } }),
    );
    expect(d.decision).toBe('REFUSED');
    expect(d.reasons).toContain(`PREFLIGHT_FAILED:${first}`);
    expect(
      rg.evaluateGate('DEPLOY', SCOPES.DEPLOY, ctx([record('DEPLOY')], 'DEPLOY', { preflight: {} })).decision,
    ).toBe('REFUSED');
  });
});

describe('T-060 repository state: no external action is authorized', () => {
  it('registers no authorizer and holds no authorization record, so every gate is REFUSED', () => {
    const r = run('node', ['scripts/release/release-gate.mjs', 'status', '--json']);
    expect(r.code).toBe(0);
    const status = JSON.parse(r.stdout);
    expect(status.gates.map((g: { gate: string }) => g.gate).sort()).toEqual([...rg.GATES].sort());
    for (const g of status.gates) {
      expect(g.decision, g.gate).toBe('REFUSED');
      expect(g.reasons, g.gate).toContain('NO_AUTHORIZATION');
    }
    expect(status.authorizers).toEqual([]);
  });

  it('a check against the repository refuses and exits non-zero', () => {
    const r = run('node', ['scripts/release/release-gate.mjs', 'check', 'DEPLOY']);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('REFUSED');
  });

  it('the release-gate status table in the docs lists all seven gates as REFUSED', () => {
    const md = readFileSync(path.join(repoRoot, 'docs/release/RELEASE-GATES.md'), 'utf8');
    for (const g of rg.GATES) expect(md).toMatch(new RegExp(`\\|\\s*${g}\\s*\\|[^\\n]*REFUSED`));
  });

  it('the gate tooling contains no code path that performs an external action', () => {
    for (const f of ['release-gate.mjs', 'claim-check.mjs', 'journey-gate.mjs']) {
      const text = readFileSync(path.join(repoRoot, 'scripts/release', f), 'utf8');
      expect(text, f).not.toMatch(
        /\bgit\b['"]?\s*,\s*\[?['"](push|tag)|['"]gh['"]|docker['"]?\s*,\s*\[?['"]push|\bfetch\(|https?\.request\(/,
      );
      expect(text, f).not.toMatch(/child_process/);
    }
  });
});
