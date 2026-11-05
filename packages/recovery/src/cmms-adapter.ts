// CMMS record signatures and the CMMS adapter port (FR-17, NFR-11, INV-12).
// Inbound: a CMMS integration signs each record with HMAC-SHA256 over `cmms-record.v1\n<unix seconds>\n<raw bytes>`
// using the per-integration verifier key; the header is `t=<seconds>,v1=<hex>`; tolerance 300 s; keys >= 32 bytes.
// Outbound: adapters write one work-order update per idempotency key. The contract fake (label CONTRACT_FAKE) applies
// each key at most once and supports lookup after an ambiguous timeout; it is never presented as a real CMMS. The real
// HTTPS adapter is environment-gated and reports UNSUPPORTED without credentials; nothing here has contacted one.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const CMMS_RECORD_LIMITS = Object.freeze({
  maxBodyBytes: 64 * 1024,
  toleranceSeconds: 300,
  minVerifierKeyBytes: 32,
});

const mac = (key: Uint8Array, timestampSec: number, rawBody: Uint8Array) =>
  createHmac('sha256', key).update(`cmms-record.v1\n${timestampSec}\n`, 'utf8').update(rawBody).digest();

export function signCmmsRecord(key: Uint8Array, timestampSec: number, rawBody: Uint8Array): string {
  return `t=${timestampSec},v1=${mac(key, timestampSec, rawBody).toString('hex')}`;
}

export type CmmsSignatureCheck =
  | { ok: true; timestampSec: number }
  | {
      ok: false;
      reasonCode:
        'SIGNATURE_MALFORMED' | 'SIGNATURE_MISMATCH' | 'TIMESTAMP_OUT_OF_TOLERANCE' | 'VERIFIER_KEY_TOO_SHORT';
    };

export function verifyCmmsSignature(
  key: Uint8Array,
  header: string,
  rawBody: Uint8Array,
  nowSec: number,
): CmmsSignatureCheck {
  if (!(key instanceof Uint8Array) || key.byteLength < CMMS_RECORD_LIMITS.minVerifierKeyBytes)
    return { ok: false, reasonCode: 'VERIFIER_KEY_TOO_SHORT' };
  const m = typeof header === 'string' ? /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header) : null;
  if (!m) return { ok: false, reasonCode: 'SIGNATURE_MALFORMED' };
  const ts = Number(m[1]);
  if (Math.abs(nowSec - ts) > CMMS_RECORD_LIMITS.toleranceSeconds)
    return { ok: false, reasonCode: 'TIMESTAMP_OUT_OF_TOLERANCE' };
  const want = mac(key, ts, rawBody);
  const got = Buffer.from(m[2]!, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reasonCode: 'SIGNATURE_MISMATCH' };
  return { ok: true, timestampSec: ts };
}

export interface CmmsWorkOrderUpdate {
  readonly idempotencyKey: string;
  readonly tenantId: string;
  readonly incidentId: string;
  /** The CMMS work order is keyed by the UptimeBuyer incident id. */
  readonly workOrderKey: string;
  readonly updateKind: string;
  readonly payload: Record<string, unknown>;
  readonly payloadDigest: string;
}

export type CmmsWriteOutcome =
  | { outcome: 'CONFIRMED'; externalUpdateRef: string }
  | { outcome: 'UNKNOWN' | 'FAILED' | 'UNSUPPORTED'; reasonCode: string };
export type CmmsLookupOutcome = CmmsWriteOutcome | { outcome: 'NOT_FOUND' };

export interface CmmsAdapter {
  readonly adapterKind: 'CONTRACT_FAKE' | 'HTTPS_CMMS';
  /** CONTRACT_FAKE results are never real-world evidence. */
  readonly label: 'CONTRACT_FAKE' | 'LIVE';
  capability(): 'ELIGIBLE' | 'UNSUPPORTED';
  /** Apply the update under its idempotency key; same key + same payload is a replay of the same update. */
  write(update: CmmsWorkOrderUpdate): Promise<CmmsWriteOutcome>;
  /** Authoritative lookup by idempotency key (used after an ambiguous outcome or a crash after send). */
  lookup(idempotencyKey: string): Promise<CmmsLookupOutcome>;
}

type FakeFailure = 'TIMEOUT_BEFORE_APPLY' | 'TIMEOUT_AFTER_APPLY' | 'REJECT';

/** In-memory CMMS contract fake (label CONTRACT_FAKE): one applied update per idempotency key. */
export class ContractFakeCmmsAdapter implements CmmsAdapter {
  readonly adapterKind = 'CONTRACT_FAKE' as const;
  readonly label = 'CONTRACT_FAKE' as const;
  private readonly applied = new Map<string, { digest: string; ref: string; update: CmmsWorkOrderUpdate }>();
  private readonly failures: FakeFailure[] = [];
  writeCalls = 0;

