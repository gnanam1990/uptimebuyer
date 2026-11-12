// Bounded PDF text extraction for the evidence parser. It reads only what text extraction needs (indirect objects,
// object streams, the page tree, fonts' encoding data and FlateDecode content streams) and never interprets actions,
// scripts, forms, embedded files or font programs: those are recorded as removed active content. Every decompression is
// capped individually and cumulatively, so a decompression bomb is rejected before it is materialised.
//
// Supported subset (documented in ADR 0002). uptimebuyer-parser.v3 decodes text shown with Tj/TJ/'/" through the
// current font (Tf, saved and restored by q/Q): a ToUnicode CMap (bfchar, bfrange in both forms, 1- and 2-byte codes),
// a simple font's WinAnsi/Standard/Symbol encoding with /Differences resolved through standard glyph names, and Type0
// Identity-H/V only with ToUnicode. Text it cannot decode (no ToUnicode and an unknown or symbolic encoding, a refused
// CMap, an unmapped glyph, an invalid code point, an unresolvable font) is withheld as U+FFFD and its reason recorded;
// it is never shown as guessed text. Form XObjects (Do), LZW/DCT/other filters on content streams and image-only
// (scanned) pages yield no text: OCR is UNSUPPORTED, and a document with no extractable text is rejected rather than
// stored as empty evidence. The legacy decoder (WinAnsi/PDFDocEncoding or UTF-16BE by BOM, fonts ignored) is kept
// verbatim so spans recorded by uptimebuyer-parser.v1/v2 can still be re-derived and verified.
import { inflateSync } from 'node:zlib';
import { DOCUMENT_LIMITS } from './limits.js';
import { rejected } from './errors.js';
import {
  STANDARD_V3,
  SYMBOL,
  WIN_ANSI_V3,
  WITHHELD,
  cleanDecoded,
  glyphNameToUnicode,
  parseToUnicode,
  type Mapped,
  type ToUnicodeMap,
  type WithheldReason,
} from './cmap.js';

type Limits = typeof DOCUMENT_LIMITS;

interface PdfObj {
  body: string;
  stream: Buffer | null;
}

const malformed = () => rejected('PDF_MALFORMED', 'The PDF structure could not be parsed.');
const bomb = () => rejected('DOCUMENT_BOMB', 'Decompressed content exceeds the document bound.');

const ACTIVE_CONTENT: readonly [RegExp, string][] = [
  [/\/(JavaScript|JS)\b/, 'JAVASCRIPT'],
  [/\/OpenAction\b/, 'OPEN_ACTION'],
  [/\/AA\b/, 'ADDITIONAL_ACTIONS'],
  [/\/Launch\b/, 'LAUNCH'],
  [/\/EmbeddedFiles?\b/, 'EMBEDDED_FILE'],
  [/\/RichMedia\b/, 'RICH_MEDIA'],
  [/\/XFA\b/, 'XFA'],
  [/\/SubmitForm\b/, 'SUBMIT_FORM'],
  [/\/ImportData\b/, 'IMPORT_DATA'],
  [/\/URI\b/, 'URI_ACTION'],
  [/\/GoToR\b/, 'REMOTE_GOTO'],
];

class Inflater {
  private used = 0;
  constructor(private readonly limits: Limits) {}
  /** Inflate within the stream and cumulative bounds; `max` (with `tooLarge`) tightens the bound for one stream. */
  inflate(data: Buffer, max = Infinity, tooLarge: () => Error = bomb): Buffer {
    const remaining = this.limits.maxInflatedBytes - this.used;
    if (remaining <= 0) throw bomb();
    const streamCap = Math.min(this.limits.maxStreamInflatedBytes, remaining);
    const cap = Math.min(streamCap, max);
    let out: Buffer;
    try {
      out = inflateSync(data, { maxOutputLength: cap, finishFlush: 2 /* Z_SYNC_FLUSH: tolerate truncated tails */ });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)
        throw cap < streamCap ? tooLarge() : bomb();
      throw malformed();
    }
    this.used += out.length;
    if (this.used > this.limits.maxInflatedBytes) throw bomb();
    return out;
  }
}

const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;

/** Index just past the dictionary that opens at `i` ('<<'), honouring nested dicts and strings. */
function skipDict(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '(') i = skipLiteral(s, i);
    else if (c === '<' && s[i + 1] === '<') {
      depth += 1;
      i += 2;
    } else if (c === '>' && s[i + 1] === '>') {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else if (c === '<') {
      const end = s.indexOf('>', i + 1);
      if (end < 0) throw malformed();
      i = end + 1;
    } else if (c === '%') {
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
    } else i += 1;
    if (depth > 64) throw malformed();
  }
  throw malformed();
}

