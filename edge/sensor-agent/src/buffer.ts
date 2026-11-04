// Bounded offline ring of device messages (HARDWARE-IOT §5). Messages keep their original event time, boot id and
// sequence. When full, the oldest message is evicted and folded into an overflow aggregate (per channel and unit:
// count, min, max, exact sum) and the dropped counter increments; a sealed disclosure reports exactly which sequence
// range was dropped so the gateway can tell disclosed loss from unexplained gaps.
import type { DeviceMessage, DropDisclosure, OverflowAggregate } from '@uptimebuyer/telemetry';

export const MAX_BUFFER_CAPACITY = 1_000_000;

interface OpenOverflow {
  bootId: string;
  count: number;
  fromSequence: number;
  toSequence: number;
  firstEventAt: string;
  lastEventAt: string;
  aggregates: Map<string, { channel: string; unit: string; count: number; min: number; max: number; sum: bigint }>;
}

export class BoundedMessageBuffer {
  private readonly ring: (DeviceMessage | undefined)[];
  private head = 0;
  private length = 0;
  private dropped = 0;
  private open: OpenOverflow | null = null;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_BUFFER_CAPACITY)
      throw new Error(`Buffer capacity must be an integer in 1..${MAX_BUFFER_CAPACITY}.`);
    this.ring = new Array(capacity);
  }

  get size(): number {
    return this.length;
  }

  /** Cumulative count of messages evicted on overflow. */
  get droppedTotal(): number {
    return this.dropped;
  }

  /** An overflow episode is open (evictions not yet sealed into a disclosure). */
  get hasOpenDisclosure(): boolean {
    return this.open !== null;
  }

  /** Append; when full, evict the oldest message into the open overflow disclosure. Returns the evicted message. */
  push(message: DeviceMessage): DeviceMessage | null {
    let evicted: DeviceMessage | null = null;
    if (this.length === this.capacity) {
      evicted = this.ring[this.head]!;
      this.ring[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this.length--;
      this.recordDrop(evicted);
    }
    this.ring[(this.head + this.length) % this.capacity] = message;
    this.length++;
    return evicted;
  }

  peekOldest(n: number): DeviceMessage[] {
    const out: DeviceMessage[] = [];
    for (let i = 0; i < Math.min(n, this.length); i++) out.push(this.ring[(this.head + i) % this.capacity]!);
    return out;
  }

  /** Remove and return up to `n` oldest messages. */
  takeOldest(n: number): DeviceMessage[] {
    const out = this.peekOldest(n);
    for (let i = 0; i < out.length; i++) {
      this.ring[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this.length--;
    }
    return out;
  }

  /** Close the current overflow episode and return its disclosure (null when nothing was dropped since). */
  sealDisclosure(): DropDisclosure | null {
    const o = this.open;
    if (!o) return null;
    this.open = null;
    const aggregates: OverflowAggregate[] = [...o.aggregates.values()].map((a) => ({
      channel: a.channel,
      unit: a.unit as OverflowAggregate['unit'],
      count: a.count,
      min: a.min,
      max: a.max,
      sum: a.sum.toString(),
    }));
    return {
      bootId: o.bootId,
      droppedTotal: this.dropped,
      droppedMessages: o.count,
      fromSequence: o.fromSequence,
      toSequence: o.toSequence,
      firstEventAt: o.firstEventAt as DropDisclosure['firstEventAt'],
      lastEventAt: o.lastEventAt as DropDisclosure['lastEventAt'],
      aggregates: aggregates.slice(0, 16),
    };
  }

  private recordDrop(m: DeviceMessage): void {
    this.dropped++;
    if (this.open && this.open.bootId !== m.bootId) this.open = null; // a new boot starts a new disclosure
    const o = (this.open ??= {
      bootId: m.bootId,
      count: 0,
      fromSequence: m.sequence,
      toSequence: m.sequence,
      firstEventAt: m.eventAt,
      lastEventAt: m.eventAt,
      aggregates: new Map(),
    });
    o.count++;
    o.fromSequence = Math.min(o.fromSequence, m.sequence);
    o.toSequence = Math.max(o.toSequence, m.sequence);
    if (m.eventAt < o.firstEventAt) o.firstEventAt = m.eventAt;
    if (m.eventAt > o.lastEventAt) o.lastEventAt = m.eventAt;
    for (const s of m.samples) {
      const key = `${s.channel}\u0000${s.unit}`;
      const a = o.aggregates.get(key);
      if (a) {
        a.count++;
        a.min = Math.min(a.min, s.valueInt);
        a.max = Math.max(a.max, s.valueInt);
        a.sum += BigInt(s.valueInt);
      } else
        o.aggregates.set(key, {
          channel: s.channel,
          unit: s.unit,
          count: 1,
          min: s.valueInt,
          max: s.valueInt,
          sum: BigInt(s.valueInt),
        });
    }
  }
}
