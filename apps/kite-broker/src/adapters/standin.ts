// LOCAL_STAND_IN paid-endpoint adapter (credential-bearing; lives only in the broker). It talks HTTPS to the local
// stand-in with a pinned server certificate fingerprint, a broker client certificate and a bearer capability — the
// F0-proven isolation mechanism. The base URL comes only from the broker's secret configuration and must be a
// loopback HTTPS origin; no URL from a request, model or provider is ever fetched, redirects are never followed and
// proxy environment variables are ignored (agent: false, explicit host/port). Errors are mapped to reason codes; no
// raw error text, header or credential leaves this module.
import https from 'node:https';
import { createHash } from 'node:crypto';
import { canonicalize } from '@uptimebuyer/domain';
import type {
  AdapterOutcome,
  AuthorizedIntent,
  AuthorizedSessionScope,
  CapabilityAssessment,
  ClientOperation,
  PaidAdapter,
  PreparedRequest,
  ProviderReturn,
  ReconciliationCapability,
  ReconciliationLocator,
  SendHooks,
} from './port.js';
import { unsupported } from './port.js';

export interface StandInCredential {
  baseUrl: string;
  serverCertFingerprint256: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  capability: string;
}

export interface StandInOptions {
  adapterId?: string;
  capability: ReconciliationCapability;
  timeoutMs: number;
}

const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const nowIso = () => new Date().toISOString();