function skipLiteral(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i += 1;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw malformed();
}

const OBJ = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;

/** Forward-only keyword search that never rescans: once a keyword is absent after a position, it stays absent. */
class Finder {
  private readonly last = new Map<string, number>();
  constructor(private readonly s: string) {}
  next(word: string, from: number): number {
    const cached = this.last.get(word);
    if (cached !== undefined && (cached === -1 || cached >= from)) return cached === -1 ? -1 : cached;
    const at = this.s.indexOf(word, from);
    this.last.set(word, at);
    return at;
  }
}

function scanObjects(buf: Buffer, s: string, limits: Limits, inflater: Inflater): Map<number, PdfObj> {
  const objects = new Map<number, PdfObj>();
  const streams: PdfObj[] = [];
  const find = new Finder(s);
  let count = 0;
  OBJ.lastIndex = 0;
  for (let m = OBJ.exec(s); m !== null; m = OBJ.exec(s)) {
    if (++count > limits.maxPdfObjects) throw rejected('TOO_MANY_OBJECTS', 'The PDF has too many objects.');
    const num = Number(m[1]);
    let i = m.index + m[0].length;
    while (i < s.length && isWs(s.charCodeAt(i))) i++;
    let body: string;
    let stream: Buffer | null = null;
    if (s.startsWith('<<', i)) {
      const end = skipDict(s, i);
      body = s.slice(i, end);
      let j = end;
      while (j < s.length && isWs(s.charCodeAt(j))) j++;
      const after = s.slice(j, j + 7);
      if (after.startsWith('stream')) {
        let start = j + 6;
        if (s[start] === '\r') start++;
        if (s[start] === '\n') start++;
        const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(body);
        let dataEnd = -1;
        if (len) {
          const candidate = start + Number(len[1]);
          const tail = s.slice(candidate, candidate + 16);
          if (candidate <= s.length && /^\s*endstream/.test(tail)) dataEnd = candidate;
        }
        if (dataEnd < 0) {
          const es = find.next('endstream', start);
          if (es < 0) throw malformed();
          dataEnd = es;
          if (s[dataEnd - 1] === '\n') dataEnd--;
          if (s[dataEnd - 1] === '\r') dataEnd--;
        }
        stream = buf.subarray(start, dataEnd);
        const es = find.next('endstream', dataEnd);
        OBJ.lastIndex = es < 0 ? dataEnd : es + 9;
      } else OBJ.lastIndex = end;
    } else {
      const end = find.next('endobj', i);
      body = s.slice(i, end < 0 ? Math.min(s.length, i + 4096) : end);
      OBJ.lastIndex = end < 0 ? i : end + 6;
    }
    const obj = { body, stream };
    objects.set(num, obj);
    if (stream && /\/Type\s*\/ObjStm\b/.test(body)) streams.push(obj);
  }
  // Compressed objects inside object streams fill numbers not defined as top-level objects.
  for (const os of streams) {
    const data = decodeStream(os, inflater);
    if (data === null) continue;
    const n = Number(/\/N\s+(\d+)/.exec(os.body)?.[1] ?? NaN);
    const first = Number(/\/First\s+(\d+)/.exec(os.body)?.[1] ?? NaN);
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(first) || n < 0 || first > data.length) throw malformed();
    count += n;
    if (count > limits.maxPdfObjects) throw rejected('TOO_MANY_OBJECTS', 'The PDF has too many objects.');
    const text = data.toString('latin1');
    const header = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let k = 0; k + 1 < header.length && k / 2 < n; k += 2) {
      const num = header[k]!;
      const off = first + header[k + 1]!;
      const nextOff = k + 3 < header.length ? first + header[k + 3]! : text.length;
      if (!objects.has(num) && off <= text.length) objects.set(num, { body: text.slice(off, nextOff).trim(), stream: null });
    }
  }
  return objects;
}

