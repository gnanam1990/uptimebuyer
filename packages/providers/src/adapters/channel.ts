// Unpaid email and phone contact adapters over a channel transport port (an organisation's own mail relay or
// telephony line, never a paid Kite service). The local transport is a LOCAL_FAKE sandbox: it records messages in
// memory, is same-key idempotent on the pre-egress message id, and supports lookup, so it can stand in for a
// reconcilable channel in tests. A real relay/telephony transport is configured by the deployment and is NOT_RUN.
import {
  NotSentError,
  type AdapterCapabilityAssessment,
  type AdapterClass,
  type CallContext,
  type ContactExecution,
  type ContactObserver,
  type ContactResult,
  type LookupResult,
  type PinnedRevision,
  type ProviderOperation,
  type UnpaidProviderAdapter,
} from '../ports.js';
import { rawResponseDigest } from './structured-api.js';

export interface ChannelMessage {
  readonly messageId: string;
  readonly idempotencyKey: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly disclosure: string | null;
}

export interface ChannelTransport {
  readonly channel: 'EMAIL' | 'PHONE';
  readonly adapterClass: AdapterClass;
  /** Authoritative status lookup by message id, or same-key replay; without it a timeout cannot be reconciled. */
  readonly reconcilable: boolean;
  send(
    msg: ChannelMessage,
    opts: { signal: AbortSignal; onSent: () => void },
  ): Promise<{ accepted: boolean; ref: string | null; rawStatus: string }>;
  status(
    messageId: string,
    opts: { signal: AbortSignal },
  ): Promise<{ found: boolean; ref: string | null; rawStatus: string }>;
}

export class ChannelContactAdapter implements UnpaidProviderAdapter {
  readonly providerKey: string;
  readonly adapterClass: AdapterClass;
  readonly channels: readonly ('PHONE' | 'EMAIL' | 'API')[];
  readonly supportsSearch = false;
  private readonly transport: ChannelTransport;

  constructor(opts: { providerKey: string; channel: 'EMAIL' | 'PHONE'; transport: ChannelTransport }) {
    if (opts.transport.channel !== opts.channel) throw new Error('Channel transport mismatch.');
    this.providerKey = opts.providerKey;
    this.transport = opts.transport;
    this.adapterClass = opts.transport.adapterClass;
    this.channels = [opts.channel];
  }

  assess(_revision: PinnedRevision, op: ProviderOperation): AdapterCapabilityAssessment {
    if (op !== `CONTACT_${this.transport.channel}`)
      return { kind: 'UNSUPPORTED', reasonCode: 'OPERATION_NOT_SUPPORTED' };
    return this.transport.reconcilable
      ? { kind: 'ELIGIBLE' }
      : { kind: 'UNSUPPORTED', reasonCode: 'NO_RECONCILIATION_CAPABILITY' };
  }

  async contact(req: ContactExecution, ctx: CallContext, observer: ContactObserver): Promise<ContactResult> {
    const r = await this.transport.send(
      {
        messageId: req.clientOperationId,
        idempotencyKey: req.idempotencyKey,
        to: req.destination,
        subject: req.message.subject,
        body: req.message.body,
        disclosure: req.message.disclosure,
      },
      { signal: ctx.signal, onSent: () => observer.handedOff() },
    );
    const digest = rawResponseDigest({ accepted: r.accepted, ref: r.ref, rawStatus: r.rawStatus });
    return r.accepted
      ? {
          kind: 'ACCEPTED',
          providerRef: r.ref,
          rawStatus: r.rawStatus,
          rawResponseDigest: digest,
          quote: null,
          consent: null,
        }
      : { kind: 'DECLINED', rawStatus: r.rawStatus, reasonCode: 'CHANNEL_REJECTED', rawResponseDigest: digest };
  }

  async lookup(loc: { clientOperationId: string }, ctx: CallContext): Promise<LookupResult> {
    if (!this.transport.reconcilable) return { kind: 'UNSUPPORTED', reasonCode: 'LOOKUP_UNSUPPORTED' };
    const s = await this.transport.status(loc.clientOperationId, { signal: ctx.signal });
    const digest = rawResponseDigest(s);
    if (!s.found) return { kind: 'NOT_FOUND', rawResponseDigest: digest };
    return {
      kind: 'FOUND',
      state: 'ACCEPTED',
      providerRef: s.ref,
      rawStatus: s.rawStatus,
      rawResponseDigest: digest,
      quote: null,
    };
  }
}

/** LOCAL_FAKE channel transport: in-memory, same-key idempotent, never a real email or call. */
export class LocalChannelTransport implements ChannelTransport {
  readonly adapterClass = 'LOCAL_FAKE' as const;
  readonly sent: ChannelMessage[] = [];
  mode: 'ACCEPT' | 'HANG' | 'DECLINE' | 'NOT_SENT' = 'ACCEPT';
  reconcilable = true;
  private readonly byId = new Map<string, { ref: string; rawStatus: string }>();

  constructor(readonly channel: 'EMAIL' | 'PHONE') {}

  async send(msg: ChannelMessage, opts: { signal: AbortSignal; onSent: () => void }) {
    const prior = this.byId.get(msg.messageId);
    if (prior) return { accepted: true, ref: prior.ref, rawStatus: prior.rawStatus };
    if (this.mode === 'NOT_SENT') throw new NotSentError('CONNECTION_REFUSED');
    opts.onSent();
    if (this.mode === 'HANG')
      return new Promise<never>((_, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (opts.signal.aborted) fail();
        else opts.signal.addEventListener('abort', fail, { once: true });
      });
    if (this.mode === 'DECLINE') return { accepted: false, ref: null, rawStatus: 'rejected' };
    this.sent.push(structuredClone(msg));
    const rec = { ref: `local-${this.channel.toLowerCase()}-${this.sent.length}`, rawStatus: 'queued' };
    this.byId.set(msg.messageId, rec);
    return { accepted: true, ...rec };
  }

  async status(messageId: string) {
    const r = this.byId.get(messageId);
    return r ? { found: true, ref: r.ref, rawStatus: r.rawStatus } : { found: false, ref: null, rawStatus: 'unknown' };
  }
}
