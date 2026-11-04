// Outbound provider egress (SECURITY.md SSRF row, API-EVENT-SPEC §9). Adapters reach only allowlisted HTTPS origins
// that are bound into the immutable account revision by `endpoint_policy_digest`; URLs from provider, model or
// retrieved content are never fetch targets. Every live request is checked for scheme, userinfo, IP-literal and
// internal host names, DNS-resolved addresses (private, loopback, link-local, metadata, CGNAT, multicast and
// documentation ranges are refused), redirects (refused), response size and time.
import { isIP } from 'node:net';
import { canonicalize } from '@uptimebuyer/domain';
import { sha256Digest } from '@uptimebuyer/data';
import { ADAPTER_BOUNDS, type AdapterClass, type PinnedRevision, type UnpaidCredential } from './ports.js';

export interface EndpointPolicy {
  readonly schema: 'provider-endpoint-policy.v1';
  /** Exact HTTPS origins (scheme + host [+ port]); no paths, no wildcards. */
  readonly origins: readonly string[];
}

export class ProviderEgressError extends Error {
  constructor(readonly reasonCode: string) {
    super('Provider egress refused.');
    this.name = 'ProviderEgressError';
  }
}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];

function normalizeOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ProviderEgressError('ENDPOINT_POLICY_INVALID');
  }
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.pathname !== '/' && u.pathname !== '')
  )
    throw new ProviderEgressError('ENDPOINT_POLICY_INVALID');
  assertHostName(u.hostname);
  return u.origin;
}

function assertHostName(host: string): void {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') || isIP(h) !== 0) throw new ProviderEgressError('IP_LITERAL_REFUSED');
  if (h === 'localhost' || !h.includes('.') || INTERNAL_SUFFIXES.some((s) => h.endsWith(s)))
    throw new ProviderEgressError('INTERNAL_HOST_REFUSED');
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h))
    throw new ProviderEgressError('HOST_INVALID');
}

/** Digest bound into provider_account_revisions.endpoint_policy_digest; a policy change is a new revision. */
export function endpointPolicyDigest(policy: EndpointPolicy): string {
  if (policy.schema !== 'provider-endpoint-policy.v1' || policy.origins.length < 1 || policy.origins.length > 8)
    throw new ProviderEgressError('ENDPOINT_POLICY_INVALID');
  const origins = [...new Set(policy.origins.map(normalizeOrigin))].sort();
  return sha256Digest(canonicalize({ schema: policy.schema, origins }));
}

/** Synchronous URL checks: exact allowlisted HTTPS origin, safe path, no credentials or fragments. */
export function assertProviderUrlAllowed(raw: string, policy: EndpointPolicy): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ProviderEgressError('URL_INVALID');
  }
  if (u.protocol !== 'https:') throw new ProviderEgressError('SCHEME_REFUSED');
  if (u.username || u.password) throw new ProviderEgressError('USERINFO_REFUSED');
  if (u.hash) throw new ProviderEgressError('URL_INVALID');
  assertHostName(u.hostname);
  const allowed = new Set(policy.origins.map(normalizeOrigin));
  if (!allowed.has(u.origin)) throw new ProviderEgressError('ORIGIN_NOT_ALLOWLISTED');
  if (/%2e|%2f|%5c|\\|\/\.\.?(\/|$)/i.test(raw.slice(u.origin.length))) throw new ProviderEgressError('PATH_REFUSED');
  return u;
}

