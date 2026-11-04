// T-016 — Edge reconnect and bounded backfill (edge unit layer): the reference agent keeps a bounded ring of
// messages with original event time, boot id and sequence; overflow evicts the oldest into explicit aggregates and
// a dropped counter; on reconnect live data is sent first and backfill drains oldest-first in bounded, rate-limited,
// signed batches that carry the overflow disclosure. The simulator labels every sample SIMULATED_INPUT.
import { randomBytes } from 'node:crypto';
import {
  ManualClock,
  TelemetryBatchSchema,
  verifyTelemetryBody,
  type DeviceMessage,
  type TelemetryBatch,
} from '@uptimebuyer/telemetry';
import { describe, expect, it } from 'vitest';
import {
  BoundedMessageBuffer,
  SensorAgent,
  SensorSimulator,
  type AgentTransport,
  type TransportRequest,
} from '../src/index.js';

const t0 = Date.UTC(2026, 10, 4, 12, 0, 0);
const CH = 'chn_fixture-temp';
const msg = (sequence: number, valueInt: number, at = t0 + sequence * 1000): DeviceMessage => ({
  bootId: 'boot_fixture-1',
  sequence,
  eventAt: new Date(at).toISOString() as DeviceMessage['eventAt'],
  samples: [{ channel: CH, valueInt, unit: 'mC', quality: 'GOOD' }],
});

function recordingTransport(respond: (req: TransportRequest, batch: TelemetryBatch) => number = () => 200) {
  const sent: { req: TransportRequest; batch: TelemetryBatch; status: number }[] = [];
  let failing = false;
  const transport: AgentTransport = async (req) => {
    if (failing) throw new Error('network unreachable');
    const batch = TelemetryBatchSchema.parse(JSON.parse(req.body));
    const status = respond(req, batch);
    sent.push({ req, batch, status });
    return {
      status,
      headers: status === 429 ? { 'retry-after': '2' } : {},
      body: status === 200 ? { accepted: batch.messages.length } : { error: { code: 'RATE_LIMITED' } },
    };
  };
  return {
    transport,
    sent,
    fail: (v: boolean) => {
      failing = v;
    },
  };
}

describe('T-016 bounded edge buffer', () => {
  it('never exceeds capacity, evicts oldest first and folds evictions into an explicit disclosure', () => {
    const b = new BoundedMessageBuffer(3);
    for (let s = 1; s <= 7; s++) b.push(msg(s, s * 100));
    expect(b.size).toBe(3);
    expect(b.droppedTotal).toBe(4);
    expect(b.peekOldest(10).map((m) => m.sequence)).toEqual([5, 6, 7]);
    const d = b.sealDisclosure();
    expect(d).toMatchObject({
      bootId: 'boot_fixture-1',
      droppedTotal: 4,
      droppedMessages: 4,
      fromSequence: 1,
      toSequence: 4,
      firstEventAt: new Date(t0 + 1000).toISOString(),
      lastEventAt: new Date(t0 + 4000).toISOString(),
    });
    expect(d!.aggregates).toEqual([{ channel: CH, unit: 'mC', count: 4, min: 100, max: 400, sum: '1000' }]);
    expect(b.sealDisclosure()).toBeNull();
    b.push(msg(8, 800));
    expect(b.droppedTotal).toBe(5);
    expect(b.sealDisclosure()).toMatchObject({ droppedTotal: 5, droppedMessages: 1, fromSequence: 5, toSequence: 5 });
  });

  it('drains oldest-first and preserves the original event time, boot id and sequence', () => {
    const b = new BoundedMessageBuffer(10);
    const input = [msg(3, 1), msg(4, 2), msg(5, 3)];
    for (const m of input) b.push(m);
    const out = b.takeOldest(2);
    expect(out).toEqual(input.slice(0, 2));
    expect(b.peekOldest(5)).toEqual(input.slice(2));
  });

  it('rejects a non-positive or unbounded capacity', () => {
    expect(() => new BoundedMessageBuffer(0)).toThrow();
    expect(() => new BoundedMessageBuffer(1_000_001)).toThrow();
  });
});

