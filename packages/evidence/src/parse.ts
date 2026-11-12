// Deterministic, bounded document parsing (FR-05, NFR-04, AI-SAFETY §5). The declared media type must match the
// bytes; text must be valid UTF-8 without control characters; every span carries a page, section or record locator
// and the SHA-256 of its exact text. The same bytes always produce the same spans, so a citation can be re-derived
// from the immutable object and verified.
import { createHash } from 'node:crypto';
import type { CitationLocator } from '@uptimebuyer/contracts';
import { rejected } from './errors.js';
import { DOCUMENT_LIMITS } from './limits.js';
import type { WithheldReason } from './cmap.js';
import { extractPdfText } from './pdf.js';

/**
 * v3 decodes PDF text through each font's ToUnicode CMap / encoding and withholds what it cannot decode (ADR 0002).
 * v1 and v2 differ only in fact extraction; both decoded PDF strings without fonts. Spans are re-derived with the
 * version recorded on their document, so a citation issued under an older version keeps verifying.
 */
export const PARSER_VERSION = 'uptimebuyer-parser.v3';
export const LEGACY_PARSER_VERSIONS = Object.freeze(['uptimebuyer-parser.v1', 'uptimebuyer-parser.v2'] as const);
export const SUPPORTED_PARSER_VERSIONS = Object.freeze([...LEGACY_PARSER_VERSIONS, PARSER_VERSION]);
export const SUPPORTED_MEDIA_TYPES = Object.freeze(['application/pdf', 'text/plain', 'text/markdown', 'text/csv'] as const);
export type SupportedMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number];
export type ParsedExtractionMethod = 'PDF_TEXT' | 'STRUCTURED_IMPORT' | 'MANUAL_ENTRY';

export interface ParsedSpan {
  ordinal: number;
  locator: CitationLocator;
  text: string;
  textDigest: `sha256:${string}`;
}

export interface ParsedDocument {
  mediaType: SupportedMediaType;
  extractionMethod: ParsedExtractionMethod;
  parserVersion: string;
  pageCount: number;
  spans: ParsedSpan[];
  activeContentRemoved: string[];
  /** Why some PDF text was withheld rather than shown (sorted reason codes); empty when nothing was withheld. */
  textWithheld: WithheldReason[];
}

export interface ParseOptions {
  /** Re-derive with a recorded parser version (default: the current one). */
  parserVersion?: string;
}

type Limits = typeof DOCUMENT_LIMITS;

export const textDigest = (text: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

function decodeText(buf: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw rejected('TEXT_NOT_UTF8', 'Text documents must be valid UTF-8.');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text))
    throw rejected('TEXT_NOT_UTF8', 'Text documents must not contain control characters.');
  return text.replace(/\r\n?/g, '\n');
}

/** Split `text` into chunks of at most `max` characters at line boundaries. */
function chunk(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur) out.push(cur);
    cur = '';
  };
  for (const line of text.split('\n')) {
    let rest = line;
    while (rest.length > max) {
      flush();
      out.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    if (cur && cur.length + rest.length + 1 > max) flush();
    cur = cur ? `${cur}\n${rest}` : rest;
  }
  flush();
  return out;
}

function cleanBlock(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

function finish(
  mediaType: SupportedMediaType,
  extractionMethod: ParsedExtractionMethod,
  pageCount: number,
  blocks: { locator: CitationLocator; text: string }[],
  activeContentRemoved: string[],
  limits: Limits,
  parserVersion: string,
  textWithheld: WithheldReason[] = [],
): ParsedDocument {
  const spans: ParsedSpan[] = [];
  let chars = 0;
  for (const b of blocks) {
    const text = cleanBlock(b.text);
    if (!text) continue;
    chars += text.length;
    if (chars > limits.maxChars) throw rejected('DOCUMENT_TOO_LONG', 'The document has too much text.');
    for (const part of chunk(text, limits.maxSpanChars)) {
      spans.push({ ordinal: spans.length + 1, locator: b.locator, text: part, textDigest: textDigest(part) });
      if (spans.length > limits.maxSpans) throw rejected('TOO_MANY_SPANS', 'The document has too many spans.');
    }
  }
  if (spans.length === 0)
    throw rejected(
      mediaType === 'application/pdf' ? 'PDF_TEXT_UNAVAILABLE' : 'DOCUMENT_EMPTY',
      'The document has no extractable text (OCR is not supported).',
    );
  return { mediaType, extractionMethod, parserVersion, pageCount, spans, activeContentRemoved, textWithheld };
}

const page = (n: number): CitationLocator => ({ kind: 'PAGE', page: n, pageEnd: null });

function parsePlain(text: string, limits: Limits) {
  const pages = text.split('\f');
  if (pages.length > limits.maxPages) throw rejected('TOO_MANY_PAGES', 'The document has too many pages.');
  return { pageCount: pages.length, blocks: pages.map((t, i) => ({ locator: page(i + 1), text: t })) };
}

function parseMarkdown(text: string) {
  const blocks: { locator: CitationLocator; text: string }[] = [];
  const stack: { level: number; title: string }[] = [];
  let current: { path: string; lines: string[] } = { path: 'Document', lines: [] };
  const flush = () => {
    if (current.lines.join('').trim())
      blocks.push({ locator: { kind: 'SECTION', sectionPath: current.path.slice(0, 256) }, text: current.lines.join('\n') });
  };
  for (const line of text.split('\n')) {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const level = h[1]!.length;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: h[2]!.slice(0, 80) });
      current = { path: stack.map((s) => s.title).join(' > '), lines: [line] };
    } else current.lines.push(line);
  }
  flush();
  return { pageCount: 0, blocks };
}