function decodeStream(obj: PdfObj, inflater: Inflater, max = Infinity, tooLarge?: () => Error): Buffer | null {
  if (!obj.stream) return null;
  const filters = [...(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(obj.body)?.[1] ?? '').matchAll(/\/([A-Za-z0-9]+)/g)].map(
    (m) => m[1],
  );
  if (/\/Predictor\s+(\d+)/.exec(obj.body) && Number(/\/Predictor\s+(\d+)/.exec(obj.body)![1]) > 1) return null;
  let data: Buffer = obj.stream;
  for (const f of filters) {
    if (f === 'FlateDecode' || f === 'Fl') data = inflater.inflate(data, max, tooLarge);
    else return null; // unsupported filter: no text from this stream
  }
  return data;
}

const ref = (body: string, key: string): number | null => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(body);
  return m ? Number(m[1]) : null;
};

function pageObjects(objects: Map<number, PdfObj>, s: string, limits: Limits): PdfObj[] {
  const roots = [...s.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
  let catalog: PdfObj | undefined = roots.length ? objects.get(roots[roots.length - 1]!) : undefined;
  if (!catalog) catalog = [...objects.values()].find((o) => /\/Type\s*\/Catalog\b/.test(o.body));
  if (!catalog) return [];
  const rootPages = ref(catalog.body, 'Pages');
  if (rootPages === null) return [];
  const pages: PdfObj[] = [];
  const seen = new Set<number>();
  const walk = (num: number, depth: number) => {
    if (depth > limits.maxTreeDepth || seen.has(num)) throw malformed();
    seen.add(num);
    const node = objects.get(num);
    if (!node) return;
    if (/\/Type\s*\/Pages\b/.test(node.body)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(node.body)?.[1] ?? '';
      for (const k of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]), depth + 1);
    } else if (/\/Type\s*\/Page\b/.test(node.body)) {
      pages.push(node);
      if (pages.length > limits.maxPages) throw rejected('TOO_MANY_PAGES', 'The document has too many pages.');
    }
  };
  walk(rootPages, 0);
  return pages;
}

// WinAnsi code points 0x80..0x9F that differ from Latin-1 (the legacy v1/v2 table, kept verbatim).
const WIN_ANSI: Record<number, string> = {
  0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•',
  0x96: '–', 0x97: '—', 0x99: '™',
};

/** The legacy (v1/v2) string decoder: fonts ignored. Kept verbatim so recorded spans re-derive byte-for-byte. */
function decodePdfBytes(bytes: number[]): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    return out;
  }
  let out = '';
  for (const b of bytes) out += WIN_ANSI[b] ?? (b < 0x20 && b !== 0x09 ? ' ' : String.fromCharCode(b));
  return out;
}

// --------------------------------------------------------------------------------------- fonts (parser v3)

/** Decodes the bytes of one shown string; adds the reason for every withheld glyph to `reasons`. */
interface FontDecoder {
  decode(bytes: number[], reasons: Set<WithheldReason>): string;
}

const append = (out: string, m: Mapped, reasons: Set<WithheldReason>): string => {
  if (typeof m === 'string') return out + m;
  reasons.add(m.withheld);
  return out.endsWith(WITHHELD) ? out : out + WITHHELD;
};

/** A font whose text cannot be decoded at all: every shown string is one withheld marker. */
const withheldFont = (reason: WithheldReason): FontDecoder => ({
  decode: (bytes, reasons) => (bytes.length ? append('', { withheld: reason }, reasons) : ''),
});

type CodeTable = (code: number) => Mapped;
const unmapped: Mapped = { withheld: 'GLYPH_UNMAPPED' };
const unknownEncoding: CodeTable = () => ({ withheld: 'FONT_ENCODING_UNKNOWN' });
const fromArray =
  (t: readonly (string | null)[]): CodeTable =>
  (c) =>
    t[c] ?? unmapped;
const WIN_ANSI_TABLE = fromArray(WIN_ANSI_V3);
const STANDARD_TABLE = fromArray(STANDARD_V3);
const MAC_ROMAN_TABLE = fromArray(STANDARD_V3.map((v, c) => (c === 0x27 ? "'" : c === 0x60 ? '`' : v)));
const SYMBOL_TABLE: CodeTable = (c) => SYMBOL.get(c) ?? unmapped;
// A Map, not an object literal: a PDF name such as /constructor or /toString must never resolve to a prototype member.
const NAMED_ENCODINGS: ReadonlyMap<string, CodeTable> = new Map([
  ['WinAnsiEncoding', WIN_ANSI_TABLE],
  ['StandardEncoding', STANDARD_TABLE],
  ['MacRomanEncoding', MAC_ROMAN_TABLE],
]);

