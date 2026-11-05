// T-051 (unit layer) — the single mapping from every state axis to its label, tone, icon shape and accessible
// description. Green ("healthy") is reserved for independently verified good states: FRESH telemetry, a CONFIRMED
// payment or Kite session, a PASSED recovery evaluation and the canonical RECOVERED state/closeout gate. Stale,
// offline, invalid, no-signal, every UNKNOWN, UNSUPPORTED, transport, capability, local authority, fulfillment and
// delivery states are never green; an unrecognized value is labelled as such (never guessed). Every view carries a
// text label, a shape and a description, so status is never color alone (INV-11, INV-12, NFR-07).
import { describe, expect, it } from 'vitest';
import { AXES, describeAxis, type Axis } from '../src/status/axes.js';

const ALL: Record<Axis, readonly string[]> = {
  freshness: ['FRESH', 'STALE', 'OFFLINE', 'INVALID', 'NO_SIGNAL'],
  'kite-session': ['PROPOSED', 'AUTHORIZED', 'REQUESTED', 'ACCEPTED', 'CONFIRMED', 'UNKNOWN', 'FAILED', 'CANCELLED'],
  'external-outcome': [
    'PROPOSED',
    'AUTHORIZED',
    'REQUESTED',
    'ACCEPTED',
    'CONFIRMED',
    'UNKNOWN',
    'FAILED',
    'CANCELLED',
  ],
  transport: ['PREPARED', 'SEND_STARTED', 'ACKNOWLEDGED', 'UNKNOWN', 'DEFINITE_NO_EFFECT'],
  'adapter-capability': ['ELIGIBLE', 'UNSUPPORTED'],
  'economic-intent': ['CREATED', 'RESERVED', 'SUBMITTED', 'CONFIRMED', 'UNKNOWN', 'FAILED', 'REFUNDED', 'REVERSED'],
  'local-authority': ['ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED'],
  'purchase-order': [
    'REQUESTED',
    'ACCEPTED',
    'ORDERED',
    'PARTIALLY_FILLED',
    'SHIPPED',
    'DELIVERED',
    'VERIFIED',
    'DISPUTED',
    'SUBSTITUTION_PROPOSED',
    'CHANGE_REVIEW',
    'REJECTED',
    'CANCELLED',
    'FAILED',
    'UNKNOWN',
  ],
  'service-job': [
    'REQUESTED',
    'ACCEPTED',
    'SCHEDULED',
    'RESCHEDULED',
    'EN_ROUTE',
    'ARRIVED',
    'IN_PROGRESS',
    'WORK_REPORTED_COMPLETE',
    'SCOPE_CHANGE_PROPOSED',
    'NO_SHOW',
    'VERIFIED',
    'DISPUTED',
    'REJECTED',
    'CANCELLED',
    'FAILED',
    'UNKNOWN',
  ],
  'incident-state': [
    'DETECTED',
    'TRIAGING',
    'AWAITING_EVIDENCE',
    'PLANNING',
    'AWAITING_APPROVAL',
    'EXECUTING',
    'VERIFYING',
    'RECOVERED',
    'ESCALATED',
    'PAUSED',
    'REOPENED',
  ],
  recovery: ['RECOVERED', 'NOT_RECOVERED'],
  'recovery-evaluation': ['PENDING', 'OBSERVING', 'PASSED', 'FAILED', 'EXPIRED'],
  compatibility: ['ALLOW', 'HOLD', 'REJECT'],
  'notification-delivery': ['PENDING', 'DELIVERED', 'UNKNOWN', 'FAILED'],
  deadline: ['RUNNING', 'PAUSED', 'EXPIRED'],
  'plan-disposition': ['RANKED', 'ELIGIBLE_UNRANKED', 'INCOMPLETE', 'HELD', 'REJECTED'],
  urgency: ['CRITICAL', 'HIGH', 'NORMAL'],
};

const GREEN_ONLY: Partial<Record<Axis, string[]>> = {
  freshness: ['FRESH'],
  'kite-session': ['CONFIRMED'],
  'external-outcome': ['CONFIRMED'],
  'economic-intent': ['CONFIRMED'],
  'incident-state': ['RECOVERED'],
  recovery: ['RECOVERED'],
  'recovery-evaluation': ['PASSED'],
};

describe('T-051 axis honesty mapping', () => {
  it('covers every axis and every canonical value with label, shape, description and tone', () => {
    expect([...AXES].sort()).toEqual(Object.keys(ALL).sort());
    for (const [axis, values] of Object.entries(ALL) as [Axis, string[]][])
      for (const value of values) {
        const v = describeAxis(axis, value);
        expect(v.label.length, `${axis}=${value}`).toBeGreaterThan(1);
        expect(v.shape, `${axis}=${value}`).toBeTruthy();
        expect(v.description.length, `${axis}=${value}`).toBeGreaterThan(10);
        expect(v.label).not.toMatch(/^[A-Z_]+$/); // a human label, not the raw code
      }
  });

  it('green is reserved for independently verified good states', () => {
    for (const [axis, values] of Object.entries(ALL) as [Axis, string[]][])
      for (const value of values) {
        const healthy = describeAxis(axis, value).tone === 'healthy';
        expect(healthy, `${axis}=${value}`).toBe((GREEN_ONLY[axis] ?? []).includes(value));
      }
  });

  it('stale, unknown and unsupported are never green, never phrased as success, and have distinct shapes', () => {
    const cases: [Axis, string][] = [
      ['freshness', 'STALE'],
      ['freshness', 'OFFLINE'],
      ['freshness', 'INVALID'],
      ['freshness', 'NO_SIGNAL'],
      ['kite-session', 'UNKNOWN'],
      ['external-outcome', 'UNKNOWN'],
      ['economic-intent', 'UNKNOWN'],
      ['transport', 'UNKNOWN'],
      ['adapter-capability', 'UNSUPPORTED'],
      ['purchase-order', 'UNKNOWN'],
      ['service-job', 'UNKNOWN'],
      ['notification-delivery', 'UNKNOWN'],
    ];
    for (const [axis, value] of cases) {
      const v = describeAxis(axis, value);
      expect(v.tone, `${axis}=${value}`).not.toBe('healthy');
      expect(`${v.label} ${v.description}`).not.toMatch(/\b(success|succeeded|confirmed|healthy|complete)\b/i);
      expect(v.shape).not.toBe(describeAxis('freshness', 'FRESH').shape);
    }
    expect(describeAxis('external-outcome', 'UNKNOWN').shape).not.toBe(
      describeAxis('external-outcome', 'FAILED').shape,
    );
  });

  it('a provider-session reference, a 202 or an ACCEPTED/REQUESTED session is not confirmation', () => {
    for (const value of ['REQUESTED', 'ACCEPTED', 'AUTHORIZED', 'PROPOSED']) {
      const v = describeAxis('kite-session', value);
      expect(v.tone).not.toBe('healthy');
      expect(v.description).toMatch(/not confirmed/i);
    }
  });

  it('an unrecognized or missing value is labelled as such, never guessed', () => {
    for (const value of ['PROBABLY_FINE', '', null, undefined]) {
      const v = describeAxis('external-outcome', value);
      expect(v.tone).toBe('unknown');
      expect(v.label).toMatch(/not reported|unrecognized/i);
    }
  });
});
