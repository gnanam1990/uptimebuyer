// T-060 authorization tooling the USER runs (scripts/release/authorize.mjs): offline, no network. It keeps an Ed25519
// key in a private directory outside the repository (0700 dir, 0600 key), prints only the public key and key id, builds
// a PAYMENT authorization record from explicit arguments (validity at most the gate's 4 hours), describes it in plain
// words and signs it only after the user types YES. Every test here uses a throwaway key in a temporary directory.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

// T-060 release-artifact gates (X_POST, VIDEO_UPLOAD, RELEASE_TAG, HACKATHON_SUBMISSION): the same tool builds each
// record from explicit arguments, binds file contents by sha256 (computed here, never typed), says the record in plain
// words and signs it only after YES. Each record opens its own gate only.
describe('T-060 authorize.mjs release-artifact records', () => {
  const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
  const SOURCE = 'a'.repeat(40);
  const allPreflight = (gate: string) =>
    Object.fromEntries(rg.loadGateConfig(repoRoot).gates[gate].preflight.map((c: string) => [c, true]));
  const opens = (gate: string, signed: { scope: Record<string, unknown> }, key: { keyId: string; publicKey: string }) =>
    rg.evaluateGate(
      gate,
      { ...signed.scope },
      {
        authorizations: [signed],
        authorizers: { [key.keyId]: key.publicKey },
        consumed: new Set(),
        now: new Date('2026-11-13T10:30:00.000Z'),
        preflight: allPreflight(gate),
      },
    );
  const files = () => {
    const d = tmp();
    const text = path.join(d, 'x-post.txt');
    const post = 'UptimeBuyer: a test post with a link github.com/example/repo';
    writeFileSync(text, post);
    const video = path.join(d, 'demo.mp4');
    writeFileSync(video, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3]));
    const content = path.join(d, 'SUBMISSION.md');
    writeFileSync(content, '# Submission\n\nProject name: UptimeBuyer\n');
    return { d, text, post, video, content };
  };

  it('X_POST binds the account and the exact text sha256, shows the text, and opens only X_POST', () => {
    const f = files();
    const key = az.ensureKey(path.join(f.d, 'authorizer'));
    const rec = az.buildGateAuthorization(
      'X_POST',
      { account: '@uptimebuyer', textFile: f.text, validHours: 2, authorizedBy: 'repository-owner' },
      now,
    );
    expect(rec).toMatchObject({
      schema: 'release-authorization.v1',
      gate: 'X_POST',
      authorizedAt: '2026-11-13T10:00:00.000Z',
      expiresAt: '2026-11-13T12:00:00.000Z',
      scope: { account: '@uptimebuyer', contentSha256: sha(f.post) },
    });
    expect(Object.keys(rec.scope).sort()).toEqual(['account', 'contentSha256']);
    expect(rec.authorizationId).toMatch(/^auth-x-post-20261113-[0-9a-f]{6}$/);
    expect(rec.statement).toContain(sha(f.post));
    const words = az.describeAuthorization(rec);
    expect(words).toContain('@uptimebuyer');
    expect(words).toContain(f.post);
    expect(words).toContain(`${[...f.post].length} characters`);
    expect(words).toContain('only once');
    const signed = az.signRecord(rec, path.join(f.d, 'authorizer'));
    expect(opens('X_POST', signed, key)).toMatchObject({ decision: 'AUTHORIZED', reasons: [] });
    // The X_POST record never opens another gate.
    const other = rg.evaluateGate(
      'VIDEO_UPLOAD',
      { destination: 'https://x.example/v', fileSha256: sha('x') },
      {
        authorizations: [signed],
        authorizers: { [key.keyId]: key.publicKey },
        consumed: new Set(),
        now: new Date('2026-11-13T10:30:00.000Z'),
        preflight: allPreflight('VIDEO_UPLOAD'),
      },
    );
    expect(other.decision).toBe('REFUSED');
    // A changed text is a different post: the gate refuses it.
    const changed = rg.evaluateGate(
      'X_POST',
      { account: '@uptimebuyer', contentSha256: sha(`${f.post}!`) },
      {
        authorizations: [signed],
        authorizers: { [key.keyId]: key.publicKey },
        consumed: new Set(),
        now: new Date('2026-11-13T10:30:00.000Z'),
        preflight: allPreflight('X_POST'),
      },
    );
    expect(changed.reasons).toContain('SCOPE_MISMATCH:contentSha256');
  });

  it('VIDEO_UPLOAD binds the destination and the file sha256', () => {
    const f = files();
    const key = az.ensureKey(path.join(f.d, 'authorizer'));
    const rec = az.buildGateAuthorization(
      'VIDEO_UPLOAD',
      { destination: 'https://github.com/example/repo/releases/tag/v1.0.0', file: f.video, validHours: 24 },
      now,
    );
    expect(rec.scope).toEqual({
      destination: 'https://github.com/example/repo/releases/tag/v1.0.0',
      fileSha256: sha(readFileSync(f.video)),
    });
    expect(rec.authorizationId).toMatch(/^auth-video-upload-20261113-[0-9a-f]{6}$/);
    expect(az.describeAuthorization(rec)).toContain('11 bytes');
    expect(opens('VIDEO_UPLOAD', az.signRecord(rec, path.join(f.d, 'authorizer')), key).decision).toBe('AUTHORIZED');
  });

  it('RELEASE_TAG binds the tag and the commit', () => {
    const f = files();
    const key = az.ensureKey(path.join(f.d, 'authorizer'));
    const rec = az.buildGateAuthorization('RELEASE_TAG', { tag: 'v1.0.0', sourceSha: SOURCE, validHours: 4 }, now);
    expect(rec.scope).toEqual({ tag: 'v1.0.0', sourceSha: SOURCE });
    expect(rec.authorizationId).toMatch(/^auth-release-tag-20261113-[0-9a-f]{6}$/);
    expect(az.describeAuthorization(rec)).toContain(SOURCE);
    expect(opens('RELEASE_TAG', az.signRecord(rec, path.join(f.d, 'authorizer')), key).decision).toBe('AUTHORIZED');
  });

  it('HACKATHON_SUBMISSION binds the destination, the content sha256 and the commit', () => {
    const f = files();
    const key = az.ensureKey(path.join(f.d, 'authorizer'));
    const rec = az.buildGateAuthorization(
      'HACKATHON_SUBMISSION',
      {
        destination: 'https://openserv.typeform.com/submissions02',
        contentFile: f.content,
        sourceSha: SOURCE,
        validHours: 12,
      },
      now,
    );
    expect(rec.scope).toEqual({
      destination: 'https://openserv.typeform.com/submissions02',
      contentSha256: sha(readFileSync(f.content)),
      sourceSha: SOURCE,
    });
    expect(rec.authorizationId).toMatch(/^auth-hackathon-submission-20261113-[0-9a-f]{6}$/);
    expect(opens('HACKATHON_SUBMISSION', az.signRecord(rec, path.join(f.d, 'authorizer')), key).decision).toBe(
      'AUTHORIZED',
    );
  });

  it.each([
    ['an unknown gate', 'DEPLOY', {}],
    ['a validity over the gate maximum', 'RELEASE_TAG', { tag: 'v1.0.0', sourceSha: SOURCE, validHours: 25 }],
    ['a zero validity', 'RELEASE_TAG', { tag: 'v1.0.0', sourceSha: SOURCE, validHours: 0 }],
    ['a tag that is not a version', 'RELEASE_TAG', { tag: 'latest', sourceSha: SOURCE, validHours: 2 }],
    ['a short commit', 'RELEASE_TAG', { tag: 'v1.0.0', sourceSha: 'abc1234', validHours: 2 }],
    ['an upper-case commit', 'RELEASE_TAG', { tag: 'v1.0.0', sourceSha: 'A'.repeat(40), validHours: 2 }],
    ['an account without @', 'X_POST', { account: 'uptimebuyer', textFile: 'TEXT', validHours: 2 }],
    ['an http destination', 'VIDEO_UPLOAD', { destination: 'http://example.com/v', file: 'VIDEO', validHours: 2 }],
    [
      'a destination with userinfo',
      'VIDEO_UPLOAD',
      { destination: 'https://u:p@example.com/v', file: 'VIDEO', validHours: 2 },
    ],
    ['a missing file', 'VIDEO_UPLOAD', { destination: 'https://example.com/v', file: 'MISSING', validHours: 2 }],
    ['an empty file', 'VIDEO_UPLOAD', { destination: 'https://example.com/v', file: 'EMPTY', validHours: 2 }],
    ['an X text over 280 characters', 'X_POST', { account: '@uptimebuyer', textFile: 'LONG', validHours: 2 }],
  ])('refuses %s', (_n, gate, over) => {
    const f = files();
    const long = path.join(f.d, 'long.txt');
    writeFileSync(long, 'x'.repeat(281));
    const empty = path.join(f.d, 'empty.bin');
    writeFileSync(empty, '');
    const map: Record<string, string> = {
      TEXT: f.text,
      VIDEO: f.video,
      LONG: long,
      EMPTY: empty,
      MISSING: path.join(f.d, 'nope.mp4'),
    };
    const a = Object.fromEntries(
      Object.entries(over).map(([k, v]) => [k, typeof v === 'string' && map[v] ? map[v] : v]),
    );
    // A refusal is the builder's own rule, not a missing function.
    expect(() => az.buildGateAuthorization(gate, a, now)).toThrow(
      /builder|valid-hours|tag|commit|account|https URL|does not exist|empty|characters/,
    );
  });
});

