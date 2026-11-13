// T-060 authorization tooling the USER runs (scripts/release/authorize.mjs): offline, no network. It keeps an Ed25519
// key in a private directory outside the repository (0700 dir, 0600 key), prints only the public key and key id, builds
// a PAYMENT authorization record from explicit arguments (validity at most the gate's 4 hours), describes it in plain
// words and signs it only after the user types YES. Every test here uses a throwaway key in a temporary directory.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../m00/helpers.js';

const az = await import(path.join(repoRoot, 'scripts', 'release', 'authorize.mjs'));
const rg = await import(path.join(repoRoot, 'scripts', 'release', 'release-gate.mjs'));

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ub-t060-az-'));
  dirs.push(d);
  return d;
};
const args = {
  merchant: 'lionx402.com',
  amountMinor: 1,
  currency: 'USD',
  purpose: 'REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP',
  environment: 'kite-passport-prod',
  validHours: 2,
  authorizedBy: 'repository-owner',
};
const now = new Date('2026-11-13T10:00:00.000Z');

describe('T-060 authorize.mjs key handling', () => {
  it('creates a 0600 key in a 0700 directory once, then reuses it; the public key is DER SPKI base64url', () => {
    const dir = path.join(tmp(), 'authorizer');
    const a = az.ensureKey(dir);
    expect(a.created).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const keyFile = path.join(dir, 'authorizer-ed25519.pem');
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(a.keyId).toMatch(/^owner-[0-9a-f]{16}$/);
    const b = az.ensureKey(dir);
    expect(b).toEqual({ ...a, created: false });
    // A key readable by others is refused rather than used.
    chmodSync(keyFile, 0o644);
    expect(() => az.ensureKey(dir)).toThrow(/0600/);
  });

  it('PR #21 review 8: refuses a key directory that reaches the repository through a symlink', () => {
    const outside = tmp();
    const link = path.join(outside, 'repo-link');
    symlinkSync(path.join(repoRoot, 'tmp'), link);
    expect(() => az.ensureKey(path.join(link, 'authorizer-via-link'), { repoRoot })).toThrow(/outside the repository/);
    expect(existsSync(path.join(repoRoot, 'tmp', 'authorizer-via-link'))).toBe(false);
  });

  it('refuses a key directory inside the repository', () => {
    expect(() => az.ensureKey(path.join(repoRoot, 'tmp', 'authorizer-in-repo'), { repoRoot })).toThrow(
      /outside the repository/,
    );
  });
});

describe('T-060 authorize.mjs PAYMENT record', () => {
  it('builds an exact-scope record, says it in plain words, and signs one the release gate accepts', () => {
    const dir = path.join(tmp(), 'authorizer');
    const key = az.ensureKey(dir);
    const rec = az.buildPaymentAuthorization(args, now);
    expect(rec).toMatchObject({
      schema: 'release-authorization.v1',
      gate: 'PAYMENT',
      authorizedBy: 'repository-owner',
      authorizedAt: '2026-11-13T10:00:00.000Z',
      expiresAt: '2026-11-13T12:00:00.000Z',
      scope: {
        merchant: 'lionx402.com',
        amountMinor: 1,
        currency: 'USD',
        purpose: 'REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP',
        environment: 'kite-passport-prod',
      },
    });
    expect(rec.authorizationId).toMatch(/^auth-payment-20261113-[0-9a-f]{6}$/);
    const words = az.describeAuthorization(rec);
    expect(words).toContain('lionx402.com');
    expect(words).toContain('1 minor unit');
    expect(words).toContain('USD 0.01');
    expect(words).toContain('2026-11-13T12:00:00.000Z');
    expect(words).toContain('only once');
    const signed = az.signRecord(rec, dir);
    expect(signed.signature).toMatchObject({ algorithm: 'ED25519', keyId: key.keyId });
    const d = rg.evaluateGate(
      'PAYMENT',
      { ...rec.scope, journeyId: 'j-x' },
      {
        authorizations: [signed],
        authorizers: { [key.keyId]: key.publicKey },
        consumed: new Set(),
        now: new Date('2026-11-13T10:30:00.000Z'),
        preflight: {
          'broker-isolation': true,
          'budget-bound': true,
          'reconciliation-ready': true,
          'kill-switch-ready': true,
        },
      },
    );
    expect(d).toMatchObject({ decision: 'AUTHORIZED', reasons: [] });
  });

  it.each([
    ['a validity over 4 hours', { validHours: 5 }],
    ['a zero validity', { validHours: 0 }],
    ['a zero amount', { amountMinor: 0 }],
    ['a fractional amount', { amountMinor: 1.5 }],
    ['a merchant that is not a host name', { merchant: 'https://lionx402.com/' }],
    ['a lower-case currency', { currency: 'usd' }],
    ['a free-text purpose', { purpose: 'refrigeration repair' }],
    ['a missing environment', { environment: '' }],
  ])('refuses %s', (_n, over) => {
    expect(() => az.buildPaymentAuthorization({ ...args, ...over }, now)).toThrow();
  });

  it('only the exact answer YES confirms', () => {
    expect(az.confirmed('YES')).toBe(true);
    expect(az.confirmed('YES\n')).toBe(true);
    for (const a of ['yes', 'Y', 'y', '', 'YES please', 'NO']) expect(az.confirmed(a), a).toBe(false);
  });
});

describe('T-060 authorize.mjs command line', () => {
  const cli = (argv: string[], input: string) =>
    spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'release', 'authorize.mjs'), ...argv], {
      input,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
  const payment = (dir: string, out: string) => [
    'payment',
    '--key-dir',
    dir,
    '--out',
    out,
    '--merchant',
    'lionx402.com',
    '--amount-minor',
    '1',
    '--currency',
    'USD',
    '--purpose',
    'REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP',
    '--environment',
    'kite-passport-prod',
    '--valid-hours',
    '2',
    '--authorized-by',
    'repository-owner',
  ];

  it('keygen prints the key id and public key, never the private key', () => {
    const dir = path.join(tmp(), 'authorizer');
    const r = cli(['keygen', '--key-dir', dir], '');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/keyId: owner-[0-9a-f]{16}/);
    expect(r.stdout).toMatch(/publicKey: [A-Za-z0-9_-]{40,}/);
    expect(r.stdout + r.stderr).not.toMatch(/PRIVATE KEY|BEGIN/);
  });

  it('writes nothing unless the user types YES; with YES it writes one signed record and prints its id', () => {
    const root = tmp();
    const dir = path.join(root, 'authorizer');
    const out = path.join(root, 'authorizations');
    const no = cli(payment(dir, out), 'yes\n');
    expect(no.status).not.toBe(0);
    expect(no.stdout).toContain('lionx402.com');
    expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
    const yes = cli(payment(dir, out), 'YES\n');
    expect(yes.status).toBe(0);
    const files = readdirSync(out);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^PAYMENT\.auth-payment-\d{8}-[0-9a-f]{6}\.json$/);
    const rec = JSON.parse(readFileSync(path.join(out, files[0]!), 'utf8'));
    expect(yes.stdout).toContain(rec.authorizationId);
    expect(rec.signature.algorithm).toBe('ED25519');
    expect(yes.stdout + yes.stderr).not.toMatch(/PRIVATE KEY|BEGIN/);
  });
});