/** Simple (single-byte) font: ToUnicode first, then its encoding table. */
const simpleFont = (table: CodeTable, tu: ToUnicodeMap | null): FontDecoder => ({
  decode(bytes, reasons) {
    let out = '';
    for (const b of bytes) out = append(out, tu?.map.get(0x10000 + b) ?? tu?.map.get(0x20000 + b) ?? table(b), reasons);
    return out;
  },
});

/** Composite (Type0) font with a ToUnicode CMap: codes are split by Identity (2 bytes) or by the CMap's codespace. */
const compositeFont = (tu: ToUnicodeMap, identity: boolean): FontDecoder => {
  const lengths = identity || tu.ranges.length === 0 ? [2] : tu.codeLengths;
  const lenAt = (bytes: number[], i: number): number => {
    if (lengths.length === 1) return lengths[0]!;
    for (const len of lengths) {
      if (i + len > bytes.length) continue;
      const code = len === 1 ? bytes[i]! : (bytes[i]! << 8) | bytes[i + 1]!;
      if (tu.ranges.some((r) => r.len === len && code >= r.lo && code <= r.hi)) return len;
    }
    return lengths[0]!;
  };
  return {
    decode(bytes, reasons) {
      let out = '';
      for (let i = 0; i < bytes.length; ) {
        const len = lenAt(bytes, i);
        if (i + len > bytes.length) {
          out = append(out, unmapped, reasons);
          break;
        }
        const code = len === 1 ? bytes[i]! : (bytes[i]! << 8) | bytes[i + 1]!;
        out = append(out, tu.map.get(len * 0x10000 + code) ?? unmapped, reasons);
        i += len;
      }
      return out;
    },
  };
};

/** The v3 decoder for strings shown without a resolvable font is fail-closed: nothing is guessed. */
const UNRESOLVED_FONT = withheldFont('FONT_ENCODING_UNKNOWN');

const REF = /^(\d{1,10})\s+(\d{1,5})\s+R$/;

/** Index just past the array that opens at `i` ('['), honouring nested arrays, dicts and strings. */
function skipArray(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '(') i = skipLiteral(s, i);
    else if (c === '<' && s[i + 1] === '<') i = skipDict(s, i);
    else if (c === '<') {
      const end = s.indexOf('>', i + 1);
      if (end < 0) throw malformed();
      i = end + 1;
    } else if (c === '[') {
      depth++;
      i++;
      if (depth > 64) throw malformed();
    } else if (c === ']') {
      depth--;
      i++;
      if (depth === 0) return i;
    } else i++;
  }
  throw malformed();
}

const isDelim = (c: string) => '/[]()<>{}%'.includes(c);

/** Top-level entries of the dictionary that opens at the first '<<' of `s`: key (unescaped name) -> raw value text. */
function dictEntries(s: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = s.indexOf('<<');
  if (i < 0) return out;
  i += 2;
  while (i < s.length && out.size < 4096) {
    while (i < s.length && isWs(s.charCodeAt(i))) i++;
    if (s[i] === '%') {
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
      continue;
    }
    if (s[i] !== '/') break; // '>>' or malformed: stop
    let j = i + 1;
    while (j < s.length && !isWs(s.charCodeAt(j)) && !isDelim(s[j]!)) j++;
    const key = unescapeName(s.slice(i + 1, j));
    i = j;
    while (i < s.length && isWs(s.charCodeAt(i))) i++;
    const start = i;
    const c = s[i] ?? '';
    if (c === '<' && s[i + 1] === '<') i = skipDict(s, i);
    else if (c === '<') {
      const end = s.indexOf('>', i + 1);
      if (end < 0) throw malformed();
      i = end + 1;
    } else if (c === '(') i = skipLiteral(s, i);
    else if (c === '[') i = skipArray(s, i);
    else if (c === '/') {
      i++;
      while (i < s.length && !isWs(s.charCodeAt(i)) && !isDelim(s[i]!)) i++;
    } else {
      const r = /^\d{1,10}\s+\d{1,5}\s+R(?![A-Za-z0-9])/.exec(s.slice(i, i + 24));
      if (r) i += r[0].length;
      else while (i < s.length && !isWs(s.charCodeAt(i)) && !isDelim(s[i]!)) i++;
    }
    if (i === start) break;
    out.set(key, s.slice(start, i).trim());
  }
  return out;
}

