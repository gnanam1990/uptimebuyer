// T-058 (M14, FR-22, INV-12) real-input journey gate, database layer. A recovered incident produced by the local
// harness (recorded-contract broker, contract-fake reasoning, contract-fake CMMS, operator-reported trigger) is read
// back by the gate's database cross-check; every part the database labels non-real is refused, and a manifest that
// falsely claims real origins for that incident cannot pass. The cross-check can only REFUSE what the database itself
// labels as simulated or recorded: it never proves realness on its own (a fixture device registered as a physical
// sensor reads as physical), which is why the gate also requires source-bound artifacts and a recorded authorization.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRecoveryWorld, recoveredIncident, type RecoveryWorld } from './m11-helpers.js';

const repo = path.resolve(import.meta.dirname, '..', '..', '..');
const gate = await import(path.join(repo, 'scripts', 'release', 'journey-gate.mjs'));

let w: RecoveryWorld;
let incidentId: string;
beforeAll(async () => {
  w = await createRecoveryWorld('m14journey');
  incidentId = (await recoveredIncident(w)).inc.incidentId;
});
afterAll(async () => {
  await w?.close();
});

describe('T-058 journey gate: database cross-check refuses simulated and recorded evidence', () => {
  it('labels the harness incident parts with their recorded, non-real origins', async () => {
    const facts = await gate.collectDatabaseFacts(w.db.pool, { tenantId: w.tenant.tenantId, incidentId });
    expect(facts.payment).toMatchObject({ origin: 'RECORDED_CONTRACT', real: false });
    expect(facts.sensor.real).toBe(false);
    expect(['OPERATOR_REPORT', 'SIMULATED_INPUT']).toContain(facts.sensor.origin);
    expect(facts.reasoning.real).toBe(false);
    expect(['CONTRACT_FAKE', 'ABSENT']).toContain(facts.reasoning.origin);
    expect(facts.recovery.real).toBe(false);
  });

  it('a manifest claiming real origins for that incident fails on the database facts', async () => {
    const facts = await gate.collectDatabaseFacts(w.db.pool, { tenantId: w.tenant.tenantId, incidentId });
    const at = new Date().toISOString();
    const claim = (part: string) => ({ origin: gate.REAL_ORIGINS[part], capturedAt: at, artifacts: [] });
    const manifest = {
      schema: 'real-input-journey.v1',
      journeyId: 'jrn-forged',
      sourceSha: 'e'.repeat(40),
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      endedAt: new Date(Date.now() + 3_600_000).toISOString(),
      parts: Object.fromEntries(gate.JOURNEY_PARTS.map((p: string) => [p, claim(p)])),
    };
    const r = gate.evaluateJourney(manifest, {
      artifactRoot: repo,
      expectedSha: 'e'.repeat(40),
      simulatedDigests: new Set<string>(),
      isAuthorized: () => true,
      databaseFacts: facts,
    });
    expect(r.result).toBe('FAIL');
    for (const part of ['sensor', 'reasoning', 'payment', 'recovery']) {
      const p = r.parts.find((x: { part: string }) => x.part === part);
      expect(p.status, part).toBe('FAIL');
      expect(p.reasons.join(' '), part).toMatch(/DATABASE_ORIGIN/);
    }
  });

  it('refuses to read another tenant’s incident (unknown incident reads as ABSENT, not as evidence)', async () => {
    const facts = await gate.collectDatabaseFacts(w.db.pool, {
      tenantId: 'ten_01HZZZZZZZZZZZZZZZZZZZZZZZ',
      incidentId,
    });
    for (const part of ['sensor', 'reasoning', 'payment', 'recovery'])
      expect(facts[part], part).toMatchObject({ origin: 'ABSENT', real: false });
  });
});
