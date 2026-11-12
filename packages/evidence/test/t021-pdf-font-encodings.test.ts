// T-021 (parsing layer) — font-encoded PDF text. The first real journey (j-2026-11-12-serv-document) showed that text
// set in Type0/Identity-H fonts came out as shifted glyph codes, so cited quotes could not match what the manual says.
// The parser now decodes text through each font's ToUnicode CMap (bfchar, both bfrange forms, 1- and 2-byte codes),
// a simple font's /Encoding /Differences through standard glyph names, and Type0/Identity-H only when ToUnicode is
// present. Anything it cannot decode fails closed: it is withheld (U+FFFD, recorded in textWithheld), never shown as
// garbage text. CMaps are bounded (size, mappings per CMap and per document, fonts per document) and malformed CMaps are
// refused without throwing away the rest of the document.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_LIMITS, PARSER_VERSION, parseDocument } from '../src/index.js';
import {
  addHelvetica,
  addType0Font,
  buildFontPdf,
  glyphIds,
  toUnicodeCMap,
  utf16Hex,
  type PdfGraph,
} from './fixtures/font-pdf-builder.js';

const W = '�';
const repo = path.resolve(import.meta.dirname, '..', '..', '..');
const MANUAL = path.join(repo, 'evidence', 'journeys', 'j-2026-11-12-serv-document', 'XR60CX-GB.pdf');