/** PDF name text with #xx escapes decoded. */
function unescapeName(raw: string): string {
  return raw.includes('#') ? raw.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : raw;
}
const nameOf = (raw: string | undefined): string | null =>
  raw !== undefined && raw.startsWith('/') ? unescapeName(raw.slice(1)) : null;

interface FontContext {
  objects: Map<number, PdfObj>;
  limits: Limits;
  inflater: Inflater;
  decoders: Map<string, FontDecoder>;
  cmaps: Map<string, ToUnicodeMap | 'REFUSED'>;
  budget: { mappings: number };
}

/**
 * Follow indirect references (bounded hops, cycles refused). Returns the final object and its body, or null. An object
 * whose body exceeds maxFontObjectBytes is unresolvable (checked before it is scanned, so many references to one
 * oversized object cost nothing per reference).
 */
function deref(fc: FontContext, raw: string | undefined): { body: string; obj: PdfObj | null } | null {
  if (raw === undefined || raw.length > fc.limits.maxFontObjectBytes) return null;
  let body = raw.trim();
  let obj: PdfObj | null = null;
  const seen = new Set<number>();
  for (let hops = 0; ; hops++) {
    const m = REF.exec(body);
    if (!m) return body === 'null' ? null : { body, obj };
    const num = Number(m[1]);
    if (hops >= fc.limits.maxRefHops || seen.has(num)) return null;
    seen.add(num);
    const next = fc.objects.get(num);
    if (!next || next.body.length > fc.limits.maxFontObjectBytes) return null;
    obj = next;
    body = next.body.trim();
  }
}

const tooLargeCMap = () => rejected('CMAP_TOO_LARGE', 'A font CMap exceeds the document bound.');

/** Parse (once per object) a font's ToUnicode CMap; 'REFUSED' when it is missing, not a stream or malformed. */
function loadToUnicode(fc: FontContext, raw: string, symbolFont: boolean): ToUnicodeMap | 'REFUSED' {
  const m = REF.exec(raw.trim());
  const key = `${m ? m[1] : raw}:${symbolFont ? 'S' : ''}`;
  const cached = fc.cmaps.get(key);
  if (cached) return cached;
  let result: ToUnicodeMap | 'REFUSED' = 'REFUSED';
  const target = m ? deref(fc, raw) : null;
  if (target?.obj?.stream) {
    const data = decodeStream(target.obj, fc.inflater, fc.limits.maxCMapBytes, tooLargeCMap);
    if (data) result = parseToUnicode(data.toString('latin1'), fc.limits, fc.budget, symbolFont) ?? 'REFUSED';
  }
  fc.cmaps.set(key, result);
  return result;
}

/** Parse a /Differences array into code -> glyph mapping; null when malformed. */
function differences(raw: string): Map<number, Mapped> | null {
  const body = raw.trim();
  if (!body.startsWith('[') || !body.endsWith(']')) return null;
  const out = new Map<number, Mapped>();
  let code = -1;
  const toks = body.slice(1, -1).match(/\/[^\s/[\]()<>{}%]*|[^\s/[\]()<>{}%]+/g) ?? [];
  if (toks.length > 2_048) return null;
  for (const t of toks) {
    if (t.startsWith('/')) {
      if (code < 0 || code > 255) return null;
      const g = glyphNameToUnicode(unescapeName(t.slice(1)));
      out.set(code, g === null ? unmapped : cleanDecoded(g));
      code++;
    } else if (/^\d{1,3}$/.test(t)) code = Number(t);
    else return null;
  }
  return out;
}

const stripSubset = (name: string | null) => (name ?? '').replace(/^[A-Z]{6}\+/, '');

