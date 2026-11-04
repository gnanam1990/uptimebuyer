// T-039 — Credential and paid-egress isolation (secret delivery). The broker reads its credential document only from
// an inherited fd or a 0600 file owned by its uid; a looser file, a malformed document or test crash points in
// production are refused, and a rejection names failing paths only — never a value.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadSecretFromFile } from '../src/config.js';

const canary = () => ['canary', randomBytes(12).toString('hex')].join('-');
const doc = (over: Record<string, unknown> = {}) => ({
  databaseUrl: `postgres://u:${canary()}@127.0.0.1:1/x`,
  referenceKeyring: { 'reference-k1': randomBytes(32).toString('base64url') },
  authorityPublicKeys: { 'authority-k1': randomBytes(44).toString('base64url') },
  compatibilitySigning: { keyId: 'c1', keyring: { c1: randomBytes(32).toString('base64url') } },
  adapter: { kind: 'NONE' },
  ...over,
});
function file(content: string, mode: number) {
  const p = join(mkdtempSync(join(tmpdir(), 'm09-secret-')), 'broker.json');
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ConfigError ? e.reasonCode : `OTHER:${String(e)}`;
  }
  return 'ACCEPTED';
};

describe('T-039 broker secret delivery', () => {
  it('accepts only a 0600 file and freezes the parsed document', () => {
    expect(reason(() => loadSecretFromFile(file(JSON.stringify(doc()), 0o644)))).toBe('SECRET_FILE_MODE_TOO_OPEN');
    const cfg = loadSecretFromFile(file(JSON.stringify(doc()), 0o600));
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(cfg.mode).toBe('PRODUCTION');
  });

  it('refuses malformed documents, test crash points in production and a lease shorter than the adapter timeout', () => {
    const secret = canary();
    const bad = reason(() =>
      loadSecretFromFile(file(JSON.stringify(doc({ adapter: { kind: 'LOCAL_STAND_IN', capability: secret } })), 0o600)),
    );
    expect(bad).toMatch(/^SECRET_CONFIG_INVALID:/);
    expect(bad).not.toContain(secret);
    expect(reason(() => loadSecretFromFile(file('not json', 0o600)))).toBe('SECRET_CONFIG_NOT_JSON');
    expect(
      reason(() => loadSecretFromFile(file(JSON.stringify(doc({ testFaults: ['AFTER_SEND_STARTED'] })), 0o600))),
    ).toBe('TEST_FAULTS_IN_PRODUCTION');
    const kite = {
      kind: 'KITE_PASSPORT',
      kpassBinary: '/usr/local/bin/kpass',
      stateRoot: '/var/lib/kite-broker',
      timeoutMs: 300_000,
      merchantEndpoints: {},
    };
    expect(
      reason(() => loadSecretFromFile(file(JSON.stringify(doc({ adapter: kite, sendLeaseMs: 60_000 })), 0o600))),
    ).toBe('SEND_LEASE_SHORTER_THAN_ADAPTER_TIMEOUT');
    expect(
      reason(() => loadSecretFromFile(file(JSON.stringify(doc({ adapter: kite, sendLeaseMs: 301_000 })), 0o600))),
    ).toBe('ACCEPTED');
  });
});
