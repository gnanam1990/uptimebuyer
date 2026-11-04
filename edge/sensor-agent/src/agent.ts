// Reference edge agent (HARDWARE-IOT §4–5, §9). Records sequenced messages with their original event time and boot
// id; while disconnected (or when a send fails) messages go to the bounded ring buffer. On reconnect, live data is
// sent first; buffered data drains oldest-first in bounded BACKFILL batches at most once per interval, honouring
// the gateway's Retry-After. Every request is signed (HMAC body signature + short-lived device token).
import { randomUUID } from 'node:crypto';
import {
  SIGNATURE_HEADER,
  TELEMETRY_LIMITS,
  TIMESTAMP_HEADER,
  signTelemetryBody,
  type Clock,
  type DeliveryMode,
  type DeviceMessage,
  type DeviceQuality,
  type DropDisclosure,
  type TelemetryBatchInput,
  type WireUnit,
} from '@uptimebuyer/telemetry';
import { BoundedMessageBuffer } from './buffer.js';

export interface TransportRequest {
  path: string;
  headers: Record<string, string>;
  body: string;
}
export interface TransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}
/** Network port. Throwing means the request may not have arrived (the data stays buffered). */
export type AgentTransport = (req: TransportRequest) => Promise<TransportResponse>;

export interface ReadingInput {
  channel: string;
  valueInt: number;
  unit: WireUnit;
  quality?: DeviceQuality;
}

export interface SensorAgentOptions {
  deviceId: string;
  /** Per-device credential key (provisioned out of band; never logged). */
  deviceKey: Uint8Array;
  tokenProvider: () => Promise<string>;
  transport: AgentTransport;
  clock: Clock;
  bootId?: string;
  bufferCapacity?: number;
  maxBatchMessages?: number;
  backfillIntervalMs?: number;
  path?: string;
  firmware?: string;
  /** Only the simulator sets this; a physical agent cannot claim anything stronger than the registry's class. */
  inputLabel?: 'SIMULATED_INPUT';
}

export interface SendReport {
  delivery: DeliveryMode;
  sequences: number[];
  status: number | 'NETWORK_ERROR';
}

export interface AgentStats {
  bootId: string;
  connected: boolean;
  nextSequence: number;
  liveQueued: number;
  buffered: number;
  droppedTotal: number;
  pendingDisclosures: number;
  retryAfterMs: number | null;
}

const headerValue = (h: string | string[] | undefined): string | undefined => (Array.isArray(h) ? h[0] : h);

export class SensorAgent {
  readonly bootId: string;
  private readonly buffer: BoundedMessageBuffer;
  private readonly live: DeviceMessage[] = [];
  private readonly pending: DropDisclosure[] = [];
  private readonly maxBatch: number;
  private readonly interval: number;
  private sequence = 0;
  private connectedFlag = true;
  private nextBackfillAt = Number.NEGATIVE_INFINITY;
  private retryAfterMs: number | null = null;

  constructor(private readonly opts: SensorAgentOptions) {
    if (opts.inputLabel !== undefined && opts.inputLabel !== 'SIMULATED_INPUT')
      throw new Error('The only input label an agent may assert is SIMULATED_INPUT.');
    this.bootId = opts.bootId ?? `boot_${randomUUID()}`;
    this.buffer = new BoundedMessageBuffer(opts.bufferCapacity ?? 1024);
    this.maxBatch = Math.min(opts.maxBatchMessages ?? 50, TELEMETRY_LIMITS.maxMessagesPerBatch);
    if (!Number.isSafeInteger(this.maxBatch) || this.maxBatch < 1) throw new Error('maxBatchMessages must be >= 1.');
    this.interval = opts.backfillIntervalMs ?? 1_000;
    if (!Number.isSafeInteger(this.interval) || this.interval < 1) throw new Error('backfillIntervalMs must be >= 1.');
  }

  get connected(): boolean {
    return this.connectedFlag;
  }