export function assertLoopbackHttps(baseUrl: string): URL {
  const u = new URL(baseUrl);
  if (u.protocol !== 'https:' || !['127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password || u.search)
    throw new Error('LOCAL_STAND_IN base URL must be a loopback https origin');
  return u;
}

type Reply = { status: number; body: Record<string, unknown> | null; digest: string | null } | { lost: string };

export class LocalStandInAdapter implements PaidAdapter {
  readonly adapterId: string;
  readonly resultOrigin = 'LOCAL_STAND_IN' as const;
  readonly capability: ReconciliationCapability;
  readonly #cred: StandInCredential;
  readonly #url: URL;
  readonly #timeoutMs: number;

  constructor(credential: StandInCredential, opts: StandInOptions) {
    this.#url = assertLoopbackHttps(credential.baseUrl);
    this.#cred = Object.freeze({ ...credential });
    this.capability = Object.freeze({ ...opts.capability });
    this.#timeoutMs = opts.timeoutMs;
    this.adapterId = opts.adapterId ?? 'local-stand-in';
  }

  /** Never serialise the credential (logs, errors, JSON dumps of the adapter). */
  toJSON() {
    return { adapterId: this.adapterId, resultOrigin: this.resultOrigin };
  }

  assess(_intent: AuthorizedIntent): CapabilityAssessment {
    return this.capability.lookupByClientOperation || this.capability.sameKeyReplay
      ? { kind: 'ELIGIBLE' }
      : { kind: 'UNSUPPORTED', reasonCode: 'NO_AUTHORITATIVE_RECONCILIATION' };
  }
  assessSession(_scope: AuthorizedSessionScope): CapabilityAssessment {
    return { kind: 'ELIGIBLE' };
  }

  prepare(intent: AuthorizedIntent): PreparedRequest {
    const body = {
      merchantId: intent.merchantId,
      purpose: intent.purpose,
      amountMinor: intent.amountMinor.toString(),
      currency: intent.currency,
      operation: intent.semanticOperation,
    };
    return { requestDigest: sha(canonicalize(body)), body };
  }

  async execute(request: PreparedRequest, op: ClientOperation, hooks: SendHooks): Promise<AdapterOutcome> {
    const r = await this.call(
      'POST',
      '/v1/payments',
      { ...request.body, clientOperationId: op.clientOperationId },
      op,
      hooks,
    );
    return this.paymentOutcome(r);
  }

  async lookup(locator: ReconciliationLocator): Promise<AdapterOutcome> {
    const r = await this.call(
      'GET',
      `/v1/payments/by-key/${encodeURIComponent(locator.idempotencyKey)}`,
      null,
      null,
      null,
    );
    if ('lost' in r) return this.unknown(r.lost);
    if (r.status === 501) return unsupported('LOOKUP_NOT_SUPPORTED_BY_PROVIDER');
    return this.paymentOutcome(r);
  }

  async activateSession(scope: AuthorizedSessionScope, op: ClientOperation, hooks: SendHooks): Promise<AdapterOutcome> {
    const r = await this.call(
      'POST',
      '/v1/sessions',
      {
        executionAuthorityId: scope.executionAuthorityId,
        merchantId: scope.merchantId,
        purpose: scope.purpose,
        perActionLimitMinor: scope.perActionLimitMinor.toString(),
        baseLimitMinor: scope.baseLimitMinor.toString(),
        currency: scope.currency,
        expiresAt: scope.expiresAt,
        clientOperationId: op.clientOperationId,
      },
      op,
      hooks,
    );
    return this.sessionOutcome(r);
  }

  async lookupSession(locator: ReconciliationLocator): Promise<AdapterOutcome> {
    const r = await this.call(
      'GET',
      `/v1/sessions/by-key/${encodeURIComponent(locator.idempotencyKey)}`,
      null,
      null,
      null,
    );
    return this.sessionOutcome(r);
  }

  private sessionOutcome(r: Reply): AdapterOutcome {
    if ('lost' in r) return this.unknown(r.lost);
    const status = String(r.body?.status ?? '');
    const ref = typeof r.body?.sessionRef === 'string' ? r.body.sessionRef : null;
    const obs = {
      rawProviderStatus: status.slice(0, 64) || `http_${r.status}`,
      rawResponseDigest: r.digest,
      observedAt: nowIso(),
    };
    if (r.status === 200 && status === 'active')
      return { kind: 'CONFIRMED', providerRef: ref, capturedMinor: 0n, returns: [], ...obs };
    if (r.status === 202 && status === 'pending') return { kind: 'ACCEPTED', providerRef: ref, ...obs };
    if (r.status === 404 && status === 'not_found_fenced')
      return { kind: 'FAILED', reasonCode: 'SESSION_NOT_FOUND_FENCED', effect: 'NO_EFFECT_PROVED', ...obs };
    if (r.status === 409 && status === 'declined')
      return { kind: 'FAILED', reasonCode: 'SESSION_DECLINED', effect: 'NO_EFFECT_PROVED', ...obs };
    return { kind: 'UNKNOWN', providerRef: ref, reasonCode: 'UNRECOGNISED_PROVIDER_RESPONSE', ...obs };
  }

  private paymentOutcome(r: Reply): AdapterOutcome {
    if ('lost' in r) return this.unknown(r.lost);
    const b = r.body ?? {};
    const status = String(b.status ?? '');
    const ref = typeof b.paymentRef === 'string' && /^[\x21-\x7E]{1,128}$/.test(b.paymentRef) ? b.paymentRef : null;
    const obs = {
      rawProviderStatus: status.slice(0, 64) || `http_${r.status}`,
      rawResponseDigest: r.digest,
      observedAt: nowIso(),
    };
    if (r.status === 200 && status === 'settled') {
      const captured = /^[0-9]{1,18}$/.test(String(b.amountMinor)) ? BigInt(String(b.amountMinor)) : -1n;
      if (captured < 0n) return { kind: 'UNKNOWN', providerRef: ref, reasonCode: 'UNREADABLE_AMOUNT', ...obs };
      const returns: ProviderReturn[] = [];
      for (const x of Array.isArray(b.returns) ? b.returns.slice(0, 100) : []) {
        const id = String((x as Record<string, unknown>).id ?? '');
        const amt = String((x as Record<string, unknown>).amountMinor ?? '');
        const kind = (x as Record<string, unknown>).kind;
        if (
          !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
          !/^[0-9]{1,18}$/.test(amt) ||
          (kind !== 'REFUND' && kind !== 'REVERSAL')
        )
          return { kind: 'UNKNOWN', providerRef: ref, reasonCode: 'UNREADABLE_RETURN', ...obs };
        returns.push({ kind, providerEventId: id, amountMinor: BigInt(amt) });
      }
      return { kind: 'CONFIRMED', providerRef: ref, capturedMinor: captured, returns, ...obs };
    }
    if (r.status === 202 && status === 'accepted') return { kind: 'ACCEPTED', providerRef: ref, ...obs };
    if ((r.status === 402 || r.status === 409) && (status === 'declined' || status === 'key_fenced'))
      return {
        kind: 'FAILED',
        reasonCode: status === 'declined' ? 'PROVIDER_DECLINED' : 'KEY_FENCED_NO_EFFECT',
        effect: 'NO_EFFECT_PROVED',
        ...obs,
      };
    if (r.status === 404 && status === 'not_found_fenced')
      return { kind: 'FAILED', reasonCode: 'NOT_FOUND_KEY_FENCED', effect: 'NO_EFFECT_PROVED', ...obs };
    if (r.status === 200 && status === 'cancelled') return { kind: 'CANCELLED', providerRef: ref, ...obs };
    return { kind: 'UNKNOWN', providerRef: ref, reasonCode: 'UNRECOGNISED_PROVIDER_RESPONSE', ...obs };
  }

  private unknown(reasonCode: string): AdapterOutcome {
    return {
      kind: 'UNKNOWN',
      providerRef: null,
      reasonCode,
      rawProviderStatus: null,
      rawResponseDigest: null,
      observedAt: nowIso(),
    };
  }

  private call(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, string> | null,
    op: ClientOperation | null,
    hooks: SendHooks | null,
  ): Promise<Reply> {
    const payload = body ? JSON.stringify(body) : '';
    const pin = this.#cred.serverCertFingerprint256;
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: Reply) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const req = https.request({
        host: this.#url.hostname.replace(/^\[|\]$/g, ''),
        port: Number(this.#url.port || 443),
        path,
        method,
        agent: false,
        ca: this.#cred.caCert,
        cert: this.#cred.clientCert,
        key: this.#cred.clientKey,
        servername: undefined,
        timeout: this.#timeoutMs,
        checkServerIdentity: (_host, cert) =>
          cert.fingerprint256 === pin ? undefined : new Error('server certificate pin mismatch'),
        headers: {
          authorization: `Bearer ${this.#cred.capability}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(op ? { 'idempotency-key': op.idempotencyKey, 'x-request-digest': op.requestDigest } : {}),
        },
      });
      req.on('finish', () => hooks?.onHandoff());
      req.on('timeout', () => {
        req.destroy();
        done({ lost: 'TIMEOUT' });
      });
      req.on('error', () => done({ lost: 'TRANSPORT_LOST' }));
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (d: Buffer) => {
          size += d.length;
          if (size > 64 * 1024) {
            req.destroy();
            done({ lost: 'RESPONSE_TOO_LARGE' });
          } else chunks.push(d);
        });
        res.on('error', () => done({ lost: 'TRANSPORT_LOST' }));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let parsed: Record<string, unknown> | null;
          try {
            parsed = raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : null;
          } catch {
            parsed = null;
          }
          done({ status: res.statusCode ?? 0, body: parsed, digest: raw.length ? sha(raw) : null });
        });
      });
      req.end(payload);
    });
  }
}
