// INTERNAL recovery hook (INV-01, INV-14). This module is deliberately NOT re-exported from index.ts, and the package
// `exports` map exposes only index.ts, so no other package can mark an incident RECOVERED through M04. The public
// advanceIncident refuses RECOVERED with POLICY_HOLD RECOVERY_EVALUATOR_REQUIRED.
//
// M11 binds here: it implements `RecoveryEvaluator` against its persisted recovery evaluations (state PASSED for the
// current action digest, stable LIVE window after the intervention boundary, required signoffs) and exposes a
// recovery command that calls `recoverIncidentWithEvaluation` inside this package. Until then only tests drive it,
// with an explicitly test-only fake evaluator; no production evaluator exists.
import { DomainError, ReasonCodeSchema } from '@uptimebuyer/contracts';
import type { Db, TenantContext, Tx } from '@uptimebuyer/data';
import { z } from 'zod';
import { command } from './commands.js';
import { parseInput, resultOf, transitionRow, type IncidentCommandResult } from './internal.js';

export interface PassedRecoveryEvaluation {
  readonly recoveryEvaluationId: string;
  readonly incidentId: string;
  readonly state: 'PASSED';
  readonly evidenceDigest: string;
}

/** Implemented by M11: load the named evaluation in the caller's transaction, or null when it does not exist. */
export interface RecoveryEvaluator {
  loadPassedEvaluation(
    c: Tx,
    ctx: TenantContext,
    incident: { readonly incidentId: string; readonly assetRevisionId: string; readonly version: number },
    recoveryEvaluationId: string,
  ): Promise<PassedRecoveryEvaluation | null>;
}

const RecoverSchema = z.strictObject({
  recoveryEvaluationId: z.string().regex(/^rev_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
  reasonCode: ReasonCodeSchema,
  expectedVersion: z.int().min(1),
  idempotencyKey: z.string().max(128),
});

const notPassed = () =>
  new DomainError('POLICY_HOLD', 'The recovery evaluation does not authorize recovery.', {
    reasonCode: 'RECOVERY_EVALUATION_NOT_PASSED',
  });

/**
 * VERIFYING -> RECOVERED for an engine worker, only when `evaluator` returns a PASSED evaluation for this exact
 * incident inside the same transaction (version compare-and-set, Idempotency-Key, M01 edge legality as usual).
 */
export async function recoverIncidentWithEvaluation(
  pool: Db,
  ctx: TenantContext,
  incidentId: string,
  raw: z.input<typeof RecoverSchema>,
  evaluator: RecoveryEvaluator,
): Promise<IncidentCommandResult> {
  const input = parseInput(RecoverSchema, raw);
  return command(
    pool,
    ctx,
    incidentId,
    { action: 'incident.recover', commandType: 'incident.recover.v1', authorize: 'incident.engine' },
    input,
    async (c, row) => {
      if (row.state !== 'VERIFYING')
        throw new DomainError('STATE_TRANSITION_INVALID', 'Only a verifying incident can recover.', {
          reasonCode: 'NOT_VERIFYING',
          currentState: row.state,
        });
      const evaluation = await evaluator.loadPassedEvaluation(
        c,
        ctx,
        { incidentId: row.id, assetRevisionId: row.asset_revision_id, version: row.version },
        input.recoveryEvaluationId,
      );
      if (
        !evaluation ||
        evaluation.state !== 'PASSED' ||
        evaluation.incidentId !== row.id ||
        evaluation.recoveryEvaluationId !== input.recoveryEvaluationId
      )
        throw notPassed();
      return resultOf(
        await transitionRow(c, ctx, row, 'RECOVERED', input.reasonCode, {
          guardRef: input.recoveryEvaluationId,
          extraSet: 'recovered_at = clock_timestamp()',
        }),
      );
    },
  );
}