  /** Record one message now (or at `eventAtMs`, for skew scenarios). The event time is never changed afterwards. */
  record(readings: readonly ReadingInput[], opts: { eventAtMs?: number } = {}): DeviceMessage {
    const message: DeviceMessage = {
      bootId: this.bootId,
      sequence: this.sequence++,
      eventAt: new Date(opts.eventAtMs ?? this.opts.clock.now()).toISOString() as DeviceMessage['eventAt'],
      samples: readings.map((r) => ({
        channel: r.channel,
        valueInt: r.valueInt,
        unit: r.unit,
        quality: r.quality ?? 'GOOD',
        ...(this.opts.inputLabel ? { label: this.opts.inputLabel } : {}),
      })),
    };
    if (this.connectedFlag) {
      this.live.push(message);
      // bound the live queue too: anything beyond one batch is already behind and becomes backfill
      while (this.live.length > this.maxBatch) this.buffer.push(this.live.shift()!);
    } else this.buffer.push(message);
    return message;
  }

  /** Skip sequence numbers without recording (a "missing data" scenario: the gap is visible to the gateway). */
  skip(count = 1): void {
    this.sequence += count;
  }

  disconnect(): void {
    this.connectedFlag = false;
    for (const m of this.live.splice(0)) this.buffer.push(m);
  }

  reconnect(): void {
    this.connectedFlag = true;
  }

  stats(): AgentStats {
    return {
      bootId: this.bootId,
      connected: this.connectedFlag,
      nextSequence: this.sequence,
      liveQueued: this.live.length,
      buffered: this.buffer.size,
      droppedTotal: this.buffer.droppedTotal,
      pendingDisclosures: this.pending.length + (this.buffer.hasOpenDisclosure ? 1 : 0),
      retryAfterMs: this.retryAfterMs,
    };
  }

  /** Send live data first, then at most one backfill batch if the backfill interval and any Retry-After allow. */
  async flush(): Promise<SendReport[]> {
    const reports: SendReport[] = [];
    if (!this.connectedFlag) return reports;
    if (this.live.length > 0) {
      const batch = this.live.splice(0, this.maxBatch);
      const report = await this.send('LIVE', batch, []);
      reports.push(report);
      if (!ok(report.status)) for (const m of batch) this.buffer.push(m); // resent later as backfill
    }
    const now = this.opts.clock.now();
    const sealed = this.buffer.sealDisclosure();
    if (sealed) this.pending.push(sealed);
    if (this.buffer.size > 0 && now >= this.nextBackfillAt) {
      const batch = this.buffer.peekOldest(this.maxBatch);
      const disclosures = this.pending.slice(0, TELEMETRY_LIMITS.maxDisclosuresPerBatch);
      const report = await this.send('BACKFILL', batch, disclosures);
      reports.push(report);
      this.nextBackfillAt = now + this.interval;
      if (ok(report.status)) {
        this.buffer.takeOldest(batch.length);
        this.pending.splice(0, disclosures.length);
        this.retryAfterMs = null;
      } else if (report.status === 429) {
        this.nextBackfillAt = now + Math.max(this.interval, this.retryAfterMs ?? this.interval);
      }
    }
    return reports;
  }

  private async send(
    delivery: DeliveryMode,
    messages: DeviceMessage[],
    disclosures: DropDisclosure[],
  ): Promise<SendReport> {
    const sequences = messages.map((m) => m.sequence);
    const now = this.opts.clock.now();
    const batch: TelemetryBatchInput = {
      schemaVersion: 1,
      deviceId: this.opts.deviceId,
      delivery,
      sentAt: new Date(now).toISOString() as TelemetryBatchInput['sentAt'],
      messages,
      disclosures,
      ...(this.opts.firmware ? { firmware: this.opts.firmware } : {}),
    };
    const body = JSON.stringify(batch);
    try {
      const token = await this.opts.tokenProvider();
      const res = await this.opts.transport({
        path: this.opts.path ?? '/v1/device/telemetry:batch',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          [TIMESTAMP_HEADER]: String(now),
          [SIGNATURE_HEADER]: signTelemetryBody(this.opts.deviceKey, now, this.opts.deviceId, body),
        },
        body,
      });
      if (res.status === 429) {
        const seconds = Number(headerValue(res.headers['retry-after']));
        this.retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : this.interval;
      }
      return { delivery, sequences, status: res.status };
    } catch {
      return { delivery, sequences, status: 'NETWORK_ERROR' };
    }
  }
}

const ok = (s: number | 'NETWORK_ERROR') => typeof s === 'number' && s >= 200 && s < 300;