describe('T-060 authorize.mjs release-artifact command line', () => {
  const cli = (argv: string[], input: string) =>
    spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'release', 'authorize.mjs'), ...argv], {
      input,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });

  it('x-post shows the exact text, writes nothing without YES, and with YES writes one record and the request', () => {
    const root = tmp();
    const text = path.join(root, 'x-post.txt');
    writeFileSync(text, 'UptimeBuyer test post');
    const dir = path.join(root, 'authorizer');
    const out = path.join(root, 'authorizations');
    const req = path.join(root, 'X_POST.request.json');
    const argv = ['x-post', '--key-dir', dir, '--out', out, '--account', '@uptimebuyer', '--text-file', text];
    const no = cli([...argv, '--valid-hours', '2', '--request-out', req], 'yes\n');
    expect(no.status).not.toBe(0);
    expect(no.stdout).toContain('UptimeBuyer test post');
    expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
    expect(existsSync(req)).toBe(false);
    const yes = cli([...argv, '--valid-hours', '2', '--request-out', req], 'YES\n');
    expect(yes.status).toBe(0);
    const recs = readdirSync(out);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatch(/^X_POST\.auth-x-post-\d{8}-[0-9a-f]{6}\.json$/);
    const rec = JSON.parse(readFileSync(path.join(out, recs[0]!), 'utf8'));
    expect(JSON.parse(readFileSync(req, 'utf8'))).toEqual(rec.scope);
    expect(yes.stdout + yes.stderr).not.toMatch(/PRIVATE KEY|BEGIN/);
  });

  it('--preview prints the record and writes only the request file: no key, no signature, no record', () => {
    const root = tmp();
    const dir = path.join(root, 'authorizer');
    const out = path.join(root, 'authorizations');
    const req = path.join(root, 'RELEASE_TAG.request.json');
    const r = cli(
      [
        'release-tag',
        '--preview',
        '--key-dir',
        dir,
        '--out',
        out,
        '--tag',
        'v1.0.0',
        '--source-sha',
        'b'.repeat(40),
        '--valid-hours',
        '2',
        '--request-out',
        req,
      ],
      '',
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PREVIEW');
    expect(r.stdout).toContain('v1.0.0');
    expect(JSON.parse(readFileSync(req, 'utf8'))).toEqual({ tag: 'v1.0.0', sourceSha: 'b'.repeat(40) });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(out)).toBe(false);
  });
});