const reason = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { details?: { reasonCode?: string } }).details?.reasonCode;
  }
  throw new Error('expected rejection');
};
const pdfText = (bytes: Buffer, limits = DOCUMENT_LIMITS) => {
  const doc = parseDocument(bytes, 'application/pdf', limits);
  return { doc, text: doc.spans.map((s) => s.text).join('\n') };
};
/** A page whose first line is plain WinAnsi text (so the page always has extractable text) followed by `ops`. */
const withAnchor = (ops: string) => `BT /F1 10 Tf 72 740 Td (Anchor line) Tj 0 -20 Td ${ops} ET`;
const cmapStream = (g: PdfGraph, body: string, codespace?: string) => g.stream('', toUnicodeCMap(body, codespace));
const hasLoneSurrogate = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('T-021 PDF font encodings: ToUnicode, Differences and Identity-H', () => {
  it('decodes a simple font through a ToUnicode bfchar CMap with 1-byte codes', () => {
    const bytes = buildFontPdf((g) => {
      const tu = cmapStream(
        g,
        `5 beginbfchar\n<01> <0048>\n<02> <0065>\n<03> <006C>\n<04> <006F>\n<05> <0021>\nendbfchar`,
        '<00> <FF>',
      );
      const f = g.add(`<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEE+Custom /FirstChar 1 /LastChar 5 /ToUnicode ${tu} 0 R >>`);
      return [{ fonts: `/F1 ${f} 0 R`, content: 'BT /F1 12 Tf 72 700 Td <0102030304> Tj (\\005) Tj ET' }];
    });
    const { doc, text } = pdfText(bytes);
    expect(text).toBe('Hello!');
    expect(doc.textWithheld).toEqual([]);
  });

  it('decodes Type0 / Identity-H text through bfrange (incrementing and array forms) and multi-character bfchar', () => {
    const bytes = buildFontPdf((g) => {
      const tu = cmapStream(
        g,
        [
          '1 beginbfchar\n<0003> <0020>\nendbfchar',
          '2 beginbfrange\n<0024> <003D> <0041>\n<0044> <005D> <0061>\nendbfrange',
          '1 beginbfrange\n<00B3> <00B6> [<201C> <201D> <00F7> <2019>]\nendbfrange',
          `1 beginbfchar\n<00C0> <${utf16Hex('fi')}>\nendbfchar`,
        ].join('\n'),
      );
      const f1 = addHelvetica(g);
      const f2 = addType0Font(g, { toUnicode: tu });
      // "Maximum temperature alarm" / “SET÷ALU” it’s / "fine" (with the fi ligature glyph) — all as 2-byte glyph ids.
      const enc = (s: string) =>
        [...s]
          .map((ch) => {
            if (ch === ' ') return '0003';
            const c = ch.charCodeAt(0);
            if (c >= 0x41 && c <= 0x5a) return (0x24 + c - 0x41).toString(16).padStart(4, '0');
            if (c >= 0x61 && c <= 0x7a) return (0x44 + c - 0x61).toString(16).padStart(4, '0');
            return { '“': '00B3', '”': '00B4', '÷': '00B5', '’': '00B6' }[ch]!;
          })
          .join('')
          .toUpperCase();
      return [
        {
          fonts: `/F1 ${f1} 0 R /F2 ${f2} 0 R`,
          content: withAnchor(
            `/F2 9 Tf [<${enc('Maximum')}> -300 <${enc('temperature alarm')}>] TJ 0 -12 Td <${enc('“SET÷ALU” it’s')}> Tj 0 -12 Td <00C0${enc('ne')}> Tj`,
          ),
        },
      ];
    });
    const { doc, text } = pdfText(bytes);
    expect(text.split('\n')).toEqual(['Anchor line', 'Maximum temperature alarm', '“SET÷ALU” it’s', 'fine']);
    expect(doc.textWithheld).toEqual([]);
  });

  it('keeps the font across BT blocks and restores it with Q', () => {
    const ids = glyphIds('Probe failure');
    const bytes = buildFontPdf((g) => {
      const tu = cmapStream(g, ids.bfchar());
      const f1 = addHelvetica(g);
      const f2 = addType0Font(g, { toUnicode: tu });
      return [
        {
          fonts: `/F1 ${f1} 0 R /F2 ${f2} 0 R`,
          content: [
            'BT /F1 10 Tf 72 740 Td (Start) Tj ET',
            `q BT /F2 10 Tf ${ids.hex('Probe')} Tj ET BT ${ids.hex('failure')} Tj ET Q`,
            'BT (End) Tj ET',
          ].join('\n'),
        },
      ];
    });
    expect(pdfText(bytes).text.split('\n')).toEqual(['Start', 'Probe', 'failure', 'End']);
  });

  it('maps /Encoding /Differences through standard glyph names and withholds unknown names', () => {
    const bytes = buildFontPdf((g) => {
      const enc = g.add(
        '<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [ 1 /T /e /m /p /space /degree /C 128 /fi /endash /uni00B1 200 /g17 ] >>',
      );
      const f1 = g.add(`<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEE+Custom /Encoding ${enc} 0 R >>`);
      const f2 = g.add(
        '<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEE+Inline /Encoding << /Differences [ 65 /Z 66 /quotedblleft /quotedblright ] >> >>',
      );
      return [
        {
          fonts: `/F1 ${f1} 0 R /F2 ${f2} 0 R`,
          content: 'BT /F1 10 Tf 72 740 Td (\\001\\002\\003\\004\\005\\006\\007) Tj 0 -12 Td (\\200ne \\201 \\202 OK \\310) Tj ET\nBT /F2 10 Tf (ABCa) Tj ET',
        },
      ];
    });
    const { doc, text } = pdfText(bytes);
    expect(text.split('\n')).toEqual(['Temp °C', `fine – ± OK ${W}`, 'Z“”a']);
    expect(doc.textWithheld).toEqual(['GLYPH_UNMAPPED']);
  });

  it('withholds Type0 / Identity-H text that has no ToUnicode instead of emitting shifted glyph codes', () => {
    const ids = glyphIds('temperature exceeds');
    const bytes = buildFontPdf((g) => {
      const f1 = addHelvetica(g);
      const f2 = addType0Font(g, { toUnicode: null });
      return [{ fonts: `/F1 ${f1} 0 R /F2 ${f2} 0 R`, content: withAnchor(`/F2 9 Tf ${ids.hex('temperature exceeds')} Tj`) }];
    });
    const { doc, text } = pdfText(bytes);
    expect(text.split('\n')).toEqual(['Anchor line', W]);
    expect(doc.textWithheld).toEqual(['FONT_ENCODING_UNKNOWN']);
  });

  it('withholds a symbolic simple font with no ToUnicode and no known encoding', () => {
    const bytes = buildFontPdf((g) => {
      const f1 = addHelvetica(g);
      const fd = g.add('<< /Type /FontDescriptor /FontName /ABCDEE+Glyphs /Flags 4 /ItalicAngle 0 >>');
      const f2 = g.add(`<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEE+Glyphs /FontDescriptor ${fd} 0 R >>`);
      const f3 = g.add('<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEE+Odd /Encoding /CustomVendorEncoding >>');
      return [
        { fonts: `/F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R`, content: withAnchor('/F2 9 Tf (Hidden) Tj 0 -12 Td /F3 9 Tf (Odd) Tj') },
      ];
    });
    const { doc, text } = pdfText(bytes);
    expect(text.split('\n')).toEqual(['Anchor line', W, W]);
    expect(doc.textWithheld).toEqual(['FONT_ENCODING_UNKNOWN']);
  });

  it('rejects a PDF whose only text is undecodable (no garbage spans)', () => {
    const ids = glyphIds('Defrost');
    const bytes = buildFontPdf((g) => {
      const f = addType0Font(g, { toUnicode: null });
      return [{ fonts: `/F1 ${f} 0 R`, content: `BT /F1 9 Tf 72 700 Td ${ids.hex('Defrost')} Tj ET` }];
    });
    expect(reason(() => parseDocument(bytes, 'application/pdf'))).toBe('PDF_TEXT_UNAVAILABLE');
  });

  it('resolves fonts inherited from the page tree and through indirect resource and font dictionaries', () => {
    const ids = glyphIds('Door open');
    const bytes = buildFontPdf(
      (g) => {
        const f1 = addHelvetica(g);
        const fontDict = g.add(`<< /F1 ${f1} 0 R >>`);
        const resources = g.add(`<< /Font ${fontDict} 0 R >>`);
        return [
          { content: `BT /F2 9 Tf 72 700 Td ${ids.hex('Door open')} Tj ET` },
          { resources: `${resources} 0 R`, content: 'BT /F1 9 Tf 72 700 Td (Indirect) Tj ET' },
        ];
      },
      { inheritedFonts: (g) => `/F2 ${addType0Font(g, { toUnicode: cmapStream(g, ids.bfchar()) })} 0 R` },
    );
    expect(pdfText(bytes).doc.spans.map((s) => s.text)).toEqual(['Door open', 'Indirect']);
  });
});