describe('T-016 reference agent reconnect and backfill', () => {
  const deviceKey = new Uint8Array(randomBytes(32));
  const make = (transport: AgentTransport, clock: ManualClock) =>
    new SensorAgent({
      deviceId: 'dev_fixture-1',
      bootId: 'boot_fixture-1',
      deviceKey,
      tokenProvider: async () => 'header.payload.signature',
      transport,
      clock,
      bufferCapacity: 5,
      maxBatchMessages: 2,
      backfillIntervalMs: 1_000,
    });

  it('buffers while disconnected, then sends live first and bounded, ordered, rate-limited, signed backfill', async () => {
    const clock = new ManualClock(t0);
    const t = recordingTransport();
    const agent = make(t.transport, clock);
    agent.disconnect();
    const recorded: DeviceMessage[] = [];
    for (let i = 0; i < 8; i++) {
      recorded.push(agent.record([{ channel: CH, valueInt: 4000 + i, unit: 'mC' }]));
      clock.advance(1_000);
    }
    expect(agent.stats()).toMatchObject({ buffered: 5, droppedTotal: 3 });
    expect(t.sent).toHaveLength(0);

    agent.reconnect();
    const live = agent.record([{ channel: CH, valueInt: 3900, unit: 'mC' }]);
    await agent.flush();
    // live first, alone; then exactly one backfill batch (rate limit) of the oldest buffered messages
    expect(t.sent.map((s) => s.batch.delivery)).toEqual(['LIVE', 'BACKFILL']);
    expect(t.sent[0]!.batch.messages).toEqual([live]);
    expect(t.sent[1]!.batch.messages.map((m) => m.sequence)).toEqual([3, 4]);
    expect(t.sent[1]!.batch.messages).toEqual(recorded.slice(3, 5));
    expect(t.sent[1]!.batch.disclosures).toEqual([
      expect.objectContaining({ droppedTotal: 3, droppedMessages: 3, fromSequence: 0, toSequence: 2 }),
    ]);

    await agent.flush(); // inside the backfill interval: nothing more is sent
    expect(t.sent).toHaveLength(2);
    clock.advance(1_000);
    await agent.flush();
    clock.advance(1_000);
    await agent.flush();
    clock.advance(1_000);
    await agent.flush();
    const backfill = t.sent.filter((s) => s.batch.delivery === 'BACKFILL');
    expect(backfill.map((s) => s.batch.messages.map((m) => m.sequence))).toEqual([[3, 4], [5, 6], [7]]);
    expect(backfill.every((s) => s.batch.messages.length <= 2)).toBe(true);
    expect(backfill.slice(1).every((s) => s.batch.disclosures.length === 0)).toBe(true);
    expect(agent.stats()).toMatchObject({ buffered: 0, pendingDisclosures: 0 });

    for (const s of t.sent) {
      const ts = Number(s.req.headers['x-ub-timestamp']);
      expect(s.req.headers.authorization).toBe('Bearer header.payload.signature');
      expect(
        verifyTelemetryBody({
          key: deviceKey,
          timestampMs: ts,
          deviceId: 'dev_fixture-1',
          body: Buffer.from(s.req.body, 'utf8'),
          signature: s.req.headers['x-ub-signature']!,
          nowMs: ts,
          maxSkewMs: 1,
        }),
      ).toEqual({ ok: true });
    }
  });

  it('keeps data buffered on 429 and on network failure; failed live data is resent as backfill', async () => {
    const clock = new ManualClock(t0);
    let limited = true;
    const t = recordingTransport((_req, batch) => (batch.delivery === 'BACKFILL' && limited ? 429 : 200));
    const agent = make(t.transport, clock);
    agent.disconnect();
    agent.record([{ channel: CH, valueInt: 1, unit: 'mC' }]);
    agent.reconnect();
    await agent.flush();
    expect(t.sent.map((s) => s.status)).toEqual([429]);
    expect(agent.stats().buffered).toBe(1);
    expect(agent.stats().retryAfterMs).toBe(2_000);
    clock.advance(1_000);
    await agent.flush();
    expect(t.sent).toHaveLength(1); // honours Retry-After
    limited = false;
    clock.advance(1_500);
    await agent.flush();
    expect(t.sent.map((s) => s.status)).toEqual([429, 200]);
    expect(agent.stats().buffered).toBe(0);

    t.fail(true);
    const lost = agent.record([{ channel: CH, valueInt: 2, unit: 'mC' }]);
    await agent.flush();
    expect(agent.stats().buffered).toBe(1);
    t.fail(false);
    clock.advance(1_000);
    await agent.flush();
    expect(t.sent.at(-1)!.batch).toMatchObject({ delivery: 'BACKFILL', messages: [lost] });
  });

  it('starts a new boot with a fresh boot id and sequence 0', () => {
    const clock = new ManualClock(t0);
    const a = new SensorAgent({
      deviceId: 'dev_fixture-1',
      deviceKey,
      tokenProvider: async () => 'x.y.z',
      transport: recordingTransport().transport,
      clock,
    });
    const b = new SensorAgent({
      deviceId: 'dev_fixture-1',
      deviceKey,
      tokenProvider: async () => 'x.y.z',
      transport: recordingTransport().transport,
      clock,
    });
    expect(a.stats().bootId).toMatch(/^boot_[A-Za-z0-9-]+$/);
    expect(a.stats().bootId).not.toBe(b.stats().bootId);
    expect(a.record([{ channel: CH, valueInt: 1, unit: 'mC' }]).sequence).toBe(0);
  });
});