  capability(): 'ELIGIBLE' {
    return 'ELIGIBLE';
  }
  failNext(mode: FakeFailure): void {
    this.failures.push(mode);
  }
  appliedCount(): number {
    return this.applied.size;
  }
  workOrders(): CmmsWorkOrderUpdate[] {
    return [...this.applied.values()].map((v) => v.update);
  }
  async write(update: CmmsWorkOrderUpdate): Promise<CmmsWriteOutcome> {
    this.writeCalls++;
    const failure = this.failures.shift();
    if (failure === 'TIMEOUT_BEFORE_APPLY') return { outcome: 'UNKNOWN', reasonCode: 'CMMS_TIMEOUT' };
    if (failure === 'REJECT') return { outcome: 'FAILED', reasonCode: 'CMMS_REJECTED' };
    const prior = this.applied.get(update.idempotencyKey);
    let result: CmmsWriteOutcome;
    if (prior) {
      result =
        prior.digest === update.payloadDigest
          ? { outcome: 'CONFIRMED', externalUpdateRef: prior.ref }
          : { outcome: 'FAILED', reasonCode: 'IDEMPOTENCY_KEY_REUSED' };
    } else {
      const ref = `fake-wou-${randomUUID()}`;
      this.applied.set(update.idempotencyKey, { digest: update.payloadDigest, ref, update });
      result = { outcome: 'CONFIRMED', externalUpdateRef: ref };
    }
    if (failure === 'TIMEOUT_AFTER_APPLY') return { outcome: 'UNKNOWN', reasonCode: 'CMMS_TIMEOUT' };
    return result;
  }
  async lookup(idempotencyKey: string): Promise<CmmsLookupOutcome> {
    const prior = this.applied.get(idempotencyKey);
    return prior ? { outcome: 'CONFIRMED', externalUpdateRef: prior.ref } : { outcome: 'NOT_FOUND' };
  }
}

const UNSUPPORTED = { outcome: 'UNSUPPORTED', reasonCode: 'CMMS_CREDENTIALS_ABSENT' } as const;

/**
 * Real CMMS adapter shape (HTTPS, bearer token, Idempotency-Key header, no redirects, bounded timeout). Enabled only
 * when UB_CMMS_BASE_URL is an https: URL AND UB_CMMS_TOKEN is present (>= 32 chars); otherwise UNSUPPORTED. NOT_RUN:
 * no real CMMS has been contacted from this repository.
 */
export class HttpsCmmsAdapter implements CmmsAdapter {
  readonly adapterKind = 'HTTPS_CMMS' as const;
  readonly label = 'LIVE' as const;
  private constructor(private readonly cfg: { baseUrl: URL; token: string; timeoutMs: number } | null) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): HttpsCmmsAdapter {
    const base = env.UB_CMMS_BASE_URL;
    const token = env.UB_CMMS_TOKEN;
    if (!base || !token || token.length < 32) return new HttpsCmmsAdapter(null);
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      return new HttpsCmmsAdapter(null);
    }
    if (url.protocol !== 'https:' || url.username || url.password) return new HttpsCmmsAdapter(null);
    return new HttpsCmmsAdapter({ baseUrl: url, token, timeoutMs: 10_000 });
  }

  /** M14: build from a base URL and a token read from a secret file (the worker never reads the token from env). */
  static fromToken(baseUrl: string, token: string): HttpsCmmsAdapter {
    return HttpsCmmsAdapter.fromEnv({ UB_CMMS_BASE_URL: baseUrl, UB_CMMS_TOKEN: token });
  }

  capability(): 'ELIGIBLE' | 'UNSUPPORTED' {
    return this.cfg ? 'ELIGIBLE' : 'UNSUPPORTED';
  }

  private async call(method: 'POST' | 'GET', path: string, key: string, body?: unknown): Promise<Response | null> {
    const cfg = this.cfg!;
    try {
      return await fetch(new URL(path, cfg.baseUrl), {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(cfg.timeoutMs),
        headers: {
          authorization: `Bearer ${cfg.token}`,
          'idempotency-key': key,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return null;
    }
  }

  async write(update: CmmsWorkOrderUpdate): Promise<CmmsWriteOutcome> {
    if (!this.cfg) return UNSUPPORTED;
    const res = await this.call(
      'POST',
      `work-orders/${encodeURIComponent(update.workOrderKey)}/updates`,
      update.idempotencyKey,
      { kind: update.updateKind, payload: update.payload, payloadDigest: update.payloadDigest },
    );
    if (!res) return { outcome: 'UNKNOWN', reasonCode: 'CMMS_TRANSPORT_AMBIGUOUS' };
    if (res.status >= 200 && res.status < 300) {
      const ref = await res
        .json()
        .then((j: unknown) => {
          const id = (j as { updateId?: unknown } | null)?.updateId;
          return typeof id === 'string' ? id : null;
        })
        .catch(() => null);
      return ref && /^[\x21-\x7E]{1,128}$/.test(ref)
        ? { outcome: 'CONFIRMED', externalUpdateRef: ref }
        : { outcome: 'UNKNOWN', reasonCode: 'CMMS_RESPONSE_UNPARSEABLE' };
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
      return { outcome: 'FAILED', reasonCode: `CMMS_HTTP_${res.status}` };
    return { outcome: 'UNKNOWN', reasonCode: `CMMS_HTTP_${res.status}` };
  }

  async lookup(idempotencyKey: string): Promise<CmmsLookupOutcome> {
    if (!this.cfg) return UNSUPPORTED;
    const res = await this.call(
      'GET',
      `updates/by-idempotency-key/${encodeURIComponent(idempotencyKey)}`,
      idempotencyKey,
    );
    if (!res) return { outcome: 'UNKNOWN', reasonCode: 'CMMS_TRANSPORT_AMBIGUOUS' };
    if (res.status === 404) return { outcome: 'NOT_FOUND' };
    if (res.status === 200) {
      const ref = await res
        .json()
        .then((j: unknown) => {
          const id = (j as { updateId?: unknown } | null)?.updateId;
          return typeof id === 'string' ? id : null;
        })
        .catch(() => null);
      if (ref && /^[\x21-\x7E]{1,128}$/.test(ref)) return { outcome: 'CONFIRMED', externalUpdateRef: ref };
    }
    return { outcome: 'UNKNOWN', reasonCode: `CMMS_HTTP_${res.status}` };
  }
}
