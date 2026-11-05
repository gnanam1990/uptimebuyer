// M12 API boundary units (no database): command-target parsing, If-Match/Idempotency-Key contracts, the strict request
// schemas refusing smuggled authority fields, the CSP, the token buckets and same-origin static hosting (no
// traversal, SPA fallback, no COOP on the OIDC callback).
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  AssignIncidentBodySchema,
  ApprovePlanBodySchema,
  IfMatchHeaderSchema,
  IssueAuthorityBodySchema,
  ListIncidentsQuerySchema,
} from '@uptimebuyer/contracts/api';
import { contentSecurityPolicy, TokenBuckets } from '../src/security.js';
import { commandTarget } from '../src/http.js';
import { registerStatic } from '../src/static.js';

describe('M12 API boundary', () => {
  it('splits {id}:{verb} targets and refuses unknown verbs', () => {
    expect(commandTarget('inc_abcd-1234:assign', ['assign', 'handoff'])).toEqual({
      id: 'inc_abcd-1234',
      verb: 'assign',
    });
    expect(commandTarget('inc_abcd-1234:delete', ['assign'])).toBeNull();
    expect(commandTarget('inc_abcd-1234', ['assign'])).toBeNull();
    expect(commandTarget(':assign', ['assign'])).toBeNull();
    expect(commandTarget(undefined, ['assign'])).toBeNull();
  });

  it('If-Match carries exactly one positive version; weak or list ETags are refused', () => {
    expect(IfMatchHeaderSchema.parse('"7"')).toBe(7);
    expect(IfMatchHeaderSchema.parse('12')).toBe(12);
    for (const bad of ['W/"7"', '"0"', '"7", "8"', '*', '"-1"', '"1e3"', ''])
      expect(IfMatchHeaderSchema.safeParse(bad).success, bad).toBe(false);
  });

  it('request schemas refuse tenant, site, actor, amount and revision claims', () => {
    const base = { assigneeUserId: 'usr_abcd-1234', reasonCode: 'SHIFT_PLAN' };
    expect(AssignIncidentBodySchema.safeParse(base).success).toBe(true);
    for (const extra of [
      { tenantId: 'ten_x1234' },
      { siteId: 'sit_x1234' },
      { actorId: 'usr_x1234' },
      { expectedVersion: 3 },
    ])
      expect(AssignIncidentBodySchema.safeParse({ ...base, ...extra }).success).toBe(false);
    expect(
      ApprovePlanBodySchema.safeParse({
        approvalRequestId: 'apq_abcd-1234',
        planHash: 'recovery-plan.v1:sha256:' + 'a'.repeat(64),
        maxAmount: { amountMinor: '1', currency: 'USD' },
      }).success,
    ).toBe(false);
    expect(
      IssueAuthorityBodySchema.safeParse({ subject: { type: 'PROVIDER_CONTACT_REQUEST', id: 'pcr_abcd-1234' } })
        .success,
    ).toBe(false);
    expect(ListIncidentsQuerySchema.safeParse({ tenantId: 'ten_x1234' }).success).toBe(false);
  });

  it('the CSP allows only same-origin script/style and the configured token endpoint', () => {
    const csp = contentSecurityPolicy(['https://idp.example']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' https://idp.example");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it('token buckets spend, refuse when empty, refill over time and bound memory', () => {
    let t = 0;
    const b = new TokenBuckets({ capacity: 2, refillPerSecond: 1, maxKeys: 2 }, () => t);
    expect(b.take('a')).toBe(true);
    expect(b.take('a')).toBe(true);
    expect(b.take('a')).toBe(false);
    expect(b.has('a')).toBe(false);
    t += 1_000;
    expect(b.take('a')).toBe(true);
    b.take('b');
    b.take('c');
    expect(b.has('a')).toBe(true); // evicted -> fresh budget, never a lockout of other keys
  });

  it('static hosting serves files inside the root only, falls back to the shell and strips COOP on the callback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ub-m12-static-'));
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>shell</title>');
    writeFileSync(join(root, 'assets', 'app-abc.js'), 'console.log(1)');
    const outside = mkdtempSync(join(tmpdir(), 'ub-m12-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'nope');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));
    const app = Fastify();
    app.addHook('onRequest', async (_req, reply) => {
      void reply.header('cross-origin-opener-policy', 'same-origin-allow-popups');
    });
    await registerStatic(app, root);
    await app.ready();
    const js = await app.inject({ method: 'GET', url: '/assets/app-abc.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('text/javascript');
    for (const url of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/hosts', '/leak.txt', '/assets/missing.js', '/x.exe'])
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    const deep = await app.inject({ method: 'GET', url: '/incidents/inc_abcd-1234/plan' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('<title>shell</title>');
    expect(deep.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
    const cb = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=y' });
    expect(cb.statusCode).toBe(200);
    expect(cb.headers['cross-origin-opener-policy']).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/v1/anything' })).statusCode).toBe(404);
    await app.close();
  });
});
