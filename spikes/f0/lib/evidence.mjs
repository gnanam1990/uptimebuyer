// F0-E recovery-authority separation. Each evidence kind is a separate record; payment, provider acceptance
// and a provider "completed" work report can never by themselves produce a restored-condition result.
import { digestOf } from './canonical.mjs';
import { SOURCES } from './sensor.mjs';

export const KINDS = Object.freeze([
  'PAYMENT_OBSERVATION',
  'PROVIDER_ACCEPTANCE',
  'WORK_REPORT',
  'SIGNOFF',
  'SENSOR_WINDOW',
]);

export function makeRecord(kind, body) {
  if (!KINDS.includes(kind)) throw new Error(`unknown evidence kind ${kind}`);
  const record = { kind, ...body };
  return { ...record, digest: digestOf(record) };
}

export function deriveRecoveryResult(records, policy) {
  const reasons = [];
  const unknown = records.filter((r) => !KINDS.includes(r.kind));
  if (unknown.length) reasons.push('UNKNOWN_EVIDENCE_KIND_IGNORED');
  const work = records.filter((r) => r.kind === 'WORK_REPORT');
  const signoff = records.find((r) => r.kind === 'SIGNOFF');
  const windows = records.filter((r) => r.kind === 'SENSOR_WINDOW');
  const interventionEnd = Math.max(0, ...work.map((w) => w.reportedAtMs));
  if (!signoff) reasons.push('NO_SIGNOFF');
  if (windows.length === 0) reasons.push('NO_SENSOR_WINDOW');
  const qualifying = windows.filter(
    (w) =>
      w.startMs > interventionEnd &&
      w.samples >= policy.minSamples &&
      w.allFreshInRange === true &&
      w.source === SOURCES.LIVE_AUTHENTICATED,
  );
  if (windows.length && !qualifying.length) {
    const simulatedOk = windows.some(
      (w) => w.source === SOURCES.SIMULATED_INPUT && w.allFreshInRange && w.startMs > interventionEnd,
    );
    reasons.push(simulatedOk ? 'SENSOR_WINDOW_SIMULATED_ONLY' : 'SENSOR_WINDOW_NOT_QUALIFYING');
  }
  if (reasons.filter((r) => r !== 'UNKNOWN_EVIDENCE_KIND_IGNORED').length === 0) {
    return { result: 'CONDITION_RESTORED_OBSERVED', reasons };
  }
  if (reasons.includes('SENSOR_WINDOW_SIMULATED_ONLY'))
    return { result: 'CONDITION_IN_RANGE_SIMULATED_NOT_RECOVERY', reasons };
  return { result: 'INSUFFICIENT_FOR_RECOVERY', reasons };
}