/** The single-byte code table of a simple font from /Encoding, /BaseFont and the symbolic flag. */
function simpleTable(fc: FontContext, e: Map<string, string>, baseFont: string): CodeTable {
  const fd = deref(fc, e.get('FontDescriptor'));
  const flags = Number(fd ? (dictEntries(fd.body).get('Flags') ?? '0') : '0');
  const symbolic = Number.isFinite(flags) && (flags & 4) !== 0 && (flags & 32) === 0;
  const isSymbol = baseFont.startsWith('Symbol');
  const builtIn: CodeTable = isSymbol ? SYMBOL_TABLE : symbolic || baseFont.startsWith('ZapfDingbats') ? unknownEncoding : STANDARD_TABLE;
  const enc = deref(fc, e.get('Encoding'));
  // No /Encoding: the font's built-in encoding (Symbol for Symbol, unknown for other symbolic fonts, StandardEncoding
  // for nonsymbolic fonts). WinAnsi is used only when the font names it.
  if (!e.has('Encoding')) return builtIn;
  if (!enc) return unknownEncoding;
  const named = nameOf(enc.body);
  if (named !== null) return NAMED_ENCODINGS.get(named) ?? unknownEncoding;
  if (!enc.body.startsWith('<<')) return unknownEncoding;
  const d = dictEntries(enc.body);
  const baseName = nameOf(d.get('BaseEncoding'));
  const base = baseName !== null ? (NAMED_ENCODINGS.get(baseName) ?? unknownEncoding) : builtIn;
  const diffRaw = d.has('Differences') ? deref(fc, d.get('Differences')) : null;
  if (d.has('Differences') && !diffRaw) return unknownEncoding;
  const diffs = diffRaw ? differences(diffRaw.body) : new Map<number, Mapped>();
  if (!diffs) return unknownEncoding;
  return (c) => diffs.get(c) ?? base(c);
}

function buildDecoder(fc: FontContext, fontBody: string): FontDecoder {
  const e = dictEntries(fontBody);
  const subtype = nameOf(e.get('Subtype'));
  const baseFont = stripSubset(nameOf(e.get('BaseFont')));
  const symbolFont = baseFont.startsWith('Symbol');
  const tuRaw = e.get('ToUnicode');
  const tu = tuRaw === undefined ? null : loadToUnicode(fc, tuRaw, symbolFont);
  if (tu === 'REFUSED') return withheldFont('CMAP_REFUSED');
  if (subtype === 'Type0') {
    if (!tu) return withheldFont('FONT_ENCODING_UNKNOWN');
    const enc = nameOf(e.get('Encoding'));
    return compositeFont(tu, enc === 'Identity-H' || enc === 'Identity-V');
  }
  return simpleFont(simpleTable(fc, e, baseFont), tu);
}

/** Resolve (and cache) the decoder for a font resource value: an indirect reference or an inline dictionary. */
function fontDecoder(fc: FontContext, raw: string): FontDecoder {
  const m = REF.exec(raw.trim());
  const key = m ? `o${m[1]}` : `i${raw}`;
  const cached = fc.decoders.get(key);
  if (cached) return cached;
  if (fc.decoders.size >= fc.limits.maxFonts) throw rejected('TOO_MANY_FONTS', 'The PDF uses too many fonts.');
  let decoder: FontDecoder = UNRESOLVED_FONT;
  try {
    const font = deref(fc, raw);
    if (font && font.body.startsWith('<<')) decoder = buildDecoder(fc, font.body);
  } catch (err) {
    // A structurally broken font dictionary withholds that font's text; every other rejection propagates.
    if ((err as { details?: { reasonCode?: string } }).details?.reasonCode !== 'PDF_MALFORMED') throw err;
  }
  fc.decoders.set(key, decoder);
  return decoder;
}

/** The page's /Font resources (inherited through /Parent when the page has no /Resources). */
function pageFontResources(fc: FontContext, page: PdfObj): Map<string, string> {
  let node: string | undefined = page.body;
  const seen = new Set<number>();
  for (let depth = 0; node !== undefined && depth <= fc.limits.maxTreeDepth; depth++) {
    const e = dictEntries(node);
    if (e.has('Resources')) {
      const res = deref(fc, e.get('Resources'));
      const font = res && res.body.startsWith('<<') ? deref(fc, dictEntries(res.body).get('Font')) : null;
      return font && font.body.startsWith('<<') ? dictEntries(font.body) : new Map();
    }
    const parent = REF.exec(e.get('Parent') ?? '');
    if (!parent || seen.has(Number(parent[1]))) break;
    seen.add(Number(parent[1]));
    node = fc.objects.get(Number(parent[1]))?.body;
  }
  return new Map();
}

const EI = /\sEI(\s|$)/g;

interface TextMode {
  /** Font name -> decoder for parser v3; null selects the legacy (v1/v2) decoder. */
  font: ((name: string) => FontDecoder) | null;
  reasons: Set<WithheldReason>;
}

