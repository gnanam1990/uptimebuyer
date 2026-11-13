// T-058 payment part, pre-egress checks (no network, no database). The x402 preflight assessment reads the merchant's
// unpaid 402 answer and refuses anything above 1 cent or not USDC on Base; it is driven by the REAL unpaid preflight
// captured on 2026-11-13 (test/fixtures/lionx402-preflight-402.json, public data, nothing paid) and variants of it.
// The broker's KITE_PASSPORT adapter file (outside the repository, 0600) and its kpass state root (0700, outside the
// repository) are validated before anything runs; the committed example stays valid and binds the exact merchant URL.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, KiteAdapterFileSchema, loadKiteAdapterFile } from '../src/config.js';
import { LIONX402, assessX402Preflight, checkStateRoot } from './support/kite-payment-journey.js';

const here = import.meta.dirname;
const repoRoot = path.resolve(here, '..', '..', '..');
const capture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'lionx402-preflight-402.json'), 'utf8'));
const asCapture = (body: unknown, over: Record<string, unknown> = {}) => ({
  status: 402,
  headers: {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
  ...over,
});
const realBody = () => JSON.parse(capture.response.body);

describe('T-058 x402 preflight assessment (real unpaid capture, 2026-11-13)', () => {
  it('the captured 402 asks for exactly 0.01 USDC on Base (eip155:8453) and names its payTo', () => {
    expect(capture.label).toBe('REAL_UNPAID_PREFLIGHT');
    expect(capture.request.url).toBe(LIONX402.url);
    const r = assessX402Preflight(capture.response);
    expect(r).toEqual({
      ok: true,
      x402Version: 2,
      priceMinor: 1n,
      amountAtomic: '10000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      network: 'eip155:8453',
      payTo: '0x68e3E7822cf83C824cF9606EC999b5e8a93c85B5',
      scheme: 'exact',
      source: 'BODY_AND_HEADER',
    });
  });

  it.each([
    ['a price above 1 cent', (b: any) => (b.accepts[0].amount = '10001'), 'PREFLIGHT_PRICE_ABOVE_CAP'],
    ['another network', (b: any) => (b.accepts[0].network = 'eip155:137'), 'PREFLIGHT_NOT_BASE'],
    ['Base Sepolia', (b: any) => (b.accepts[0].network = 'eip155:84532'), 'PREFLIGHT_NOT_BASE'],
    [
      'another asset',
      (b: any) => (b.accepts[0].asset = '0x0000000000000000000000000000000000000001'),
      'PREFLIGHT_NOT_USDC',
    ],
    ['a non-exact scheme', (b: any) => (b.accepts[0].scheme = 'upto'), 'PREFLIGHT_SCHEME_UNSUPPORTED'],
    [
      'a second, non-Base option',
      (b: any) => b.accepts.push({ ...b.accepts[0], network: 'solana:mainnet' }),
      'PREFLIGHT_NOT_BASE',
    ],
    ['no options', (b: any) => (b.accepts = []), 'PREFLIGHT_UNREADABLE'],
    ['a non-integer amount', (b: any) => (b.accepts[0].amount = '0.01'), 'PREFLIGHT_UNREADABLE'],
    ['a missing payTo', (b: any) => delete b.accepts[0].payTo, 'PREFLIGHT_UNREADABLE'],
  ])('refuses %s', (_n, mutate, reason) => {
    const b = realBody();
    mutate(b);
    expect(assessX402Preflight(asCapture(b))).toEqual({ ok: false, reason });
  });

  it('refuses a non-402 answer, an unreadable body and a header that disagrees with the body', () => {
    expect(assessX402Preflight(asCapture(realBody(), { status: 200 }))).toEqual({
      ok: false,
      reason: 'PREFLIGHT_NOT_402',
    });
    expect(assessX402Preflight(asCapture('<html>'))).toEqual({ ok: false, reason: 'PREFLIGHT_UNREADABLE' });
    const other = realBody();
    other.accepts[0].payTo = '0x0000000000000000000000000000000000000002';
    expect(
      assessX402Preflight(
        asCapture(other, { headers: { 'payment-required': capture.response.headers['payment-required'] } }),
      ),
    ).toEqual({ ok: false, reason: 'PREFLIGHT_AMBIGUOUS' });
  });

  it('reads the payment-required header alone when the body is empty', () => {
    const r = assessX402Preflight({ status: 402, headers: capture.response.headers, body: '' });
    expect(r).toMatchObject({ ok: true, priceMinor: 1n, source: 'HEADER' });
  });
});

describe('T-058 broker KITE_PASSPORT adapter file and state root', () => {
  const tmp = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ub-kite-cfg-'));
    chmodSync(d, 0o700);
    return d;
  };
  const write = (dir: string, doc: unknown, mode = 0o600) => {
    const f = path.join(dir, 'broker.json');
    writeFileSync(f, JSON.stringify(doc));
    chmodSync(f, mode);
    return f;
  };
  const reason = (fn: () => unknown) => {
    try {
      fn();
      return 'ACCEPTED';
    } catch (e) {
      return e instanceof ConfigError ? e.reasonCode : String(e);
    }
  };
  const doc = (stateRoot: string, over: Record<string, unknown> = {}) => ({
    schema: 'uptimebuyer-kite-broker-adapter.v1',
    adapter: {
      kind: 'KITE_PASSPORT',
      kpassBinary: '/usr/local/bin/kpass',
      stateRoot,
      timeoutMs: 300_000,
      readTimeoutMs: 30_000,
      merchantEndpoints: { [LIONX402.merchantId]: { url: LIONX402.url, method: 'GET' } },
      manualReconciliationAccepted: true,
      ...over,
    },
  });

  it('accepts a 0600 file with the KITE_PASSPORT section and refuses an open mode, a wrong schema or extra fields', () => {
    const d = tmp();
    expect(reason(() => loadKiteAdapterFile(write(d, doc(d))))).toBe('ACCEPTED');
    expect(loadKiteAdapterFile(write(d, doc(d))).merchantEndpoints[LIONX402.merchantId]).toEqual({
      url: LIONX402.url,
      method: 'GET',
    });
    expect(reason(() => loadKiteAdapterFile(write(d, doc(d), 0o644)))).toBe('SECRET_FILE_MODE_TOO_OPEN');
    expect(reason(() => loadKiteAdapterFile(write(d, { ...doc(d), schema: 'other' })))).toMatch(
      /^SECRET_CONFIG_INVALID/,
    );
    expect(reason(() => loadKiteAdapterFile(write(d, doc(d, { token: 'x' }))))).toMatch(/^SECRET_CONFIG_INVALID/);
    expect(reason(() => loadKiteAdapterFile(write(d, doc(d, { kind: 'LOCAL_STAND_IN' }))))).toMatch(
      /^SECRET_CONFIG_INVALID/,
    );
    expect(
      reason(() =>
        loadKiteAdapterFile(
          write(d, doc(d, { merchantEndpoints: { 'lionx402.com': { url: LIONX402.url, method: 'GET' } } })),
        ),
      ),
    ).toMatch(/^SECRET_CONFIG_INVALID/);
  });

  it('the state root must be a private directory of this user outside the repository', () => {
    const d = tmp();
    expect(checkStateRoot(d, repoRoot)).toEqual({ ok: true });
    chmodSync(d, 0o755);
    expect(checkStateRoot(d, repoRoot)).toEqual({ ok: false, reason: 'STATE_ROOT_NOT_PRIVATE' });
    expect(checkStateRoot(path.join(d, 'missing'), repoRoot)).toEqual({ ok: false, reason: 'STATE_ROOT_MISSING' });
    const inside = path.join(repoRoot, 'tmp', `kite-state-${process.pid}`);
    mkdirSync(inside, { recursive: true, mode: 0o700 });
    chmodSync(inside, 0o700);
    expect(checkStateRoot(inside, repoRoot)).toEqual({ ok: false, reason: 'STATE_ROOT_INSIDE_REPOSITORY' });
  });

  it('the committed example is a valid adapter file (placeholders only) that binds the exact merchant URL and method', () => {
    const example = JSON.parse(
      readFileSync(path.join(repoRoot, 'apps', 'kite-broker', 'config', 'broker.kite-passport.example.json'), 'utf8'),
    );
    const parsed = KiteAdapterFileSchema.parse(example);
    expect(parsed.adapter.merchantEndpoints[LIONX402.merchantId]).toEqual({ url: LIONX402.url, method: 'GET' });
    expect(parsed.adapter.sameKeyReplayVerified ?? false).toBe(false);
    expect(JSON.stringify(example)).not.toMatch(/eyJ|agt_|art_|jwt|token/i);
  });
});
