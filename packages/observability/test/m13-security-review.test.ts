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

// S9 — redaction shortened the text (REDACTED is shorter than what it replaces) before the kept prefix was cut, so
//      characters from beyond the original kept length — including a partly matched secret at the scan-window cut —
//      could shift into the output, and a secret straddling the kept length was half kept. Output now holds only
//      characters whose ORIGINAL offset is below the kept length; a match starting there is redacted whole.
// S10 — the userinfo rule stopped at `/`, `?` or `#`, so passwords containing them were logged. Userinfo now runs to
//      the last `@` of the authority (a query or fragment that follows a path is not authority).
describe('M13 security review S9: only original-offset characters below the kept length survive', () => {
  const KEPT = 1_024;
  it('short secrets early cannot pull a window-straddling canary into the output', () => {
    const early = Array.from({ length: 60 }, () => ` Bearer ${randomBytes(12).toString('hex')}`).join('');
    const pad = 'z'.repeat(Math.max(0, KEPT + 300 - early.length));
    const canaryValue = `ghp_${randomBytes(30).toString('hex')}`;
    const input = early + pad + canaryValue + 'w'.repeat(20_000);
    const out = redactString(input);
    for (let i = 0; i + 6 <= canaryValue.length; i++) expect(out).not.toContain(canaryValue.slice(i, i + 6));
    expect(out.endsWith('…[TRUNCATED]')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(KEPT + 20);
  });

  it('a secret straddling the kept length appears in neither full nor partial form', () => {
    for (const make of [
      () => `Bearer ${randomBytes(40).toString('hex')}`,
      () => `ghp_${randomBytes(30).toString('hex')}`,
      () => `postgres://svc:${randomBytes(20).toString('hex')}@db:5432/x`,
    ]) {
      const secret = make();
      const at = KEPT - Math.floor(secret.length / 2);
      // Separated from the padding by a space: the patterns anchor on word boundaries as real log text has them.
      const input = 'k'.repeat(at - 1) + ' ' + secret + ' tail'.repeat(5_000);
      const out = redactString(input);
      const hidden = secret.slice(secret.length / 2 - 8);
      for (let i = 0; i + 6 <= hidden.length; i++) expect(out, secret).not.toContain(hidden.slice(i, i + 6));
      expect(out.endsWith('…[TRUNCATED]')).toBe(true);
    }
  });
});

describe('M13 security review S10: userinfo runs to the last @ of the authority', () => {
  it.each([
    ['token-only with slash', (p: string) => `postgres://${p}/x@db/ub`],
    ['user:pass with slash', (p: string) => `postgres://u:${p}/ss@db/x`],
    ['user:pass with question mark', (p: string) => `postgres://u:${p}?ss@db/x`],
    ['user:pass with hash', (p: string) => `postgres://u:${p}#ss@db/x`],
    ['user:pass with colon', (p: string) => `postgres://u:${p}:ss@db/x`],
    ['multiple @', (p: string) => `postgres://u:${p}@ss@db/x`],
    ['percent-encoded @', (p: string) => `postgres://u:${p}%40ss@db/x`],
    ['unicode', (p: string) => `postgres://u:${p}é密码@db/x`],
  ])('redacts a password: %s', (_n, url) => {
    const p = `pw${randomBytes(10).toString('hex')}`;
    const out = redactString(`connect ${url(p)} now`);
    expect(out).not.toContain(p);
    expect(out).toContain(REDACTED);
  });

  it('leaves a URL without userinfo intact and keeps the host when a query carries an e-mail address', () => {
    expect(redactString('see https://docs.example.com/guide?page=2#top')).toBe(
      'see https://docs.example.com/guide?page=2#top',
    );
    const out = redactString('open https://portal.example.com/search?email=tech@example.org&x=1');
    expect(out).toContain('https://portal.example.com/search?email=');
    expect(out).not.toContain('tech@example.org');
  });
});
