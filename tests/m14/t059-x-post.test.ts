// T-059 (INV-12) X post drafts: each file under docs/release/x-post/ is the exact text X-DRAFT.md shows (no trailing
// newline, at most 280 characters), the recorded sha256 is the file's digest (the X_POST gate binds it), and the text
// makes only the claims the evidence supports.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../m00/helpers.js';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('T-059 X post texts', () => {
  const draft = read('docs/release/X-DRAFT.md');
  it.each([
    ['release-url.txt', true],
    ['repo-only.txt', true],
    ['template.txt', false],
  ])('%s is the exact text X-DRAFT.md shows, within 280 characters', (file, digestShown) => {
    const text = read(`docs/release/x-post/${file}`);
    expect(text.endsWith('\n')).toBe(false);
    expect([...text].length).toBeLessThanOrEqual(280);
    expect(draft).toContain(`\`\`\`text\n${text}\n\`\`\``);
    expect(draft).toContain(`docs/release/x-post/${file}`);
    if (digestShown) {
      expect(draft).toContain(sha(text));
      expect(draft).toContain(`${[...text].length} characters, sha256`);
    }
    for (const must of ['SERV Reasoning', 'Kite track', '1-cent Kite x402 payment', 'a SERV run', 'not yet'])
      expect(text, must).toContain(must);
    expect(text).toContain('github.com/gnanam1990/uptimebuyer');
  });
});
