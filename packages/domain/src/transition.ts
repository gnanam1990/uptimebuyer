// Pure transition validation. Never mutates its input; rejects unspecified and cross-kind transitions with the
// stable STATE_TRANSITION_INVALID (409) error (STATE-MACHINES §12).
import { DomainError } from '@uptimebuyer/contracts';
import {
  MACHINES,
  type MachineDefinition,
  type MachineName,
  type MachineState,
  type TransitionEdge,
} from './machines.js';

export type TransitionResult = TransitionEdge & { readonly machine: MachineName };

function machineOf(machine: MachineName): MachineDefinition {
  const def = (MACHINES as Record<string, MachineDefinition | undefined>)[machine];
  if (!def || !Object.hasOwn(MACHINES, machine))
    throw new DomainError('STATE_TRANSITION_INVALID', 'Unknown state machine.', { machine, reason: 'UNKNOWN_MACHINE' });
  return def;
}

function invalid(machine: MachineName, from: string, to: string, reason: string): DomainError {
  return new DomainError('STATE_TRANSITION_INVALID', 'The requested state transition is not allowed.', {
    machine,
    from,
    to,
    reason,
    currentState: from,
  });
}

/** Validate one edge. Returns the edge (with its guard) or throws a typed error. */
export function transition(machine: MachineName, from: string, to: string): TransitionResult {
  const def = machineOf(machine);
  if (!def.states.includes(from) || !def.states.includes(to)) throw invalid(machine, from, to, 'STATE_NOT_IN_MACHINE');
  const edge = def.edges.find((e) => e.from === from && e.to === to);
  if (!edge) throw invalid(machine, from, to, 'UNSPECIFIED_TRANSITION');
  return Object.freeze({ machine, ...edge });
}

export function isTransitionAllowed(machine: MachineName, from: string, to: string): boolean {
  try {
    transition(machine, from, to);
    return true;
  } catch {
    return false;
  }
}

export function allowedTargets<M extends MachineName>(machine: M, from: MachineState<M> | string): MachineState<M>[] {
  return machineOf(machine)
    .edges.filter((e) => e.from === from)
    .map((e) => e.to as MachineState<M>);
}

type Versioned = { readonly state: string; readonly version: number };

/**
 * Apply an allowed transition, returning a NEW aggregate with `version + 1`. The input is never mutated.
 * Incident-shaped aggregates (with `pausedFromState`) record the prior state on pause and may resume only to it.
 */
export function applyTransition<A extends Versioned>(machine: MachineName, aggregate: A, to: string): A {
  if (!Number.isSafeInteger(aggregate.version) || aggregate.version < 1)
    throw new DomainError('VALIDATION_FAILED', 'Aggregate version must be a positive integer.');
  transition(machine, aggregate.state, to);
  const next: Record<string, unknown> = { ...aggregate, state: to, version: aggregate.version + 1 };
  if (machine === 'INCIDENT' && Object.hasOwn(aggregate, 'pausedFromState')) {
    const prior = (aggregate as unknown as { pausedFromState: string | null }).pausedFromState;
    if (aggregate.state === 'PAUSED') {
      if (prior !== to) throw invalid(machine, aggregate.state, to, 'RESUME_TARGET_NOT_PRIOR_STATE');
      next['pausedFromState'] = null;
    } else if (to === 'PAUSED') next['pausedFromState'] = aggregate.state;
  }
  return next as A;
}

/** Resume a paused incident to exactly its recorded prior state. */
export function resumeFromPause<A extends Versioned & { readonly pausedFromState: string | null }>(
  incident: A,
  to: string,
): A {
  if (incident.state !== 'PAUSED') throw invalid('INCIDENT', incident.state, to, 'NOT_PAUSED');
  return applyTransition('INCIDENT', incident, to);
}
