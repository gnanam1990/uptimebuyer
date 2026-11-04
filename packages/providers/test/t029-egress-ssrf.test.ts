// T-029 security review — SSRF and egress bounds for the live provider transport (SECURITY.md SSRF row, API-EVENT-SPEC
// §9). Unit level with an injected fetch and DNS resolver: nothing reaches the network.
import { describe, expect, it, vi } from 'vitest';
import {
  HttpsProviderTransport,
  ProviderEgressError,
  guardedLookup,
  assertProviderUrlAllowed,
  assertResolvesPublic,
  endpointPolicyDigest,
  isNonPublicAddress,
  type EndpointPolicy,
  type PinnedRevision,
} from '../src/index.js';

const policy: EndpointPolicy = { schema: 'provider-endpoint-policy.v1', origins: ['https://api.coldline.example'] };
const revision = (digest = endpointPolicyDigest(policy)): PinnedRevision => ({
  providerAccountId: 'pac_fixture-0001',
  providerAccountRevisionId: 'par_fixture-0001',
  providerKey: 'coldline-dispatch',
  environment: 'SANDBOX',
  capabilities: ['SEARCH'],
  endpointPolicyDigest: digest,
});
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as ProviderEgressError).reasonCode;
  }
  return 'ALLOWED';
};
const call = (t: HttpsProviderTransport, path = '/v1/providers', rev = revision()) =>
  t.request(
    {
      method: 'GET',
      path,
      query: {},
      headers: {},
      body: null,
      context: { providerAccountRevisionId: rev.providerAccountRevisionId, providerKey: 'coldline-dispatch' },
    },
    {
      signal: new AbortController().signal,
      revision: rev,
      credential: async () => new Uint8Array(32),
      onSent: () => {},
    },
  );
/** Injected requester (no sockets): records what the transport asked for and replies with `status`/`text`. */
const requester = (status: number, text = '{"ok":true}', headers: Record<string, string> = {}) =>
  vi.fn(async (_url: URL, _init: unknown) => ({
    status,
    headers,
    body: (async function* () {
      yield Buffer.from(text);
    })(),
  }));