describe('T-016 simulator labelling', () => {
  it('labels every sample SIMULATED_INPUT and the label cannot be turned off', async () => {
    const clock = new ManualClock(t0);
    const t = recordingTransport();
    const sim = new SensorSimulator({
      deviceId: 'dev_fixture-sim',
      deviceKey: new Uint8Array(randomBytes(32)),
      tokenProvider: async () => 'x.y.z',
      transport: t.transport,
      clock,
      channels: [
        { channel: 'chn_fixture-temp', unit: 'mC', baseline: 3500 },
        { channel: 'chn_fixture-door', unit: 'bool', baseline: 0 },
      ],
    });
    for (const scenario of ['normal', 'warming', 'recovery'] as const) {
      sim.step(scenario);
      clock.advance(10_000);
    }
    sim.agent.disconnect();
    sim.step('normal');
    sim.agent.reconnect();
    await sim.agent.flush();
    clock.advance(5_000);
    await sim.agent.flush();
    const samples = t.sent.flatMap((s) => s.batch.messages.flatMap((m) => m.samples));
    expect(samples.length).toBeGreaterThanOrEqual(8);
    expect(samples.every((s) => s.label === 'SIMULATED_INPUT')).toBe(true);
    expect(
      () =>
        new SensorSimulator({
          deviceId: 'dev_fixture-sim',
          deviceKey: new Uint8Array(randomBytes(32)),
          tokenProvider: async () => 'x.y.z',
          transport: t.transport,
          clock,
          channels: [],
          // @ts-expect-error the simulator does not accept a label override
          inputLabel: null,
        }),
    ).toThrow(/SIMULATED_INPUT/);
  });

  it('produces duplicate and reordered deliveries on request without changing original event times', () => {
    const clock = new ManualClock(t0);
    const sim = new SensorSimulator({
      deviceId: 'dev_fixture-sim',
      deviceKey: new Uint8Array(randomBytes(32)),
      tokenProvider: async () => 'x.y.z',
      transport: recordingTransport().transport,
      clock,
      channels: [{ channel: 'chn_fixture-temp', unit: 'mC', baseline: 3500 }],
    });
    const a = sim.step('normal');
    clock.advance(1_000);
    const b = sim.step('normal');
    expect(sim.duplicateOf(a)).toEqual(a);
    expect(sim.reordered([a, b])).toEqual([b, a]);
    expect(a.eventAt).toBe(new Date(t0).toISOString());
  });
});