/** RFC 4180 CSV with a header row; the first column is the record key. */
export function parseCsv(text: string, limits: Limits = DOCUMENT_LIMITS): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = () => {
    if (field.length > limits.maxFieldChars) throw rejected('CSV_FIELD_TOO_LONG', 'A CSV field is too long.');
    row.push(field);
    field = '';
    if (row.length > limits.maxColumns) throw rejected('CSV_TOO_MANY_COLUMNS', 'A CSV record has too many columns.');
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    if (rows.length > limits.maxRecords + 1) throw rejected('TOO_MANY_RECORDS', 'The CSV has too many records.');
    row = [];
  };
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') quoted = false;
      else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') endField();
    else if (c === '\n') endRow();
    else field += c;
    i++;
  }
  if (quoted) throw rejected('CSV_MALFORMED', 'Unterminated quoted CSV field.');
  if (field !== '' || row.length) endRow();
  const [header, ...data] = rows;
  if (!header || header.some((h) => !h.trim())) throw rejected('CSV_MALFORMED', 'The CSV needs a header row.');
  for (const r of data) if (r.length !== header.length) throw rejected('CSV_MALFORMED', 'CSV record width mismatch.');
  return { header: header.map((h) => h.trim()), rows: data.map((r) => r.map((v) => v.trim())) };
}

function parseCsvDocument(text: string, limits: Limits) {
  const { header, rows } = parseCsv(text, limits);
  const keys = new Set<string>();
  const blocks = rows.map((r) => {
    const key = r[0]!;
    if (!key || key.length > 256) throw rejected('CSV_RECORD_KEY_MISSING', 'Every CSV record needs a key.');
    if (keys.has(key)) throw rejected('DUPLICATE_RECORD_KEY', 'CSV record keys must be unique.');
    keys.add(key);
    return {
      locator: { kind: 'RECORD', recordKey: key } as CitationLocator,
      text: header
        .map((h, i) => [h, r[i]!] as const)
        .filter(([, v]) => v !== '')
        .map(([h, v]) => `${h}: ${v}`)
        .join('\n'),
    };
  });
  return { pageCount: 0, blocks };
}

export function parseDocument(
  bytes: Uint8Array,
  mediaType: string,
  limits: Limits = DOCUMENT_LIMITS,
  opts: ParseOptions = {},
): ParsedDocument {
  const version = opts.parserVersion ?? PARSER_VERSION;
  if (!(SUPPORTED_PARSER_VERSIONS as readonly string[]).includes(version))
    throw rejected('PARSER_VERSION_UNSUPPORTED', 'The recorded parser version cannot be re-derived.');
  const legacy = version !== PARSER_VERSION;
  if (bytes.length > limits.maxBytes) throw rejected('DOCUMENT_TOO_LARGE', 'The document exceeds the size bound.');
  if (!(SUPPORTED_MEDIA_TYPES as readonly string[]).includes(mediaType))
    throw rejected('UNSUPPORTED_MEDIA_TYPE', 'The media type is not supported.');
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isPdf = buf.subarray(0, 1024).includes(PDF_MAGIC) && buf.subarray(0, 5).equals(PDF_MAGIC);
  const type = mediaType as SupportedMediaType;
  if (type === 'application/pdf') {
    if (!isPdf) throw rejected('MEDIA_TYPE_MISMATCH', 'The bytes are not a PDF.');
    const pdf = extractPdfText(buf, limits, { fonts: !legacy });
    return finish(
      type,
      'PDF_TEXT',
      pdf.pages.length,
      pdf.pages.map((t, i) => ({ locator: page(i + 1), text: t })),
      pdf.activeContentRemoved,
      limits,
      version,
      pdf.textWithheld,
    );
  }
  if (buf.subarray(0, 5).equals(PDF_MAGIC)) throw rejected('MEDIA_TYPE_MISMATCH', 'PDF bytes declared as text.');
  const text = decodeText(buf);
  if (type === 'text/csv') {
    const r = parseCsvDocument(text, limits);
    return finish(type, 'STRUCTURED_IMPORT', r.pageCount, r.blocks, [], limits, version);
  }
  const r = type === 'text/markdown' ? parseMarkdown(text) : parsePlain(text, limits);
  return finish(type, 'MANUAL_ENTRY', r.pageCount, r.blocks, [], limits, version);
}

