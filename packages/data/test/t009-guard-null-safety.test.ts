// T-009 static tripwire for ADR 0004 (every RAISE guard must be NULL-safe). A PL/pgSQL `IF NOT (<cond>) THEN RAISE`
// skips the RAISE when <cond> is NULL, which is how 0013's contact-point guard failed open. Migrations from 0017 on
// may only use that shape when the condition is visibly NULL-safe (coalesce or IS [NOT] DISTINCT FROM); otherwise
// write `IF coalesce(<allowed>, false) IS NOT TRUE THEN RAISE ...`. Files before 0017 are covered by the ADR audit.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(import.meta.dirname, '..', 'migrations');
const FIRST_CHECKED = 17;

/** Every `IF NOT ( ... ) THEN` condition (comments stripped) that has no visible NULL-safety construct. */
function unsafeNegatedGuards(sql: string): string[] {
  const code = sql.replace(/--[^\n]*/g, '');
  const out: string[] = [];
  for (const m of code.matchAll(/\bIF\s+NOT\s*\(([\s\S]*?)\bTHEN\b/gi)) {
    const cond = m[1]!;
    if (!/\bcoalesce\s*\(|\bIS\s+(NOT\s+)?DISTINCT\s+FROM\b/i.test(cond)) out.push(cond.replace(/\s+/g, ' ').trim());
  }
  return out;
}

describe('T-009 SQL guard NULL-safety tripwire (ADR 0004)', () => {
  it('flags a bare IF NOT (...) guard and accepts the NULL-safe shapes', () => {
    expect(unsafeNegatedGuards(`IF NOT (latest = 'VERIFIED' OR cp.x = NEW.y) THEN RAISE EXCEPTION 'no';`)).toHaveLength(
      1,
    );
    expect(unsafeNegatedGuards(`if not(a = b)\n then raise exception 'no';`)).toHaveLength(1);
    expect(unsafeNegatedGuards(`IF NOT (coalesce(a = b, false)) THEN RAISE EXCEPTION 'no';`)).toEqual([]);
    expect(unsafeNegatedGuards(`IF NOT (a IS NOT DISTINCT FROM b) THEN RAISE EXCEPTION 'no';`)).toEqual([]);
    expect(unsafeNegatedGuards(`IF coalesce(a = b, false) IS NOT TRUE THEN RAISE EXCEPTION 'no';`)).toEqual([]);
    expect(unsafeNegatedGuards(`IF NOT EXISTS (SELECT 1) THEN RAISE EXCEPTION 'no';`)).toEqual([]);
    expect(unsafeNegatedGuards(`IF NOT FOUND THEN RAISE EXCEPTION 'no';`)).toEqual([]);
    expect(unsafeNegatedGuards(`-- IF NOT (a = b) THEN in a comment\nSELECT 1;`)).toEqual([]);
  });

  it('would have caught the 0013 contact-point guard that failed open', () => {
    const legacy = readFileSync(path.join(migrationsDir, '0013_m07_contact_point_review.sql'), 'utf8');
    expect(unsafeNegatedGuards(legacy)).toEqual([expect.stringContaining("latest = 'VERIFIED'")]);
  });

  it(`migrations from ${String(FIRST_CHECKED).padStart(4, '0')} on use only NULL-safe negated guards`, () => {
    const files = readdirSync(migrationsDir).filter(
      (f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) >= FIRST_CHECKED,
    );
    expect(files.length).toBeGreaterThan(0);
    const findings = files.flatMap((f) =>
      unsafeNegatedGuards(readFileSync(path.join(migrationsDir, f), 'utf8')).map((cond) => `${f}: IF NOT (${cond}`),
    );
    expect(findings).toEqual([]);
  });
});