describe('T-021 PDF font encodings: hostile CMaps and fonts (security review)', () => {
  const type0With = (cmap: (g: PdfGraph) => number, text = '<0024>') =>
    buildFontPdf((g) => {
      const f1 = addHelvetica(g);
      const f2 = addType0Font(g, { toUnicode: cmap(g) });
      return [{ fonts: `/F1 ${f1} 0 R /F2 ${f2} 0 R`, content: withAnchor(`/F2 9 Tf ${text} Tj`) }];
    });

  it.each([
    ['odd hex digits', '1 beginbfchar\n<024> <0041>\nendbfchar'],
    ['non-hex destination', '1 beginbfchar\n<0024> <00ZZ>\nendbfchar'],
    ['unterminated block', '1 beginbfchar\n<0024> <0041>\n'],
    ['bfrange array length mismatch', '1 beginbfrange\n<0024> <0026> [<0041> <0042>]\nendbfrange'],
    ['inverted bfrange', '1 beginbfrange\n<0030> <0024> <0041>\nendbfrange'],
    ['source wider than the codespace', '1 beginbfchar\n<000024> <0041>\nendbfchar'],
    ['usecmap (no chained CMaps)', '/Adobe-Japan1-UCS2 usecmap\n1 beginbfchar\n<0024> <0041>\nendbfchar'],
    ['destination longer than the bound', `1 beginbfchar\n<0024> <${'0041'.repeat(40)}>\nendbfchar`],
  ])('refuses a malformed CMap (%s): the font is withheld, the rest of the page survives', (_label, body) => {
    const { doc, text } = pdfText(type0With((g) => cmapStream(g, body)));
    expect(text.split('\n')).toEqual(['Anchor line', W]);
    expect(doc.textWithheld).toEqual(['CMAP_REFUSED']);
  });

  it('refuses a 3-byte codespace (only 1- and 2-byte codes are supported)', () => {
    const { doc, text } = pdfText(type0With((g) => cmapStream(g, '1 beginbfchar\n<000024> <0041>\nendbfchar', '<000000> <FFFFFF>')));
    expect(text.split('\n')).toEqual(['Anchor line', W]);
    expect(doc.textWithheld).toEqual(['CMAP_REFUSED']);
  });

  it('a ToUnicode reference that is not a stream, or that points at itself, is refused without recursion', () => {
    const bytes = buildFontPdf((g) => {
      const f1 = addHelvetica(g);
      const self = g.reserve();
      g.set(self, `${self} 0 R`);
      const f2 = addType0Font(g, { toUnicode: self });
      const loopA = g.reserve();
      const loopB = g.add(`${loopA} 0 R`);
      g.set(loopA, `${loopB} 0 R`);
      return [
        { fonts: `/F1 ${f1} 0 R /F2 ${f2} 0 R`, content: withAnchor('/F2 9 Tf <0024> Tj') },
        { resources: `${loopA} 0 R`, content: 'BT /F9 9 Tf 72 700 Td (Cycle) Tj ET' },
      ];
    });
    const start = performance.now();
    const { doc } = pdfText(bytes);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(doc.spans[0]!.text.split('\n')).toEqual(['Anchor line', W]);
    expect(doc.textWithheld).toEqual(expect.arrayContaining(['CMAP_REFUSED']));
  });

  it('withholds invalid destination code points: lone surrogates, controls, non-characters, bidi overrides, private use', () => {
    const body = [
      '7 beginbfchar',
      '<0001> <D800>',
      '<0002> <0007>',
      '<0003> <FFFE>',
      '<0004> <202E>',
      '<0005> <E000>',
      '<0006> <DBFFDFFF>',
      '<0007> <0041>',
      'endbfchar',
      '1 beginbfrange\n<0010> <0017> <D7FC>\nendbfrange',
      '1 beginbfrange\n<0020> <0023> <FFFE>\nendbfrange',
    ].join('\n');
    const codes = ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0010', '0013', '0014', '0017', '0021', '0023'];
    const { doc, text } = pdfText(type0With((g) => cmapStream(g, body), `<${codes.join('')}>`));
    const line = text.split('\n')[1]!;
    expect(line.replace(new RegExp(`${W}+`, 'g'), W)).toBe(`${W}A퟼퟿${W}`);
    expect(hasLoneSurrogate(text)).toBe(false);
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩-￾￿]/);
    expect(doc.textWithheld).toEqual(['CODE_POINT_INVALID']);
  });

  it('rejects a CMap stream larger than maxCMapBytes', () => {
    const big = `100 beginbfchar\n${Array.from({ length: 100 }, (_, i) => `<${(0x100 + i).toString(16).padStart(4, '0')}> <0041>`).join('\n')}\nendbfchar`;
    const bytes = type0With((g) => cmapStream(g, big));
    expect(reason(() => parseDocument(bytes, 'application/pdf', { ...DOCUMENT_LIMITS, maxCMapBytes: 1_024 }))).toBe(
      'CMAP_TOO_LARGE',
    );
  });

  it('rejects a CMap bomb of repeated full-range bfranges quickly, before expanding it', () => {
    const body = `100 beginbfrange\n${'<0000> <FFFF> <0041>\n'.repeat(100)}endbfrange`;
    const bytes = type0With((g) => cmapStream(g, body));
    const start = performance.now();
    expect(reason(() => parseDocument(bytes, 'application/pdf'))).toBe('CMAP_TOO_LARGE');
    expect(performance.now() - start).toBeLessThan(1_500);
  });

  it('bounds CMap mappings across all fonts of a document and the number of fonts', () => {
    const range = '1 beginbfrange\n<0000> <EFFF> <4E00>\nendbfrange';
    const many = buildFontPdf((g) => {
      const f1 = addHelvetica(g);
      const fonts = Array.from({ length: 20 }, (_, i) => `/T${i} ${addType0Font(g, { toUnicode: cmapStream(g, range) })} 0 R`);
      const ops = Array.from({ length: 20 }, (_, i) => `/T${i} 9 Tf <0024> Tj`).join(' ');
      return [{ fonts: `/F1 ${f1} 0 R ${fonts.join(' ')}`, content: withAnchor(ops) }];
    });
    expect(reason(() => parseDocument(many, 'application/pdf'))).toBe('CMAP_TOO_LARGE');
    const fontsBytes = buildFontPdf((g) => {
      const f1 = addHelvetica(g);
      const fonts = Array.from({ length: 12 }, (_, i) => `/H${i} ${addHelvetica(g)} 0 R`);
      const ops = Array.from({ length: 12 }, (_, i) => `/H${i} 9 Tf (x) Tj`).join(' ');
      return [{ fonts: `/F1 ${f1} 0 R ${fonts.join(' ')}`, content: withAnchor(ops) }];
    });
    expect(reason(() => parseDocument(fontsBytes, 'application/pdf', { ...DOCUMENT_LIMITS, maxFonts: 8 }))).toBe('TOO_MANY_FONTS');
  });

  it('many font switches in one content stream decode in linear time (fonts are resolved once)', () => {
    const ids = glyphIds('ab');
    const bytes = buildFontPdf((g) => {
      const f1 = addHelvetica(g);
      const f2 = addType0Font(g, { toUnicode: cmapStream(g, ids.bfchar()) });
      const ops = Array.from({ length: 40_000 }, (_, i) => (i % 2 ? `/F1 9 Tf (a) Tj` : `/F2 9 Tf ${ids.hex('b')} Tj`)).join('\n');
      return [{ fonts: `/F1 ${f1} 0 R /F2 ${f2} 0 R`, content: withAnchor(ops) }];
    });
    const start = performance.now();
    const { text } = pdfText(bytes);
    expect(performance.now() - start).toBeLessThan(1_500);
    // The 40,000-character line is chunked into maxSpanChars spans; joined back it is exact.
    expect(text.split('\n').slice(1).join('')).toBe('ba'.repeat(20_000));
  });

  it('encoding names that collide with object prototype keys are unknown encodings, never decoded', () => {
    const bytes = buildFontPdf((g) => {
      const f1 = addHelvetica(g);
      const names = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];
      const named = names.map((n) => g.add(`<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEE+X /Encoding /${n} >>`));
      const based = names.map((n) =>
        g.add(`<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEE+X /Encoding << /BaseEncoding /${n} >> >>`),
      );
      const all = [...named, ...based];
      const fonts = all.map((id, i) => `/P${i} ${id} 0 R`).join(' ');
      const ops = all.map((_, i) => `0 -10 Td /P${i} 9 Tf (AB) Tj`).join(' ');
      return [{ fonts: `/F1 ${f1} 0 R ${fonts}`, content: `BT /F1 9 Tf 72 740 Td (Anchor line) Tj ${ops} ET` }];
    });
    const { doc, text } = pdfText(bytes);
    expect(text.split('\n')).toEqual(['Anchor line', ...Array.from({ length: 8 }, () => W)]);
    expect(text).not.toContain('[object');
    expect(doc.textWithheld).toEqual(['FONT_ENCODING_UNKNOWN']);
  });

  it('an oversized font object shared by many font resources is not re-scanned per font (linear time)', () => {
    const bytes = buildFontPdf((g) => {
      const f1 = addHelvetica(g);
      const big = g.add(
        `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /Pad [${' 0'.repeat(1_000_000)}] >>`,
      );
      const fonts = Array.from({ length: 400 }, (_, i) => `/H${i} ${g.add(`${big} 0 R`)} 0 R`);
      const ops = Array.from({ length: 400 }, (_, i) => `/H${i} 9 Tf (x) Tj`).join(' ');
      return [{ fonts: `/F1 ${f1} 0 R ${fonts.join(' ')}`, content: withAnchor(ops) }];
    });
    const start = performance.now();
    const { doc, text } = pdfText(bytes);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(text.split('\n')).toEqual(['Anchor line', W]);
    expect(doc.textWithheld).toEqual(['FONT_ENCODING_UNKNOWN']);
  });

  it('the PDF parser modules reach no network and load no font programs', () => {
    for (const file of ['pdf.ts', 'cmap.ts']) {
      const src = readFileSync(path.join(repo, 'packages', 'evidence', 'src', file), 'utf8');
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(imports.every((m) => m === 'node:zlib' || m!.startsWith('./'))).toBe(true);
      expect(src).not.toMatch(/\bfetch\(|node:(https?|net|tls|dns|dgram|child_process)/);
    }
  });
});

