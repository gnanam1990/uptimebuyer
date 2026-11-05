// M12 typed client units: requests carry the in-memory bearer token only in the Authorization header (never the URL),
// mutations always carry an Idempotency-Key and versioned commands If-Match, bodies are encoded with the strict shared
// schemas (a smuggled field never leaves the client), responses are decoded with closed state enums (an unknown
// external-outcome value is a contract error, not a rendered guess), and a 202 error body (outcome unknown) is thrown,
// never decoded as success (INV-12).
import { describe, expect, it } from 'vitest';
import { ApiClientError, ApiContractError, createApiClient } from '../src/index.js';

type Seen = { url: string; init: RequestInit };
function fakeFetch(status: number, json: unknown, seen: Seen[] = []) {
  return {
    seen,
    fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(json), {
        status,
        headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr_test-0001' },
      });
    }) as unknown as typeof fetch,
  };
}

const TOKEN = ['eyJhbGciOiJFUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'c2lnbmF0dXJl'].join('.');

describe('M12 api-client', () => {
  it('sends the token only as a bearer header and an Idempotency-Key plus If-Match on versioned commands', async () => {
    const f = fakeFetch(200, { incidentId: 'inc_abcd-1234', state: 'ESCALATED', version: 4 });
    const c = createApiClient({
      getAccessToken: () => TOKEN,
      fetch: f.fetch,
      newIdempotencyKey: () => 'ub-web-key-0001',
    });
    const r = await c.escalate('inc_abcd-1234', { reasonCode: 'NO_RESPONSE' }, { expectedVersion: 3 });
    expect(r.version).toBe(4);
    const { url, init } = f.seen[0]!;
    expect(url).toBe('/v1/incidents/inc_abcd-1234:escalate');
    expect(url).not.toContain(TOKEN);
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h['idempotency-key']).toBe('ub-web-key-0001');
    expect(h['if-match']).toBe('"3"');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(String(init.body))).toEqual({ reasonCode: 'NO_RESPONSE' });
  });

  it('never sends a request without a token, and never lets a smuggled field leave the client', async () => {
    const f = fakeFetch(200, {});
    const signedOut = createApiClient({ getAccessToken: () => null, fetch: f.fetch });
    await expect(signedOut.fleet()).rejects.toBeInstanceOf(ApiClientError);
    expect(f.seen).toHaveLength(0);
    const c = createApiClient({ getAccessToken: () => TOKEN, fetch: f.fetch });
    await expect(
      c.escalate('inc_abcd-1234', { reasonCode: 'X', tenantId: 'ten_other-0001' } as never, { expectedVersion: 1 }),
    ).rejects.toThrow();
    expect(f.seen).toHaveLength(0);
  });

  it('an unknown external-outcome value is a contract error, never rendered', async () => {
    const f = fakeFetch(200, {
      kiteSessionId: 'kss_x',
      transportState: 'ACKNOWLEDGED',
      externalOutcomeState: 'PROBABLY_FINE',
      adapterCapability: 'ELIGIBLE',
      providerSessionRef: null,
    });
    const c = createApiClient({ getAccessToken: () => TOKEN, fetch: f.fetch });
    await expect(c.authority('xau_abcd-1234')).rejects.toBeInstanceOf(ApiContractError);
  });

  it('a 202 carrying an error body (outcome unknown) is thrown, not decoded as success', async () => {
    const f = fakeFetch(202, {
      error: {
        code: 'DEPENDENCY_OUTCOME_UNKNOWN',
        errorClass: 'DEPENDENCY_UNKNOWN',
        message: 'The outcome is unknown.',
        correlationId: 'corr_test-0001',
      },
    });
    const c = createApiClient({ getAccessToken: () => TOKEN, fetch: f.fetch });
    const e = await c
      .issueAuthority('apr_abcd-1234', { subject: { type: 'PLAN_ACTION', id: 'cand_abcd-1234' } })
      .catch((x) => x);
    expect(e).toBeInstanceOf(ApiClientError);
    expect(e.status).toBe(202);
    expect(e.code).toBe('DEPENDENCY_OUTCOME_UNKNOWN');
  });

  it('a 409 VERSION_CONFLICT surfaces the current version for reload-and-retry', async () => {
    const f = fakeFetch(409, {
      error: {
        code: 'VERSION_CONFLICT',
        errorClass: 'CONFLICT',
        message: 'The resource changed; reload and retry.',
        correlationId: 'corr_test-0001',
        reasonCode: 'VERSION_CONFLICT',
        currentVersion: 9,
      },
    });
    const c = createApiClient({ getAccessToken: () => TOKEN, fetch: f.fetch });
    const e = await c.acknowledge('inc_abcd-1234', { expectedVersion: 8 }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiClientError);
    expect(e.currentVersion).toBe(9);
    expect(e.reasonCode).toBe('VERSION_CONFLICT');
  });
});
