// T-055 (NFR-09, INV-13) — structured logs carry correlation fields and are redacted before they are written. Canary
// values (assembled at runtime, never committed) are planted in keys, values, nested objects, error messages and free
// text; none may reach the sink. Logs reference sensitive evidence by digest only.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DomainError } from '@uptimebuyer/contracts';
import {
  MemorySink,
  REDACTED,
  SecretRegistry,
  StructuredLogger,
  isSensitiveKey,
  redactString,
  redactValue,
} from '../src/index.js';

const canary = (label: string) => ['cnry', label, randomBytes(12).toString('hex')].join('-');
const jwtLike = () =>
  [
    'eyJ' + randomBytes(12).toString('base64url'),
    'eyJ' + randomBytes(24).toString('base64url'),
    randomBytes(32).toString('base64url'),
  ].join('.');

describe('T-055 structured log redaction (INV-13)', () => {
  it('redacts sensitive keys at any depth and keeps operational fields', () => {
    const secret = canary('nested');
    const out = redactValue({
      correlationId: 'corr_abc-123',
      incidentId: 'inc_fixture-1',
      authorization: `Bearer ${secret}`,
      nested: { apiKey: secret, deeper: { password: secret, rawBody: secret, transcript: secret } },
      headers: { Cookie: secret, 'x-api-key': secret },
      promptTokens: 120,
      list: [{ clientSecret: secret }],
    }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain(secret);
    expect(out.correlationId).toBe('corr_abc-123');
    expect(out.incidentId).toBe('inc_fixture-1');
    expect(out.promptTokens).toBe(120);
    expect((out.nested as Record<string, unknown>).apiKey).toBe(REDACTED);
  });

  it('redacts secret-shaped values regardless of key: bearer, JWT, PEM, secret refs, URLs with credentials, contacts', () => {
    const jwt = jwtLike();
    const samples = [
      `token was Bearer ${randomBytes(20).toString('hex')} ok`,
      `jwt ${jwt}`,
      ['-----BEGIN', 'PRIVATE KEY-----\nMIIB', randomBytes(8).toString('hex'), '\n-----END PRIVATE KEY-----'].join(' '),
      `ref secretref:provider/tenants/ten_x/${randomBytes(4).toString('hex')}`,
      `db postgres://svc:${randomBytes(6).toString('hex')}@db.internal:5432/x`,
      `call +1 415 555 0${String(100 + (randomBytes(1)[0]! % 800))}`,
      `mail tech.${randomBytes(3).toString('hex')}@example.com`,
      `card 4111 1111 1111 1111`,
    ];
    for (const s of samples) {
      const r = redactString(s);
      expect(r, s).toContain(REDACTED);
    }
    expect(redactString(`jwt ${jwt}`)).not.toContain(jwt.split('.')[2]!);
    // Identifiers, digests, timestamps and plain numbers are not secrets.
    for (const s of [
      'inc_fixture-0001',
      'sha256:' + 'a'.repeat(64),
      '2026-11-05T10:00:00.000Z',
      'amount 18500 USD',
      'corr_6f1e2d3c-1111',
    ])
      expect(redactString(s)).toBe(s);
  });

  it('scrubs every registered secret value (min 8 chars) wherever it appears', () => {
    const reg = new SecretRegistry();
    const a = canary('registered');
    reg.register(a);
    reg.register('short');
    reg.register(undefined);
    expect(reg.values()).toEqual([a]);
    expect(redactString(`prefix${a}suffix`, reg.values())).toBe(`prefix${REDACTED}suffix`);
  });

  it('classifies keys case- and separator-insensitively without hiding token counters', () => {
    for (const k of ['Authorization', 'x-api-key', 'client_secret', 'privateKey', 'refresh-token', 'raw_body', 'phone'])
      expect(isSensitiveKey(k), k).toBe(true);
    for (const k of ['promptTokens', 'completionTokens', 'maxOutputTokens', 'incidentId', 'reasonCode', 'status'])
      expect(isSensitiveKey(k), k).toBe(false);
  });

  it('bounds depth, string length and key count', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    const out = JSON.stringify(redactValue(deep));
    expect(out).toContain('[DEPTH_LIMIT]');
    const long = redactValue('x'.repeat(10_000)) as string;
    expect(long.length).toBeLessThanOrEqual(1_100);
    const wide = redactValue(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]))) as object;
    expect(Object.keys(wide).length).toBeLessThanOrEqual(201);
  });
});

describe('T-055 structured logger (NFR-09)', () => {
  it('writes one JSON line per event with service, level, event and correlation fields', () => {
    const sink = new MemorySink();
    const log = new StructuredLogger({
      service: 'api',
      sink: sink.write,
      clock: () => new Date('2026-11-05T00:00:00Z'),
    });
    log
      .child({ correlationId: 'corr_req-0001', tenantId: 'ten_alpha-0001' })
      .info('incident.acknowledged', { incidentId: 'inc_fixture-0001', attemptId: 'att_x-0001', latencyMs: 12 });
    const [rec] = sink.records();
    expect(rec).toEqual({
      timestamp: '2026-11-05T00:00:00.000Z',
      level: 'info',
      service: 'api',
      event: 'incident.acknowledged',
      correlationId: 'corr_req-0001',
      tenantId: 'ten_alpha-0001',
      incidentId: 'inc_fixture-0001',
      attemptId: 'att_x-0001',
      latencyMs: 12,
    });
    expect(sink.lines[0]!.includes('\n')).toBe(false);
  });

  it('never writes canaries planted in fields, free text or errors; non-primitive fields are dropped', () => {
    const sink = new MemorySink();
    const secrets = new SecretRegistry();
    const kiteKey = canary('kite');
    secrets.register(kiteKey);
    const log = new StructuredLogger({ service: 'worker', sink: sink.write, secrets });
    const contact = canary('contact');
    log.warn('provider.call_failed', {
      note: `provider echoed ${kiteKey} back`,
      authorization: `Bearer ${contact}`,
      payload: { raw: contact } as never,
      reasonCode: 'CLIENT_TIMEOUT',
    });
    log.errorFrom('provider.crash', new Error(`boom ${kiteKey} ${contact}`), { attemptId: 'att_x-0002' });
    log.errorFrom(
      'policy.hold',
      new DomainError('POLICY_HOLD', 'Held.', { reasonCode: 'APPROVAL_SCOPE_MISMATCH', secret: contact }),
    );
    const all = sink.lines.join('\n');
    expect(all).not.toContain(kiteKey);
    expect(all).not.toContain(contact);
    const [warn, crash, hold] = sink.records();
    expect(warn!.payload).toBe('[DROPPED]');
    expect(warn!.reasonCode).toBe('CLIENT_TIMEOUT');
    expect(crash).toMatchObject({ level: 'error', errorName: 'Error', attemptId: 'att_x-0002' });
    expect(crash!.errorMessage).toBeUndefined();
    expect(hold).toMatchObject({
      errorName: 'DomainError',
      errorCode: 'POLICY_HOLD',
      reasonCode: 'APPROVAL_SCOPE_MISMATCH',
    });
  });

  it('refuses malformed event names and honours the level threshold', () => {
    const sink = new MemorySink();
    const log = new StructuredLogger({ service: 'api', sink: sink.write, level: 'info' });
    log.debug('hidden.event');
    expect(() => log.info('Bad Event!')).toThrow();
    expect(sink.lines).toHaveLength(0);
  });
});