describe('T-021 real manual: Dixell XR60CX (j-2026-11-12-serv-document)', () => {
  const bytes = readFileSync(MANUAL);
  const page = (doc: ReturnType<typeof parseDocument>, n: number) =>
    doc.spans
      .filter((s) => s.locator.kind === 'PAGE' && s.locator.page === n)
      .map((s) => s.text)
      .join('\n');

  it('is the committed manual (SHA-256 bound to the journey record)', async () => {
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '5b6f58295e0bbb4ba547fdd6d3b80509f2d5ccf7e6879ddbcd077d8855fe095f',
    );
  });

  it('extracts the Identity-H (ToUnicode) text as the visible words, with no shifted glyph codes', () => {
    const doc = parseDocument(bytes, 'application/pdf');
    expect(doc.parserVersion).toBe('uptimebuyer-parser.v3');
    expect(doc.pageCount).toBe(5);
    const p1 = page(doc, 1);
    expect(p1).toContain('send the instrument back to the distributor or to “Dixell');
    expect(p1).toContain('with a detailed description of the fault.');
    const p3 = page(doc, 3);
    expect(p3).toContain('Temperature alarm is enabled when the');
    expect(p3).toContain('temperature exceeds the “SET+ALU” or “SET');
    expect(p3).toContain('MAXIMUM temperature alarm');
    expect(p3).toContain('the alarm is enabled, after the “ALd” delay time.');
    expect(p3).toContain('differential for recovery of temperature alarm. It’s also used for the restart of the fan when the');
    expect(p3).toContain('(SET÷110°C; SET÷230°F) when this temperature is reached');
    const p4 = page(doc, 4);
    expect(p4).toContain('“HA”');
    expect(p4).toContain('Maximum temperature alarm');
    expect(p4).toContain('It depends on the “Ac2” parameter');
    const all = doc.spans.map((s) => s.text).join('\n');
    // The legacy decoder printed "temperature" in the Identity-H font as these shifted, letter-spaced codes.
    expect(all).not.toContain('W H P S H U D W X U H');
    expect(all).not.toMatch(/(?:[A-Za-z$&+,/] ){8,}/);
    expect(hasLoneSurrogate(all)).toBe(false);
    expect(doc.textWithheld).toEqual([]);
  });

  it('re-derives the legacy v2 extraction byte-for-byte when asked for the recorded parser version', () => {
    const legacy = parseDocument(bytes, 'application/pdf', DOCUMENT_LIMITS, { parserVersion: 'uptimebuyer-parser.v2' });
    expect(legacy.parserVersion).toBe('uptimebuyer-parser.v2');
    // Span digests produced by uptimebuyer-parser.v2 at main 0d44db5 (before the font decoder existed).
    expect(legacy.spans.map((s) => s.textDigest)).toEqual([
      'sha256:2b79ad271aac49082ba951014e33feb739f84ccca17c9efe7f7c2749903367b3',
      'sha256:dc6b798697f844b044eec7d5a8800c7cb4af673efe48ddb5bb37c31b29ba2a87',
      'sha256:04ef1ed98e914773d6f46e797b0432504c3ede603b73ae9c55978a0cd2f0e5d0',
      'sha256:a30478288e49b3cb6997bc397e2cb2826dad724aeca025c02b361c530fb0e0b0',
      'sha256:38a7dda8316b5d63c1d7024f087e489f2e8fd51a7f1b836c4e6b226696da0963',
      'sha256:f9d26fe3df73065229c9dfe7804ba58b7baed19bd74fdfc52bc47e7ef92176e6',
      'sha256:6948ab6ec6b5f92455c7a72fe78ba036d86a15bcd5767bf813d3ed6acccd1224',
      'sha256:c44477a9ea41bd46f68648ee0c18a836e72aeb08e677c132f3a20f13f7f1df52',
      'sha256:6f4c551ef25df9b57b5fffd4d42f2f905d6052d28ddd0171b076a5ff84f05056',
      'sha256:73ca87556ffc563141d43a01db5e4bffda3eb8268bbbb43111181cd03d82a603',
      'sha256:70441c5591cd6409ab7310f831240ee9d996e48ff6eae963254ae7f813fc5950',
      'sha256:84cb86845dfdde49bdead3157552af572324edda8e446721fe45c003b1e49663',
      'sha256:3b9154b93a8b2af8bc7a6b916cc8e94d09768d2f65bf9972628bab53dc031517',
      'sha256:8566566f4976ddd843993830e019fa19ada2fd0e2363527180a79f9083d3b57e',
    ]);
  });

  it('the fixture manuals (WinAnsi only) extract identically under v2 and v3', () => {
    for (const name of ['nwr-sm-48-rev-b.pdf', 'nwr-sm-48-rev-c.pdf']) {
      const b = readFileSync(path.join(repo, 'packages', 'evidence', 'test', 'fixtures', name));
      const v3 = parseDocument(b, 'application/pdf');
      const v2 = parseDocument(b, 'application/pdf', DOCUMENT_LIMITS, { parserVersion: 'uptimebuyer-parser.v2' });
      expect(v3.spans.map((s) => s.textDigest)).toEqual(v2.spans.map((s) => s.textDigest));
    }
  });

  it('the current parser version is v3 and an unknown recorded version is refused', () => {
    expect(PARSER_VERSION).toBe('uptimebuyer-parser.v3');
    expect(
      reason(() => parseDocument(bytes, 'application/pdf', DOCUMENT_LIMITS, { parserVersion: 'uptimebuyer-parser.v9' })),
    ).toBe('PARSER_VERSION_UNSUPPORTED');
  });
});