/** Extract text from one decoded content stream. */
function contentText(src: string, budget: { chars: number }, mode: TextMode): string {
  const out: string[] = [];
  let line = '';
  const newline = () => {
    out.push(line);
    line = '';
  };
  const emit = (t: string) => {
    if (t.startsWith(WITHHELD) && line.endsWith(WITHHELD)) t = t.slice(WITHHELD.length);
    line += t;
    budget.chars -= t.length;
    if (budget.chars < 0) throw rejected('DOCUMENT_TOO_LONG', 'The document has too much text.');
  };
  type Operand =
    | { kind: 'str'; v: number[] }
    | { kind: 'num'; v: number }
    | { kind: 'name'; v: string }
    | { kind: 'arr'; v: Operand[] }
    | { kind: 'other' };
  let stack: Operand[] = [];
  const arrays: Operand[][] = [];
  const push = (o: Operand) => (arrays.length ? arrays[arrays.length - 1]!.push(o) : stack.push(o));
  let font: FontDecoder | null = null;
  const saved: (FontDecoder | null)[] = [];
  let unsaved = 0;
  const show = (o: Operand | undefined): string => {
    if (o?.kind !== 'str') return '';
    if (!mode.font) return decodePdfBytes(o.v);
    return (font ?? UNRESOLVED_FONT).decode(o.v, mode.reasons);
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const code = src.charCodeAt(i);
    if (isWs(code)) {
      i++;
    } else if (c === '%') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
    } else if (c === '(') {
      const bytes: number[] = [];
      let depth = 1;
      i++;
      while (i < src.length && depth > 0) {
        const ch = src[i]!;
        if (ch === '\\') {
          const n = src[i + 1] ?? '';
          const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
          if (n in esc) {
            bytes.push(esc[n]!);
            i += 2;
          } else if (/[0-7]/.test(n)) {
            const oct = /^[0-7]{1,3}/.exec(src.slice(i + 1, i + 4))![0];
            bytes.push(parseInt(oct, 8) & 0xff);
            i += 1 + oct.length;
          } else if (n === '\r' || n === '\n') {
            i += 2;
            if (n === '\r' && src[i] === '\n') i++;
          } else {
            i += 1;
          }
        } else {
          if (ch === '(') depth++;
          if (ch === ')') depth--;
          if (depth > 0) bytes.push(src.charCodeAt(i) & 0xff);
          i++;
        }
      }
      push({ kind: 'str', v: bytes });
    } else if (c === '<' && src[i + 1] === '<') {
      i = skipDict(src, i);
      push({ kind: 'other' });
    } else if (c === '<') {
      const end = src.indexOf('>', i);
      if (end < 0) break;
      const hex = src.slice(i + 1, end).replace(/[^0-9A-Fa-f]/g, '');
      const bytes: number[] = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      push({ kind: 'str', v: bytes });
      i = end + 1;
    } else if (c === '[') {
      arrays.push([]);
      i++;
    } else if (c === ']') {
      const arr = arrays.pop() ?? [];
      push({ kind: 'arr', v: arr });
      i++;
    } else if (c === '/') {
      const start = ++i;
      while (i < src.length && !isWs(src.charCodeAt(i)) && !'/[]()<>{}%'.includes(src[i]!)) i++;
      push({ kind: 'name', v: unescapeName(src.slice(start, i)) });
    } else if (/[0-9+\-.]/.test(c)) {
      const m = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(src.slice(i, i + 32));
      if (!m) {
        i++;
        continue;
      }
      push({ kind: 'num', v: Number(m[0]) });
      i += m[0].length;
    } else {
      const m = /^[A-Za-z'"*]+/.exec(src.slice(i, i + 16));
      const op = m ? m[0] : c;
      i += op.length;
      switch (op) {
        case 'BT':
          if (line.trim()) newline();
          break;
        case 'Tf': {
          const name = stack[stack.length - 2];
          if (mode.font) font = name?.kind === 'name' ? mode.font(name.v) : UNRESOLVED_FONT;
          break;
        }
        case 'q':
          if (saved.length < 64) saved.push(font);
          else unsaved++;
          break;
        case 'Q':
          if (unsaved > 0) unsaved--;
          else if (saved.length) font = saved.pop()!;
          break;
        case 'Tj':
          emit(show(stack[stack.length - 1]));
          break;
        case "'":
          newline();
          emit(show(stack[stack.length - 1]));
          break;
        case '"':
          newline();
          emit(show(stack[stack.length - 1]));
          break;
        case 'TJ': {
          const arr = stack[stack.length - 1];
          if (arr?.kind === 'arr')
            for (const it of arr.v) {
              if (it.kind === 'str') emit(show(it));
              else if (it.kind === 'num' && it.v < -250 && !line.endsWith(' ')) emit(' ');
            }
          break;
        }
        case 'T*':
          newline();
          break;
        case 'Td':
        case 'TD': {
          const ty = stack[stack.length - 1];
          if (ty?.kind === 'num' && ty.v !== 0) newline();
          else if (line && !line.endsWith(' ')) emit(' ');
          break;
        }
        case 'Tm':
          if (line.trim()) newline();
          break;
        case 'ET':
          break;
        case 'ID': {
          // Inline image data: skip binary until EI.
          EI.lastIndex = i;
          const ei = EI.exec(src);
          i = ei ? ei.index + 3 : src.length;
          break;
        }
        default:
          break;
      }
      stack = [];
    }
  }
  if (line) out.push(line);
  return out.map((l) => l.replace(/[ \t]+$/g, '')).join('\n');
}

