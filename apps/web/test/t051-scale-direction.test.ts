// T-051: the thermal scale's colour direction follows the threshold comparator in every state. For a lower-bound
// threshold the cold end is the danger side, and the simulated hatch must not repaint it as the safe side.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.join(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8');

/** The background declaration of the last rule whose selector is exactly `selector`. */
export function lastRuleBody(source: string, selector: string): string | null {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  let body: string | null = null;
  for (const m of source.matchAll(re)) body = m[1] ?? null;
  return body;
}

describe('T-051 thermal scale direction', () => {
  it('a simulated lower-bound scale keeps its danger colour at the cold end under the hatch', () => {
    const body = lastRuleBody(css, ".scale[data-danger='below'][data-state='simulated'] .scale-fill");
    expect(body, 'no rule for a simulated lower-bound scale').not.toBeNull();
    expect(body).toMatch(/repeating-linear-gradient/);
    expect(body).toMatch(/var\(--hot\)\s+0%/);
    expect(body).toMatch(/var\(--ice\)\s+100%/);
  });
});
