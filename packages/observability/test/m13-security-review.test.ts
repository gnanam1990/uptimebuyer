// M13 security review findings in redaction (each added red before its fix).
// S3 — URL userinfo: only `user:pass@` was redacted; a token-only userinfo (`https://TOKEN@host`, `postgres://SECRET@db`)
//      passed through. Any non-empty userinfo before `@` in a URL is now sensitive.
// S4 — unbounded work: every pattern ran over the whole input before truncation, so a multi-megabyte field cost work
//      proportional to its length on every pattern (and worse with backtracking). Input is now cut to a bounded window
//      (a margin past the kept length still catches a straddling secret) and email/phone repetition is bounded.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemorySink, REDACTED, StructuredLogger, redactString } from '../src/index.js';

const canary = (label: string) => ['cnry', label, randomBytes(12).toString('hex')].join('');

describe('M13 security review S3: URL userinfo is always sensitive', () => {
  it('redacts token-only and user:pass userinfo in any scheme', () => {
    const token = canary('ghptoken');
    const secret = canary('dbsecret');
    const user = canary('user');
    const pass = canary('pass');
    // Hosts without a dotted domain (service names, IPs) are not caught by the contact/e-mail rule, so they
    // exercise the userinfo rule itself.
    for (const [input, hidden] of [
      [`clone https://${token}@github.example/org/repo.git now`, [token]],
      [`db postgres://${secret}@db:5432/ub`, [secret]],
      [`db postgres://${user}:${pass}@db:5432/ub`, [user, pass]],
      [`cache redis://:${pass}@cache:6379/0`, [pass]],
      [`fetch https://${token}@10.0.0.5/jwks`, [token]],
      [`amqp://${token}@mq/vhost`, [token]],
    ] as const) {
      const out = redactString(input);
      for (const h of hidden) expect(out, input).not.toContain(h);
      expect(out).toContain(REDACTED);
    }
  });

  it('never writes a token-only userinfo through the logger', () => {
    const sink = new MemorySink();
    const token = canary('logtoken');
    new StructuredLogger({ service: 'api', sink: sink.write }).info('fetch.failed', {
      url: `https://${token}@idp/jwks`,
    });
    expect(sink.lines.join('\n')).not.toContain(token);
  });
});

describe('M13 security review S4: bounded redaction work', () => {
  it.each([
    ['email-like', 'a'.repeat(3_000_000) + '@' + 'b.'.repeat(1_000_000)],
    ['phone-like', '+1' + ' 2'.repeat(1_500_000)],
    ['card-like', '4111 '.repeat(800_000)],
    ['userinfo-like', 'https://' + 'x'.repeat(3_000_000)],
  ])('redacts a multi-megabyte %s string within a tight budget and keeps the truncation marker', (_n, big) => {
    const start = process.hrtime.bigint();
    const out = redactString(big);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(ms).toBeLessThan(250);
    expect(out.length).toBeLessThanOrEqual(1_100);
    expect(out.endsWith('…[TRUNCATED]')).toBe(true);
  });

  it('a secret that straddles the kept prefix is still redacted', () => {
    const token = canary('straddle');
    const input = 'x'.repeat(1_000) + ` Bearer ${token}` + 'y'.repeat(5_000_000);
    const out = redactString(input);
    expect(out).not.toContain(token);
    expect(out).not.toContain(token.slice(0, 10));
    expect(out.endsWith('…[TRUNCATED]')).toBe(true);
  });
});