// ---------------------------------------------------------------------------------------------------------------
// Exact fact extraction. Only two narrow textual forms and one structured form produce facts; prose never does.

export interface ExtractedFact {
  factKey: string;
  value: string;
  spanOrdinal: number;
}

const SPEC_KEYS: Readonly<Record<string, string>> = {
  refrigerant: 'refrigerant',
  'refrigerant charge': 'refrigerant-charge',
  voltage: 'rated-voltage',
  'rated voltage': 'rated-voltage',
  frequency: 'frequency',
  'rated current': 'rated-current',
  amperage: 'rated-current',
};
const DOT_LEADER = /^\s*([A-Za-z][A-Za-z0-9 ,/()'&+-]{1,80}?)\s*\.{3,}\s*([A-Za-z0-9][A-Za-z0-9./-]{2,40})\s*$/;
const SPEC_LINE = /^\s*([A-Za-z][A-Za-z ]{2,40}?)\s*:\s*(.{1,60}?)\s*$/;
const PART_VALUE = /^[A-Z0-9][A-Z0-9./-]{2,40}$/;
const CERT_CODE = /^[A-Za-z0-9](?:[A-Za-z0-9 ./-]{0,38}[A-Za-z0-9])?$/;

export const normalizeComponent = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
const normalizePart = (s: string) => s.trim().toUpperCase();
const normalizeSpec = (s: string) => s.trim().replace(/\s+/g, ' ');

/**
 * Exact facts of one span, as extracted by `parserVersion` (default: current). v1 had no certification facts (they
 * arrived with v2, M06 claim binding), so re-deriving a v1 document reproduces its recorded facts.
 */
export function extractFacts(
  text: string,
  method: ParsedExtractionMethod,
  spanOrdinal: number,
  parserVersion: string = PARSER_VERSION,
): ExtractedFact[] {
  const certificationFacts = parserVersion !== 'uptimebuyer-parser.v1';
  const facts: ExtractedFact[] = [];
  const add = (factKey: string, value: string) => {
    if (!/^(part|spec):[a-z0-9][a-z0-9-]{0,79}$/.test(factKey) || !value || value.length > 120) return;
    if (!facts.some((f) => f.factKey === factKey && f.value === value)) facts.push({ factKey, value, spanOrdinal });
  };
  if (method === 'STRUCTURED_IMPORT') {
    const fields = new Map<string, string>();
    for (const line of text.split('\n')) {
      const idx = line.indexOf(': ');
      if (idx > 0) fields.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 2).trim());
    }
    const component = fields.get('component');
    const partKey = [...fields.keys()].find((k) => /(^|_|\s)part(_|\s)?(number|no)(_|\s|$)/.test(k));
    const part = partKey ? normalizePart(fields.get(partKey)!) : null;
    if (component && part && PART_VALUE.test(part)) add(`part:${normalizeComponent(component)}`, part);
    return facts;
  }
  for (const line of text.split('\n')) {
    const d = DOT_LEADER.exec(line);
    if (d) {
      const part = normalizePart(d[2]!);
      if (PART_VALUE.test(part)) add(`part:${normalizeComponent(d[1]!)}`, part);
      continue;
    }
    const s = SPEC_LINE.exec(line);
    if (s) {
      const label = s[1]!.trim().toLowerCase();
      // v2: a certification line lists exact codes; each becomes its own fact (spec:certification-<code key>), so
      // a longer code, a negation or prose never equals a claimed code (M06 claim binding).
      if (certificationFacts && (label === 'certification' || label === 'certifications')) {
        for (const item of s[2]!.split(/[,;]/).map((x) => normalizeSpec(x))) {
          const key = normalizeComponent(item);
          if (CERT_CODE.test(item) && key) add(`spec:certification-${key}`, item);
        }
        continue;
      }
      const key = SPEC_KEYS[label];
      if (key) add(`spec:${key}`, normalizeSpec(s[2]!));
    }
  }
  return facts;
}