const v4 = (ip: string) => ip.split('.').map(Number) as [number, number, number, number];
const inV4 = (ip: string, base: string, bits: number) => {
  const toInt = (x: string) => v4(x).reduce((a, o) => (a << 8) + o, 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
};
const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  if (s.slice(lastColon + 1).includes('.')) {
    const q = v4(s.slice(lastColon + 1));
    tail = [(q[0] << 8) | q[1], (q[2] << 8) | q[3]];
    s = `${s.slice(0, lastColon)}:0:0`;
  }
  const [head, rest] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const r = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const fill = rest === undefined ? 0 : 8 - h.length - r.length;
  if (fill < 0) return null;
  const groups = [...h, ...Array(fill).fill('0'), ...r].map((g) => parseInt(g || '0', 16));
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True for any address an adapter must never reach (non-public, metadata, mapped or special-purpose). */
export function isNonPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return PRIVATE_V4.some(([b, n]) => inV4(ip, b, n)) || ip === '255.255.255.255';
  if (kind !== 6) return true;
  const g = expandV6(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const mapped = `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
    return isNonPublicAddress(mapped); // IPv4-mapped / -compatible
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return true; // 6to4 can embed private v4
  return false;
}

export type DnsResolver = (host: string) => Promise<readonly string[]>;

/** Every resolved address must be public; an empty or failed resolution is refused (fail closed). */
export async function assertResolvesPublic(host: string, resolve: DnsResolver): Promise<void> {
  let addrs: readonly string[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new ProviderEgressError('DNS_RESOLUTION_FAILED');
  }
  if (addrs.length === 0) throw new ProviderEgressError('DNS_RESOLUTION_FAILED');
  if (addrs.some(isNonPublicAddress)) throw new ProviderEgressError('NON_PUBLIC_ADDRESS_REFUSED');
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP transport port

export interface ProviderHttpRequest {
  readonly method: 'GET' | 'POST';
  /** Absolute path below the allowlisted origin. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly context: { readonly providerAccountRevisionId: string; readonly providerKey: string };
}

export interface ProviderHttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface TransportCallOptions {
  readonly signal: AbortSignal;
  readonly revision: PinnedRevision;
  readonly credential: UnpaidCredential;
  /** Called once the request has been handed to the network boundary. */
  readonly onSent: () => void;
}

export interface ProviderHttpTransport {
  readonly adapterClass: AdapterClass;
  request(req: ProviderHttpRequest, opts: TransportCallOptions): Promise<ProviderHttpResponse>;
}

/** Throws ProviderEgressError('PATH_REFUSED') unless `path` is a plain absolute path. */
export function assertSafePath(path: string): void {
  if (!/^\/[A-Za-z0-9._~\-/]{0,400}$/.test(path) || /\/\.\.?(\/|$)/.test(path) || path.includes('//'))
    throw new ProviderEgressError('PATH_REFUSED');
}

/**
 * LIVE transport over fetch. Configured only by the deployment for an M07-owned unpaid account; never used in tests
 * (no network in CI). The endpoint policy must hash to the pinned revision's endpoint_policy_digest.
 */
export class FetchProviderTransport implements ProviderHttpTransport {
  readonly adapterClass = 'LIVE' as const;
  private readonly origin: string;
  constructor(
    private readonly policy: EndpointPolicy,
    private readonly resolve: DnsResolver,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.origin = normalizeOrigin(policy.origins[0] ?? '');
  }

  async request(req: ProviderHttpRequest, opts: TransportCallOptions): Promise<ProviderHttpResponse> {
    if (endpointPolicyDigest(this.policy) !== opts.revision.endpointPolicyDigest)
      throw new ProviderEgressError('ENDPOINT_POLICY_NOT_BOUND_TO_REVISION');
    assertSafePath(req.path);
    const url = new URL(req.path, this.origin);
    for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);
    assertProviderUrlAllowed(url.toString(), this.policy);
    await assertResolvesPublic(url.hostname, this.resolve);
    const key = await opts.credential();
    if (!key) throw new ProviderEgressError('CREDENTIAL_UNAVAILABLE');
    opts.onSent();
    const res = await this.fetchImpl(url, {
      method: req.method,
      redirect: 'manual',
      signal: opts.signal,
      headers: {
        ...req.headers,
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${Buffer.from(key).toString('base64url')}`,
      },
      ...(req.body === null || req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    });
    if (res.status >= 300 && res.status < 400) throw new ProviderEgressError('REDIRECT_REFUSED');
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > ADAPTER_BOUNDS.maxResponseBytes) {
          await reader.cancel().catch(() => {});
          throw new ProviderEgressError('RESPONSE_TOO_LARGE');
        }
        chunks.push(value);
      }
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const headers: Record<string, string> = {};
    const ra = res.headers.get('retry-after');
    if (ra) headers['retry-after'] = ra;
    return { status: res.status, headers, body };
  }
}
