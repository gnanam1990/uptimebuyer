// T-021 (parsing layer) — Manual and BOM citation provenance starts with deterministic, bounded parsing: a real PDF
// manual yields page spans with content hashes, a CSV parts list yields record spans, and the parser never trusts
// declared media types, never executes active content and refuses document bombs and oversized inputs.
import { describe, expect, it } from 'vitest';
import { DOCUMENT_LIMITS, extractFacts, parseDocument } from '../src/index.js';
import { buildPdf } from './fixtures/pdf-builder.js';
import { MANUAL_REV_C_PAGES } from './fixtures/content.js';
import { fixture, sha256Of } from './helpers.js';

const reason = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { details?: { reasonCode?: string } }).details?.reasonCode;
  }
  throw new Error('expected rejection');
};

describe('T-021 document parsing provenance', () => {
  it('extracts one page span per PDF page with exact text and a content hash', () => {
    const doc = parseDocument(fixture('nwr-sm-48-rev-c.pdf'), 'application/pdf');
    expect(doc.extractionMethod).toBe('PDF_TEXT');
    expect(doc.pageCount).toBe(4);
    expect(doc.spans.map((s) => s.locator)).toEqual([1, 2, 3, 4].map((p) => ({ kind: 'PAGE', page: p, pageEnd: null })));
    const parts = doc.spans[3]!;
    expect(parts.text.split('\n')).toEqual([...MANUAL_REV_C_PAGES[3]]);
    expect(parts.textDigest).toBe(sha256Of(parts.text));
    expect(doc.activeContentRemoved).toEqual([]);
  });

  it('is deterministic: the same bytes always give the same spans and digests', () => {
    const a = parseDocument(fixture('nwr-sm-48-rev-c.pdf'), 'application/pdf');
    const b = parseDocument(fixture('nwr-sm-48-rev-c.pdf'), 'application/pdf');
    expect(b).toEqual(a);
  });

  it('extracts record spans keyed by the first column from a CSV parts list', () => {
    const doc = parseDocument(fixture('nwr-2d-48-bom-7.csv'), 'text/csv');
    expect(doc.extractionMethod).toBe('STRUCTURED_IMPORT');
    expect(doc.spans.map((s) => s.locator)).toEqual(
      ['BOM7-010', 'BOM7-020', 'BOM7-030', 'BOM7-040', 'BOM7-050'].map((k) => ({ kind: 'RECORD', recordKey: k })),
    );
    expect(doc.spans[3]!.text).toContain('component: Door gasket, left');
  });

  it('extracts exact part and specification facts without fuzzy matching', () => {
    const manual = parseDocument(fixture('nwr-sm-48-rev-c.pdf'), 'application/pdf');
    const facts = manual.spans.flatMap((s) => extractFacts(s.text, manual.extractionMethod, s.ordinal));
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ factKey: 'part:evaporator-fan-motor', value: '5A1-0402', spanOrdinal: 4 }),
        expect.objectContaining({ factKey: 'part:door-gasket-left', value: '2G4-0048' }),
        expect.objectContaining({ factKey: 'spec:refrigerant', value: 'R-290', spanOrdinal: 2 }),
        expect.objectContaining({ factKey: 'spec:rated-voltage', value: '115 V' }),
      ]),
    );
    const bom = parseDocument(fixture('nwr-2d-48-bom-7.csv'), 'text/csv');
    const bomFacts = bom.spans.flatMap((s) => extractFacts(s.text, bom.extractionMethod, s.ordinal));
    expect(bomFacts).toContainEqual(
      expect.objectContaining({ factKey: 'part:evaporator-fan-motor', value: '5A1-0402', spanOrdinal: 1 }),
    );
    // Prose that merely mentions a component never becomes a fact.
    expect(extractFacts('Check the evaporator fan motor 5A1-0402 for noise', 'PDF_TEXT', 1)).toEqual([]);
  });

  it('splits markdown into section spans and form-feed text into pages', () => {
    const md = parseDocument(Buffer.from('# Intro\nhello\n## Parts\nEvaporator fan motor ..... 5A1-0402\n'), 'text/markdown');
    expect(md.spans.map((s) => s.locator)).toEqual([
      { kind: 'SECTION', sectionPath: 'Intro' },
      { kind: 'SECTION', sectionPath: 'Intro > Parts' },
    ]);
    const txt = parseDocument(Buffer.from('page one\fpage two'), 'text/plain');
    expect(txt.spans.map((s) => [s.locator, s.text])).toEqual([
      [{ kind: 'PAGE', page: 1, pageEnd: null }, 'page one'],
      [{ kind: 'PAGE', page: 2, pageEnd: null }, 'page two'],
    ]);
  });

  it('drops active content (JavaScript, open actions) and records that it was removed', () => {
    const doc = parseDocument(buildPdf([['Hello manual']], { javascript: true }), 'application/pdf');
    expect(doc.spans[0]!.text).toBe('Hello manual');
    expect(doc.activeContentRemoved).toEqual(expect.arrayContaining(['JAVASCRIPT', 'OPEN_ACTION']));
    expect(JSON.stringify(doc)).not.toContain('app.alert');
  });

  it('rejects decompression bombs before materialising them', () => {
    const started = Date.now();
    const bomb = buildPdf([['x']], { bombInflatedBytes: 200 * 1024 * 1024 });
    expect(bomb.length).toBeLessThan(DOCUMENT_LIMITS.maxBytes);
    expect(reason(() => parseDocument(bomb, 'application/pdf'))).toBe('DOCUMENT_BOMB');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('rejects oversized, mistyped, encrypted, binary and over-long documents', () => {
    expect(reason(() => parseDocument(Buffer.alloc(DOCUMENT_LIMITS.maxBytes + 1, 0x41), 'text/plain'))).toBe(
      'DOCUMENT_TOO_LARGE',
    );
    expect(reason(() => parseDocument(Buffer.from('plain text'), 'application/pdf'))).toBe('MEDIA_TYPE_MISMATCH');
    expect(reason(() => parseDocument(fixture('nwr-sm-48-rev-c.pdf'), 'text/plain'))).toBe('MEDIA_TYPE_MISMATCH');
    expect(reason(() => parseDocument(buildPdf([['x']], { encrypted: true }), 'application/pdf'))).toBe(
      'PDF_ENCRYPTED',
    );
    expect(reason(() => parseDocument(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]), 'application/zip'))).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
    expect(reason(() => parseDocument(Buffer.from([0x41, 0xff, 0xfe, 0x41]), 'text/plain'))).toBe('TEXT_NOT_UTF8');
    expect(reason(() => parseDocument(Buffer.from('a\u0000b'), 'text/plain'))).toBe('TEXT_NOT_UTF8');
    const pages = Array.from({ length: DOCUMENT_LIMITS.maxPages + 1 }, (_, i) => [`page ${i + 1}`]);
    expect(reason(() => parseDocument(buildPdf(pages), 'application/pdf'))).toBe('TOO_MANY_PAGES');
    const rows = ['k,v', ...Array.from({ length: DOCUMENT_LIMITS.maxRecords + 1 }, (_, i) => `r${i},x`)].join('\n');
    expect(reason(() => parseDocument(Buffer.from(rows), 'text/csv'))).toBe('TOO_MANY_RECORDS');
    expect(reason(() => parseDocument(Buffer.from('k,v\na,1\na,2\n'), 'text/csv'))).toBe('DUPLICATE_RECORD_KEY');
  });

  it('bounds cumulative inflation across many individually small streams', () => {
    const quarter = DOCUMENT_LIMITS.maxInflatedBytes / 4;
    const one = buildPdf([['a'], ['b']], { bombInflatedBytes: quarter });
    expect(parseDocument(one, 'application/pdf').pageCount).toBe(2);
    const many = buildPdf(
      Array.from({ length: 6 }, (_, i) => [`p${i}`]),
      { bombInflatedBytes: quarter, bombEveryPage: true },
    );
    expect(reason(() => parseDocument(many, 'application/pdf'))).toBe('DOCUMENT_BOMB');
  });
});