export interface PdfTextResult {
  pages: string[];
  activeContentRemoved: string[];
  /** Why text was withheld (sorted, unique); empty when every shown glyph decoded. Always empty in legacy mode. */
  textWithheld: WithheldReason[];
}

export interface PdfTextOptions {
  /** false selects the legacy (uptimebuyer-parser.v1/v2) decoder that ignores fonts. */
  fonts?: boolean;
}

export function extractPdfText(buf: Buffer, limits: Limits = DOCUMENT_LIMITS, opts: PdfTextOptions = {}): PdfTextResult {
  const useFonts = opts.fonts ?? true;
  const s = buf.toString('latin1');
  if (/\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(s)) throw rejected('PDF_ENCRYPTED', 'Encrypted PDFs are not supported.');
  const inflater = new Inflater(limits);
  const objects = scanObjects(buf, s, limits, inflater);
  const removed = new Set<string>();
  for (const o of objects.values()) for (const [re, code] of ACTIVE_CONTENT) if (re.test(o.body)) removed.add(code);
  const pages = pageObjects(objects, s, limits);
  const budget = { chars: limits.maxChars };
  const reasons = new Set<WithheldReason>();
  const fc: FontContext = {
    objects,
    limits,
    inflater,
    decoders: new Map(),
    cmaps: new Map(),
    budget: { mappings: limits.maxCMapMappingsTotal },
  };
  const texts = pages.map((page) => {
    const contents: number[] = [];
    const direct = ref(page.body, 'Contents');
    if (direct !== null) {
      const target = objects.get(direct);
      if (target && !target.stream && target.body.trim().startsWith('['))
        for (const m of target.body.matchAll(/(\d+)\s+\d+\s+R/g)) contents.push(Number(m[1]));
      else contents.push(direct);
    } else {
      const arr = /\/Contents\s*\[([^\]]*)\]/.exec(page.body)?.[1] ?? '';
      for (const m of arr.matchAll(/(\d+)\s+\d+\s+R/g)) contents.push(Number(m[1]));
    }
    let mode: TextMode = { font: null, reasons };
    if (useFonts) {
      const resources = pageFontResources(fc, page);
      const byName = new Map<string, FontDecoder>();
      mode = {
        reasons,
        font: (name) => {
          let d = byName.get(name);
          if (!d) {
            const raw = resources.get(name);
            d = raw === undefined ? UNRESOLVED_FONT : fontDecoder(fc, raw);
            byName.set(name, d);
          }
          return d;
        },
      };
    }
    const parts: string[] = [];
    const streams: string[] = [];
    for (const num of contents.slice(0, 64)) {
      const obj = objects.get(num);
      if (!obj) continue;
      const data = decodeStream(obj, inflater);
      if (!data) continue;
      // Legacy (v1/v2) interpreted each stream on its own; kept verbatim for re-derivation.
      if (useFonts) streams.push(data.toString('latin1'));
      else parts.push(contentText(data.toString('latin1'), budget, mode));
    }
    // v3: a /Contents array is one content stream split at token boundaries (PDF 32000 7.8.2), so the font, the q/Q
    // stack and the operand state carry across its parts: interpret their concatenation once.
    if (useFonts && streams.length) parts.push(contentText(streams.join('\n'), budget, mode));
    const text = parts
      .join('\n')
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    // v3: a page whose only "text" is withheld markers has no extractable text.
    return useFonts && text.replaceAll(WITHHELD, '').trim() === '' ? '' : text;
  });
  return {
    pages: texts,
    activeContentRemoved: [...removed].sort(),
    textWithheld: useFonts ? [...reasons].sort() : [],
  };
}
