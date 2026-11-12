// T-023 (prompt boundary) — the first real SERV run (j-2026-11-12-serv-document) cited the asset snapshot's serial
// under a manual citation id with an invented RECORD locator, and was rejected by the citation validator. The validator
// stays as strict as it is; the system prompt (which is digested into every run's input and config) now says plainly
// where citations come from, that get_asset_snapshot has none, and how withheld (undecodable) text is shown.
import { describe, expect, it } from 'vitest';
import { PROMPT_TEMPLATE_DIGEST, SYSTEM_PROMPT } from '../src/index.js';

describe('T-023 reasoning system prompt: citation provenance', () => {
  it('names the only sources of citation ids and forbids re-labelling a citation', () => {
    expect(SYSTEM_PROMPT).toContain('Cite only citationIds that appear in packet.excerpts or in search_evidence results');
    expect(SYSTEM_PROMPT).toContain("copy that citation's own sourceDigest and locator unchanged");
  });

  it('says the asset snapshot carries no citation and uncitable fields are left out', () => {
    expect(SYSTEM_PROMPT).toContain('get_asset_snapshot returns no citation');
    expect(SYSTEM_PROMPT).toContain('never cite its values under a document citationId');
  });

  it('says how withheld, undecodable document text is shown', () => {
    expect(SYSTEM_PROMPT).toContain('could not be decoded from the document');
  });

  it('the prompt digest moved with the text (recorded in ADR 0002)', () => {
    expect(PROMPT_TEMPLATE_DIGEST).not.toBe(
      'reasoning-prompt.v1:sha256:7664289643c557f8448fd4c3265de64f8a4da7bea18855d4c08629eac6218267',
    );
  });
});
