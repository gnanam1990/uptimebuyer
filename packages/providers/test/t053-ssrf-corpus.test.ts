// T-053 SSRF corpus for provider egress (SECURITY.md §6). Extends T-029 with encoding tricks: numeric/octal/hex IPv4
// forms, IPv4-mapped/compatible IPv6, trailing dots, IDN homographs, userinfo smuggling, backslashes, encoded traversal
// and DNS answers that rebind to metadata or private ranges. Unit level: nothing reaches the network.
import { describe, expect, it } from 'vitest';
import {
  assertProviderUrlAllowed,
  assertResolvesPublic,
  guardedLookup,
  isNonPublicAddress,
  type EndpointPolicy,
  type ProviderEgressError,
} from '../src/index.js';

const policy: EndpointPolicy = { schema: 'provider-endpoint-policy.v1', origins: ['https://api.coldline.example'] };
const refused = (url: string) => {
  try {
    assertProviderUrlAllowed(url, policy);
    return null;
  } catch (e) {
    return (e as ProviderEgressError).reasonCode;
  }
};

describe('T-053 provider SSRF corpus', () => {
  it.each([
    'https://0177.0.0.1/v1',
    'https://0x7f.0.0.1/v1',
    'https://0x7f000001/v1',
    'https://017700000001/v1',
    'https://2852039166/v1',
    'https://[::ffff:169.254.169.254]/v1',
    'https://[::ffff:a9fe:a9fe]/v1',
    'https://[0:0:0:0:0:ffff:7f00:1]/v1',
    'https://[::127.0.0.1]/v1',
    'https://[fd00:ec2::254]/v1',
    'https://api.coldline.example.attacker.example/v1',
    'https://api.coldline.example@169.254.169.254/v1',
    'https://api.coldline.example%40169.254.169.254/v1',
    'https://169.254.169.254\\@api.coldline.example/v1',
    'https://аpi.coldline.example/v1',
    'https://api.coldline.example./v1',
    'https://API.COLDLINE.EXAMPLE:443@evil.example/v1',
    'https://metadata.google.internal/computeMetadata/v1',
    'https://kubernetes.default.svc.cluster.local/api',
    'https://api.coldline.example/v1/%2E%2E/%2E%2E/admin',
    'https://api.coldline.example/v1/..%2Fadmin',
    'https://api.coldline.example/v1\\..\\admin',
    'http://api.coldline.example/v1',
    'ftp://api.coldline.example/v1',
    'data:text/plain,hello',
    'javascript:alert(1)',
  ])('refuses %s', (url) => {
    expect(refused(url)).not.toBeNull();
  });

  it.each([
    '0177.0.0.1',
    '127.1',
    '0x7f.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:a9fe:a9fe',
    '::a9fe:a9fe',
    'fd00:ec2::254',
    'fe80::a9fe:a9fe%eth0',
    '100.100.100.200',
    '198.18.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '2002:a9fe:a9fe::1',
  ])('treats %s as non-public', (ip) => {
    expect(isNonPublicAddress(ip)).toBe(true);
  });

  it('refuses DNS answers that rebind to metadata or private ranges at pre-check and at connect time', async () => {
    for (const answer of [['169.254.169.254'], ['93.184.216.34', '::ffff:10.0.0.1'], ['fd00:ec2::254']]) {
      await expect(assertResolvesPublic('api.coldline.example', async () => answer)).rejects.toMatchObject({
        reasonCode: 'NON_PUBLIC_ADDRESS_REFUSED',
      });
      const err = await new Promise<Error | null>((resolve) =>
        guardedLookup(async () => answer)('api.coldline.example', { all: true }, (e) => resolve(e)),
      );
      expect((err as ProviderEgressError | null)?.reasonCode).toBe('NON_PUBLIC_ADDRESS_REFUSED');
    }
    // A rebinding resolver that answers public first and private second is refused on the connect-time lookup.
    let n = 0;
    const rebinding = async () => (n++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']);
    await expect(assertResolvesPublic('api.coldline.example', rebinding)).resolves.toBeUndefined();
    const err = await new Promise<Error | null>((resolve) =>
      guardedLookup(rebinding)('api.coldline.example', {}, (e) => resolve(e)),
    );
    expect((err as ProviderEgressError | null)?.reasonCode).toBe('NON_PUBLIC_ADDRESS_REFUSED');
  });
});
