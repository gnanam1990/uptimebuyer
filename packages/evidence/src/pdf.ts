// Bounded PDF text extraction for the evidence parser. It reads only what text extraction needs (indirect objects,
// object streams, the page tree and FlateDecode content streams) and never interprets actions, scripts, forms,
// embedded files or fonts programs: those are recorded as removed active content. Every decompression is capped
// individually and cumulatively, so a decompression bomb is rejected before it is materialised.
//
// Supported subset (documented in ADR 0002): text shown with Tj/TJ/'/" in literal or hex strings decoded as
// WinAnsi/PDFDocEncoding or UTF-16BE (BOM). Fonts with custom ToUnicode CMaps or Identity-H glyph ids, LZW/DCT/other
// filters on content streams, and image-only (scanned) pages yield no text: OCR is UNSUPPORTED, and a document with
// no extractable text is rejected rather than stored as empty evidence.
import { inflateSync } from 'node:zlib';
import { DOCUMENT_LIMITS } from './limits.js';
import { rejected } from './errors.js';

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
  inflate(data: Buffer): Buffer {
    const remaining = this.limits.maxInflatedBytes - this.used;
    if (remaining <= 0) throw bomb();
    const cap = Math.min(this.limits.maxStreamInflatedBytes, remaining);
    let out: Buffer;
    try {
      out = inflateSync(data, { maxOutputLength: cap, finishFlush: 2 /* Z_SYNC_FLUSH: tolerate truncated tails */ });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw bomb();
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
      const nl = s.slice(i).search(/[\r\n]/);
      i = nl < 0 ? s.length : i + nl;
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

function scanObjects(buf: Buffer, s: string, limits: Limits, inflater: Inflater): Map<number, PdfObj> {
  const objects = new Map<number, PdfObj>();
  const streams: PdfObj[] = [];
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
          const es = s.indexOf('endstream', start);
          if (es < 0) throw malformed();
          dataEnd = es;
          if (s[dataEnd - 1] === '\n') dataEnd--;
          if (s[dataEnd - 1] === '\r') dataEnd--;
        }
        stream = buf.subarray(start, dataEnd);
        const es = s.indexOf('endstream', dataEnd);
        OBJ.lastIndex = es < 0 ? dataEnd : es + 9;
      } else OBJ.lastIndex = end;
    } else {
      const end = s.indexOf('endobj', i);
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

function decodeStream(obj: PdfObj, inflater: Inflater): Buffer | null {
  if (!obj.stream) return null;
  const filters = [...(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(obj.body)?.[1] ?? '').matchAll(/\/([A-Za-z0-9]+)/g)].map(
    (m) => m[1],
  );
  if (/\/Predictor\s+(\d+)/.exec(obj.body) && Number(/\/Predictor\s+(\d+)/.exec(obj.body)![1]) > 1) return null;
  let data: Buffer = obj.stream;
  for (const f of filters) {
    if (f === 'FlateDecode' || f === 'Fl') data = inflater.inflate(data);
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

// WinAnsi code points 0x80..0x9F that differ from Latin-1.
const WIN_ANSI: Record<number, string> = {
  0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•',
  0x96: '–', 0x97: '—', 0x99: '™',
};

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

/** Extract text from one decoded content stream. */
function contentText(src: string, budget: { chars: number }): string {
  const out: string[] = [];
  let line = '';
  const newline = () => {
    out.push(line);
    line = '';
  };
  const emit = (t: string) => {
    line += t;
    budget.chars -= t.length;
    if (budget.chars < 0) throw rejected('DOCUMENT_TOO_LONG', 'The document has too much text.');
  };
  type Operand = { kind: 'str'; v: string } | { kind: 'num'; v: number } | { kind: 'arr'; v: Operand[] } | { kind: 'other' };
  let stack: Operand[] = [];
  const arrays: Operand[][] = [];
  const push = (o: Operand) => (arrays.length ? arrays[arrays.length - 1]!.push(o) : stack.push(o));
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
      push({ kind: 'str', v: decodePdfBytes(bytes) });
    } else if (c === '<' && src[i + 1] === '<') {
      i = skipDict(src, i);
      push({ kind: 'other' });
    } else if (c === '<') {
      const end = src.indexOf('>', i);
      if (end < 0) break;
      const hex = src.slice(i + 1, end).replace(/[^0-9A-Fa-f]/g, '');
      const bytes: number[] = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      push({ kind: 'str', v: decodePdfBytes(bytes) });
      i = end + 1;
    } else if (c === '[') {
      arrays.push([]);
      i++;
    } else if (c === ']') {
      const arr = arrays.pop() ?? [];
      push({ kind: 'arr', v: arr });
      i++;
    } else if (c === '/') {
      i++;
      while (i < src.length && !isWs(src.charCodeAt(i)) && !'/[]()<>{}%'.includes(src[i]!)) i++;
      push({ kind: 'other' });
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
      const strOf = (o: Operand | undefined) => (o?.kind === 'str' ? o.v : '');
      switch (op) {
        case 'BT':
          if (line.trim()) newline();
          break;
        case 'Tj':
          emit(strOf(stack[stack.length - 1]));
          break;
        case "'":
          newline();
          emit(strOf(stack[stack.length - 1]));
          break;
        case '"':
          newline();
          emit(strOf(stack[stack.length - 1]));
          break;
        case 'TJ': {
          const arr = stack[stack.length - 1];
          if (arr?.kind === 'arr')
            for (const it of arr.v) {
              if (it.kind === 'str') emit(it.v);
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
          const ei = src.slice(i).search(/\sEI(\s|$)/);
          i = ei < 0 ? src.length : i + ei + 3;
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
}

export function extractPdfText(buf: Buffer, limits: Limits = DOCUMENT_LIMITS): PdfTextResult {
  const s = buf.toString('latin1');
  if (/\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(s)) throw rejected('PDF_ENCRYPTED', 'Encrypted PDFs are not supported.');
  const inflater = new Inflater(limits);
  const objects = scanObjects(buf, s, limits, inflater);
  const removed = new Set<string>();
  for (const o of objects.values()) for (const [re, code] of ACTIVE_CONTENT) if (re.test(o.body)) removed.add(code);
  const pages = pageObjects(objects, s, limits);
  const budget = { chars: limits.maxChars };
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
    const parts: string[] = [];
    for (const num of contents.slice(0, 64)) {
      const obj = objects.get(num);
      if (!obj) continue;
      const data = decodeStream(obj, inflater);
      if (data) parts.push(contentText(data.toString('latin1'), budget));
    }
    return parts
      .join('\n')
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  });
  return { pages: texts, activeContentRemoved: [...removed].sort() };
}
