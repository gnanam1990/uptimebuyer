// Deterministic PDF 1.7 writer for test fixtures: a catalog, a page tree, one standard Type1 font (Helvetica,
// WinAnsiEncoding), one FlateDecode content stream per page, an Info dictionary, a classic xref table and trailer.
// It writes real, well-formed PDF files (no copyrighted content); options add hostile constructs for security tests.
import { deflateSync } from 'node:zlib';

export interface PdfBuildOptions {
  title?: string;
  /** Adds a document-level /OpenAction JavaScript action (active content the parser must drop). */
  javascript?: boolean;
  /** Adds an /Encrypt dictionary reference in the trailer (unsupported, must be rejected). */
  encrypted?: boolean;
  /** Replaces page 1's content with a FlateDecode stream that inflates to this many bytes (decompression bomb). */
  bombInflatedBytes?: number;
  /** Apply `bombInflatedBytes` to every page instead of page 1 only. */
  bombEveryPage?: boolean;
  /** Do not compress content streams. */
  uncompressed?: boolean;
}

const escapePdfString = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function pageContent(lines: readonly string[]): string {
  const ops = ['BT', '/F1 10 Tf', '13 TL', '72 740 Td'];
  lines.forEach((line, i) => {
    if (i > 0) ops.push('T*');
    ops.push(`(${escapePdfString(line)}) Tj`);
  });
  ops.push('ET');
  return `${ops.join('\n')}\n`;
}

/** Build a PDF whose pages carry `pages[i]` as text lines. */
export function buildPdf(pages: readonly (readonly string[])[], opts: PdfBuildOptions = {}): Buffer {
  const objects: Buffer[] = [];
  const add = (body: Buffer | string) => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
    return objects.length;
  };
  const stream = (dict: string, data: Buffer) =>
    Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
      data,
      Buffer.from('\nendstream', 'latin1'),
    ]);

  // Reserve 1 (catalog), 2 (pages), 3 (font).
  add('');
  add('');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pageIds: number[] = [];
  pages.forEach((lines, i) => {
    let data: Buffer;
    let filter = '/Filter /FlateDecode';
    if ((i === 0 || opts.bombEveryPage) && opts.bombInflatedBytes !== undefined) {
      data = deflateSync(Buffer.alloc(opts.bombInflatedBytes, 0x20), { level: 9 });
    } else if (opts.uncompressed) {
      data = Buffer.from(pageContent(lines), 'latin1');
      filter = '';
    } else data = deflateSync(Buffer.from(pageContent(lines), 'latin1'));
    const contentId = add(stream(filter, data));
    const pageId = add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  });
  let jsId: number | null = null;
  if (opts.javascript) jsId = add('<< /Type /Action /S /JavaScript /JS (app.alert\\("pwned"\\);) >>');
  const infoId = add(
    `<< /Title (${escapePdfString(opts.title ?? 'Fixture')}) /Producer (UptimeBuyer fixture writer) /CreationDate (D:20250601000000Z) >>`,
  );
  let encryptId: number | null = null;
  if (opts.encrypted) encryptId = add('<< /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -4 >>');
  objects[0] = Buffer.from(
    `<< /Type /Catalog /Pages 2 0 R${jsId !== null ? ` /OpenAction ${jsId} 0 R` : ''} >>`,
    'latin1',
  );
  objects[1] = Buffer.from(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
    'latin1',
  );

  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let pos = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(pos);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(chunk);
    pos += chunk.length;
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
  ].join('\n');
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R${
    encryptId !== null ? ` /Encrypt ${encryptId} 0 R` : ''
  } >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(`${xref}\n${trailer}`, 'latin1'));
  return Buffer.concat(parts);
}