describe('T-029 provider egress SSRF guard', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.9',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '198.51.100.7',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:a9fe:a9fe',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '2001:db8::1',
    '64:ff9b::7f00:1',
    'not-an-ip',
  ])('refuses non-public address %s', (ip) => {
    expect(isNonPublicAddress(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '2606:4700:4700::1111', '8.8.8.8'])('allows public address %s', (ip) => {
    expect(isNonPublicAddress(ip)).toBe(false);
  });

  it.each([
    ['http://api.coldline.example/v1', 'SCHEME_REFUSED'],
    ['https://user:pw@api.coldline.example/v1', 'USERINFO_REFUSED'],
    ['https://127.0.0.1/v1', 'IP_LITERAL_REFUSED'],
    ['https://2130706433/v1', 'IP_LITERAL_REFUSED'],
    ['https://[::1]/v1', 'IP_LITERAL_REFUSED'],
    ['https://localhost/v1', 'INTERNAL_HOST_REFUSED'],
    ['https://metadata.internal/v1', 'INTERNAL_HOST_REFUSED'],
    ['https://api.coldline.example.attacker.example/v1', 'ORIGIN_NOT_ALLOWLISTED'],
    ['https://api.coldline.example:8443/v1', 'ORIGIN_NOT_ALLOWLISTED'],
    ['https://api.coldline.example/v1/%2e%2e/admin', 'PATH_REFUSED'],
    ['https://api.coldline.example/v1#frag', 'URL_INVALID'],
    ['file:///etc/passwd', 'SCHEME_REFUSED'],
  ])('refuses %s', (url, code) => {
    expect(reason(() => assertProviderUrlAllowed(url, policy))).toBe(code);
  });

  it('allows exactly the allowlisted origin', () => {
    expect(reason(() => assertProviderUrlAllowed('https://api.coldline.example/v1/providers?kind=X', policy))).toBe(
      'ALLOWED',
    );
  });

  it('refuses a host whose DNS resolves to any non-public address (fail closed on resolution failure)', async () => {
    await expect(
      assertResolvesPublic('api.coldline.example', async () => ['93.184.216.34', '10.0.0.5']),
    ).rejects.toMatchObject({
      reasonCode: 'NON_PUBLIC_ADDRESS_REFUSED',
    });
    await expect(assertResolvesPublic('api.coldline.example', async () => [])).rejects.toMatchObject({
      reasonCode: 'DNS_RESOLUTION_FAILED',
    });
    await expect(
      assertResolvesPublic('api.coldline.example', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toMatchObject({ reasonCode: 'DNS_RESOLUTION_FAILED' });
  });

  it('the live transport binds its allowlist to the revision, refuses redirects, private DNS, unsafe paths and oversized bodies', async () => {
    const ok = requester(200);
    const pub = async () => ['93.184.216.34'];
    const t = new HttpsProviderTransport(policy, pub, ok as never);
    await expect(call(t, '/v1/providers', revision(`sha256:${'0'.repeat(64)}`))).rejects.toMatchObject({
      reasonCode: 'ENDPOINT_POLICY_NOT_BOUND_TO_REVISION',
    });
    await expect(call(t, '/v1/../admin')).rejects.toMatchObject({ reasonCode: 'PATH_REFUSED' });
    await expect(call(t, '//attacker.example/x')).rejects.toMatchObject({ reasonCode: 'PATH_REFUSED' });
    expect(ok).not.toHaveBeenCalled();
    await expect(
      call(new HttpsProviderTransport(policy, async () => ['169.254.169.254'], ok as never)),
    ).rejects.toMatchObject({
      reasonCode: 'NON_PUBLIC_ADDRESS_REFUSED',
    });
    expect(ok).not.toHaveBeenCalled();
    await expect(
      call(
        new HttpsProviderTransport(policy, pub, requester(302, '', { location: 'http://169.254.169.254/' }) as never),
      ),
    ).rejects.toMatchObject({ reasonCode: 'REDIRECT_REFUSED' });
    await expect(
      call(new HttpsProviderTransport(policy, pub, requester(200, 'x'.repeat(300 * 1024)) as never)),
    ).rejects.toMatchObject({
      reasonCode: 'RESPONSE_TOO_LARGE',
    });
    const res = await call(t);
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    const [url, init] = ok.mock.calls[0] as unknown as [URL, { lookup: unknown; headers: Record<string, string> }];
    expect(url.origin).toBe('https://api.coldline.example');
    // The connection itself uses the guarded resolver (DNS rebinding cannot bypass the pre-check).
    expect(typeof init.lookup).toBe('function');
  });

  it('DNS rebinding: a resolver that answers public then private is refused at connect time (no socket opened)', async () => {
    let n = 0;
    const rebinding = async () => (++n === 1 ? ['93.184.216.34'] : ['10.0.0.5']);
    // Default requester = node:https with the guarded lookup; the connect-time lookup refuses before any TCP connect.
    const t = new HttpsProviderTransport(policy, rebinding);
    await expect(call(t)).rejects.toMatchObject({ reasonCode: 'NON_PUBLIC_ADDRESS_REFUSED' });
    expect(n).toBe(2);
  });

  it('the guarded lookup refuses any non-public address in every resolution and returns only checked addresses', async () => {
    const lookupOf = (addrs: string[]) => guardedLookup(async () => addrs);
    const run = (l: ReturnType<typeof guardedLookup>, all: boolean) =>
      new Promise<{ err: unknown; addr: unknown }>((resolve) =>
        (l as unknown as (h: string, o: object, cb: (e: unknown, a?: unknown) => void) => void)(
          'api.coldline.example',
          { all },
          (err, addr) => resolve({ err, addr }),
        ),
      );
    expect((await run(lookupOf(['93.184.216.34', '::ffff:127.0.0.1']), true)).err).toMatchObject({
      reasonCode: 'NON_PUBLIC_ADDRESS_REFUSED',
    });
    expect((await run(lookupOf([]), false)).err).toMatchObject({ reasonCode: 'DNS_RESOLUTION_FAILED' });
    const good = await run(lookupOf(['93.184.216.34']), true);
    expect(good.err).toBeNull();
    expect(good.addr).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('rejects endpoint policies that are not plain HTTPS origins', () => {
    for (const origins of [
      ['http://api.coldline.example'],
      ['https://api.coldline.example/path'],
      ['https://10.0.0.1'],
      [],
    ])
      expect(reason(() => endpointPolicyDigest({ schema: 'provider-endpoint-policy.v1', origins }))).not.toBe(
        'ALLOWED',
      );
  });
});
