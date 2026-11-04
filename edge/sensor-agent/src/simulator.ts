// Edge simulator (HARDWARE-IOT §9, FR-22): drives the same agent, wire schema, signing and gateway path as a
// physical node, but every sample it produces carries the SIMULATED_INPUT label and the label cannot be disabled.
// Scenarios: normal, warming, recovery, door events, missing data (sequence skip), duplicate and reordered
// delivery, and clock skew. Simulated evidence can never be presented as a physical-sensor result.
import type { Clock, DeviceMessage, WireUnit } from '@uptimebuyer/telemetry';
import { SensorAgent, type SensorAgentOptions } from './agent.js';

export type SimulatorScenario = 'normal' | 'warming' | 'recovery' | 'door_open';

export interface SimulatedChannel {
  channel: string;
  unit: WireUnit;
  /** Baseline value in the wire unit (e.g. 3500 = 3.5 °C for `mC`). */
  baseline: number;
}

export interface SensorSimulatorOptions extends Omit<SensorAgentOptions, 'inputLabel'> {
  channels: readonly SimulatedChannel[];
}

export class SensorSimulator {
  readonly agent: SensorAgent;
  private readonly channels: readonly SimulatedChannel[];
  private readonly clock: Clock;
  private warming = 0;
  private tick = 0;

  constructor(opts: SensorSimulatorOptions) {
    if ('inputLabel' in opts && (opts as { inputLabel?: unknown }).inputLabel !== 'SIMULATED_INPUT')
      throw new Error('The simulator always labels its input SIMULATED_INPUT; the label cannot be changed.');
    this.channels = [...opts.channels];
    this.clock = opts.clock;
    this.agent = new SensorAgent({ ...opts, inputLabel: 'SIMULATED_INPUT' });
  }

  /** Record one message for every channel under `scenario`; `skewMs` shifts the device clock (skew scenarios). */
  step(scenario: SimulatorScenario, opts: { skewMs?: number } = {}): DeviceMessage {
    this.tick++;
    if (scenario === 'warming') this.warming++;
    if (scenario === 'recovery') this.warming = Math.max(0, this.warming - 2);
    const readings = this.channels.map((c) => ({
      channel: c.channel,
      unit: c.unit,
      valueInt: this.value(c, scenario),
    }));
    const at = opts.skewMs === undefined ? {} : { eventAtMs: this.clock.now() + opts.skewMs };
    return this.agent.record(readings, at);
  }

  /** Missing-data scenario: skip sequence numbers so the gateway observes an undisclosed gap. */
  skip(count = 1): void {
    this.agent.skip(count);
  }

  /** Duplicate-delivery scenario: an identical copy of an already recorded message. */
  duplicateOf(m: DeviceMessage): DeviceMessage {
    return structuredClone(m);
  }

  /** Reordered-delivery scenario: the same messages, newest first. */
  reordered(ms: readonly DeviceMessage[]): DeviceMessage[] {
    return [...ms].reverse();
  }

  private value(c: SimulatedChannel, scenario: SimulatorScenario): number {
    if (c.unit === 'bool') return scenario === 'door_open' ? 1 : c.baseline === 1 ? 1 : 0;
    if (c.unit === 'none') return 0;
    const wobble = (this.tick % 3) * 10;
    return c.baseline + wobble + this.warming * 500;
  }
}
