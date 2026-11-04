// T-040 structural guard (HIGH review finding): every path that can make the paid adapter act — first execution after
// linearization and same-key replay — goes through the ONE shared precondition function, so the paths cannot drift.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(import.meta.dirname, '..', 'src', 'broker.ts'), 'utf8');
function body(signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`missing ${signature}`);
  let depth = 0;
  for (let i = src.indexOf(' {\n', start) + 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

describe('T-040 one precondition function guards every paid execution path', () => {
  it('linearize and replaySameKey both call assertExecutionPreconditionsInTx', () => {
    expect(src).toMatch(/export async function assertExecutionPreconditionsInTx\(/);
    expect(body('private async linearize(')).toContain('assertExecutionPreconditionsInTx(');
    expect(body('private async replaySameKey(')).toContain('assertExecutionPreconditionsInTx(');
  });

  it('the adapter executes only after linearization (execute) or inside replaySameKey', () => {
    const calls = [...src.matchAll(/this\.opts\.adapter\.execute\(/g)].map((m) => m.index!);
    expect(calls).toHaveLength(2);
    const exec = body('async execute(reference: unknown)');
    const replay = body('private async replaySameKey(');
    for (const at of calls)
      expect(
        (src.indexOf(exec) <= at && at < src.indexOf(exec) + exec.length) ||
          (src.indexOf(replay) <= at && at < src.indexOf(replay) + replay.length),
      ).toBe(true);
    expect(exec.indexOf('this.linearize(')).toBeLessThan(exec.indexOf('this.opts.adapter.execute('));
  });
});
