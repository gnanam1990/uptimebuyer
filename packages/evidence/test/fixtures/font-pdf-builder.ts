// Minimal PDF object-graph writer for font-encoding tests (T-021): the caller adds font, CMap and encoding objects and
// one or more pages with their own resources and content, so a test can build exactly the font construct it needs
// (ToUnicode bfchar/bfrange, /Differences, Type0 Identity-H, inherited resources, reference cycles). It writes a
// classic xref table and trailer; content and CMap streams are FlateDecode unless `compress: false`.
import { deflateSync } from 'node:zlib';

export class PdfGraph {
  private readonly objects: Buffer[] = [];

  /** Add an object body (dictionary, array or any token sequence) and return its object number. */
  add(body: string | Buffer): number {
    this.objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
    return this.objects.length;
  }

  /** Reserve an object number to fill later with `set` (forward references, cycles). */
  reserve(): number {
    return this.add('null');
  }

  set(id: number, body: string | Buffer): void {
    this.objects[id - 1] = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
  }

  /** Add a stream object. */
  stream(dict: string, data: string | Buffer, opts: { compress?: boolean } = {}): number {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    const compress = opts.compress ?? true;
    const bytes = compress ? deflateSync(raw) : raw;
    const filter = compress ? ' /Filter /FlateDecode' : '';
    return this.add(
      Buffer.concat([
        Buffer.from(`<< ${dict}${filter} /Length ${bytes.length} >>\nstream\n`, 'latin1'),
        bytes,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    );
  }

  build(rootId: number): Buffer {
    const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    const offsets: number[] = [];
    let pos = parts[0]!.length;
    this.objects.forEach((body, i) => {
      offsets.push(pos);
      const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
      parts.push(chunk);
      pos += chunk.length;
    });
    const xref = [
      'xref',
      `0 ${this.objects.length + 1}`,
      '0000000000 65535 f ',
      ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    ].join('\n');
    const trailer = `trailer\n<< /Size ${this.objects.length + 1} /Root ${rootId} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
    parts.push(Buffer.from(`${xref}\n${trailer}`, 'latin1'));
    return Buffer.concat(parts);
  }
}

export interface FontPage {
  /** Raw content stream operators. */
  content: string;
  /** When set, the page's /Contents is an array of these streams (in order) instead of the single `content`. */
  contents?: string[];
  /** The page's /Font resource dictionary entries, e.g. `/F1 4 0 R /F2 5 0 R`; omit to inherit from the page tree. */
  fonts?: string;
  /** A literal /Resources value instead of `<< /Font << fonts >> >>` (for indirect or cyclic resources). */
  resources?: string;
}

/**
 * Build a PDF: `setup` adds fonts and other objects to the graph and returns the pages; `inheritedFonts` (optional)
 * puts a /Resources << /Font << ... >> >> on the page-tree node for pages that declare none.
 */
export function buildFontPdf(setup: (g: PdfGraph) => FontPage[], opts: { inheritedFonts?: (g: PdfGraph) => string } = {}): Buffer {
  const g = new PdfGraph();
  const catalog = g.reserve();
  const pagesId = g.reserve();
  const pages = setup(g);
  const inherited = opts.inheritedFonts ? opts.inheritedFonts(g) : null;
  const kids = pages.map((p) => {
    const content = p.contents
      ? g.add(`[${p.contents.map((c) => `${g.stream('', c)} 0 R`).join(' ')}]`)
      : g.stream('', p.content);
    const resources = p.resources ?? (p.fonts !== undefined ? `<< /Font << ${p.fonts} >> >>` : null);
    return g.add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792]${resources ? ` /Resources ${resources}` : ''} /Contents ${content} 0 R >>`,
    );
  });
  g.set(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  g.set(
    pagesId,
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length}${
      inherited ? ` /Resources << /Font << ${inherited} >> >>` : ''
    } >>`,
  );
  return g.build(catalog);
}

/** UTF-16BE hex of a string (a ToUnicode destination). */
export const utf16Hex = (s: string) => Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase();

/** A ToUnicode CMap program with the given codespace and body (bfchar/bfrange blocks or anything else). */
export function toUnicodeCMap(body: string, codespace = '<0000> <FFFF>'): string {
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    `1 begincodespacerange\n${codespace}\nendcodespacerange`,
    body,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

/**
 * A synthetic 2-byte glyph-id assignment (like an embedded subset font): each distinct character of `alphabet` gets
 * the code 0x0021 + its index, so the legacy byte decoder shows printable but shifted, unreadable characters (as it did
 * for the real XR60CX manual).
 */
export function glyphIds(alphabet: string) {
  const chars = [...new Set([...alphabet])];
  const code = (ch: string) => {
    const i = chars.indexOf(ch);
    if (i < 0) throw new Error(`character ${ch} is not in the alphabet`);
    return (0x21 + i).toString(16).toUpperCase().padStart(4, '0');
  };
  return {
    hex: (text: string) => `<${[...text].map(code).join('')}>`,
    bfchar: () =>
      `${chars.length} beginbfchar\n${chars.map((ch) => `<${code(ch)}> <${utf16Hex(ch)}>`).join('\n')}\nendbfchar`,
  };
}

/** A Type0 / Identity-H font dictionary (with an optional ToUnicode reference) and its CIDFontType2 descendant. */
export function addType0Font(g: PdfGraph, opts: { toUnicode?: number | null; baseFont?: string; encoding?: string } = {}): number {
  const base = opts.baseFont ?? 'ABCDEE+ArialNarrow';
  const descendant = g.add(
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /CIDToGIDMap /Identity /DW 1000 >>`,
  );
  const tu = opts.toUnicode ? ` /ToUnicode ${opts.toUnicode} 0 R` : '';
  return g.add(
    `<< /Type /Font /Subtype /Type0 /BaseFont /${base} /Encoding /${opts.encoding ?? 'Identity-H'} /DescendantFonts [${descendant} 0 R]${tu} >>`,
  );
}

/** The fixtures' standard WinAnsi Helvetica font. */
export const addHelvetica = (g: PdfGraph) =>
  g.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
