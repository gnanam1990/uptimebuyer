// Font text decoding tables for the bounded PDF parser (uptimebuyer-parser.v3, ADR 0002): a ToUnicode CMap parser
// (codespacerange, bfchar, bfrange in both forms, 1- and 2-byte codes), a standard glyph-name -> Unicode subset for
// /Differences, the WinAnsi, Standard and Symbol simple encodings, and the code-point policy that every decoded
// character passes. Nothing here executes a font program, follows `usecmap` or reads anything but the given bytes.
//
// Fail-closed rules: a CMap that is malformed in any entry is refused as a whole (the font's text is withheld); a CMap
// over the size or mapping bounds rejects the document (NFR-04: exceeding a bound is a typed rejection, never silent
// truncation); a mapping to an invalid code point (lone surrogate, control, non-character, private use, bidi control,
// out of range) withholds that glyph. Withheld text is shown as U+FFFD and its reason is recorded on the document.
import { rejected } from './errors.js';

export const WITHHELD = '�';
export const WITHHELD_REASONS = Object.freeze([
  'CMAP_REFUSED',
  'CODE_POINT_INVALID',
  'CONTENT_STREAM_UNREADABLE',
  'FONT_ENCODING_UNKNOWN',
  'GLYPH_UNMAPPED',
] as const);
export type WithheldReason = (typeof WITHHELD_REASONS)[number];

export interface CMapLimits {
  maxCMapBytes: number;
  maxCMapMappings: number;
}

/** A mapping value: clean text, or the reason the glyph is withheld. */
export type Mapped = string | { withheld: WithheldReason };

export interface ToUnicodeMap {
  /** Declared code lengths in bytes (1 or 2); empty when the CMap declares no codespace. */
  codeLengths: number[];
  ranges: { len: number; lo: number; hi: number }[];
  /** Key: len * 0x10000 + code. */
  map: Map<number, Mapped>;
}

const tooLarge = () => rejected('CMAP_TOO_LARGE', 'A font CMap exceeds the document bound.');
/** Thrown inside the parser for any malformed construct; the caller refuses the CMap (the font is withheld). */
class Malformed extends Error {}
const bad = (): never => {
  throw new Malformed();
};

/** Longest ToUnicode destination accepted, in bytes (the PDF format allows 512; real ligature maps use a few). */
export const MAX_DESTINATION_BYTES = 64;

// ------------------------------------------------------------------------------------------------- code points

const LIGATURES: Readonly<Record<number, string>> = {
  0xfb00: 'ff',
  0xfb01: 'fi',
  0xfb02: 'fl',
  0xfb03: 'ffi',
  0xfb04: 'ffl',
  0xfb05: 'st',
  0xfb06: 'st',
};

/**
 * Apply the code-point policy to decoded text: invisible format characters are dropped, presentation ligatures are
 * expanded, line separators become spaces; anything that is not plain visible text makes the whole value invalid.
 * U+F020 (the space of Microsoft symbol fonts) is a space.
 */
export function cleanDecoded(s: string, symbolFont = false): Mapped {
  // Symbol fonts map their glyphs into U+F020..U+F0FF (the Microsoft symbol-font convention): read them through the
  // Symbol encoding, or withhold them.
  if (symbolFont && s.length === 1 && s.charCodeAt(0) >= 0xf020 && s.charCodeAt(0) <= 0xf0ff)
    return SYMBOL.get(s.charCodeAt(0) - 0xf000) ?? { withheld: 'CODE_POINT_INVALID' };
  let out = '';
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return { withheld: 'CODE_POINT_INVALID' };
      c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return { withheld: 'CODE_POINT_INVALID' };
    if (c === WITHHELD.charCodeAt(0)) return { withheld: 'GLYPH_UNMAPPED' };
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return { withheld: 'CODE_POINT_INVALID' };
    if ((c >= 0xfdd0 && c <= 0xfdef) || (c & 0xfffe) === 0xfffe) return { withheld: 'CODE_POINT_INVALID' };
    if (c === 0x061c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069))
      return { withheld: 'CODE_POINT_INVALID' };
    if ((c >= 0x200b && c <= 0x200d) || (c >= 0x2060 && c <= 0x2064) || c === 0xfeff) continue;
    if (c === 0x2028 || c === 0x2029 || c === 0xf020) {
      out += ' ';
      continue;
    }
    if ((c >= 0xe000 && c <= 0xf8ff) || c >= 0xf0000) return { withheld: 'CODE_POINT_INVALID' };
    if (c === 0x00ad) {
      out += '-';
      continue;
    }
    const lig = LIGATURES[c];
    out += lig ?? String.fromCodePoint(c);
  }
  return out;
}

// ----------------------------------------------------------------------------------------------- glyph names

const ASCII_NAMES = (
  'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma ' +
  'hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question ' +
  'at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore ' +
  'grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde'
).split(' ');
const LATIN1_NAMES = (
  'exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot ' +
  'softhyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla ' +
  'onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex ' +
  'Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth ' +
  'Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn ' +
  'germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave ' +
  'iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ' +
  'ucircumflex udieresis yacute thorn ydieresis'
).split(' ');
const OTHER_NAMES: Readonly<Record<string, number>> = {
  Euro: 0x20ac,
  quotesinglbase: 0x201a,
  florin: 0x0192,
  quotedblbase: 0x201e,
  ellipsis: 0x2026,
  dagger: 0x2020,
  daggerdbl: 0x2021,
  circumflex: 0x02c6,
  perthousand: 0x2030,
  Scaron: 0x0160,
  guilsinglleft: 0x2039,
  OE: 0x0152,
  Zcaron: 0x017d,
  quoteleft: 0x2018,
  quoteright: 0x2019,
  quotedblleft: 0x201c,
  quotedblright: 0x201d,
  bullet: 0x2022,
  endash: 0x2013,
  emdash: 0x2014,
  tilde: 0x02dc,
  trademark: 0x2122,
  scaron: 0x0161,
  guilsinglright: 0x203a,
  oe: 0x0153,
  zcaron: 0x017e,
  Ydieresis: 0x0178,
  nbspace: 0x00a0,
  minus: 0x2212,
  fraction: 0x2044,
  Lslash: 0x0141,
  lslash: 0x0142,
  dotlessi: 0x0131,
  breve: 0x02d8,
  caron: 0x02c7,
  dotaccent: 0x02d9,
  hungarumlaut: 0x02dd,
  ogonek: 0x02db,
  ring: 0x02da,
  notequal: 0x2260,
  lessequal: 0x2264,
  greaterequal: 0x2265,
  approxequal: 0x2248,
  infinity: 0x221e,
  micro: 0x00b5,
  Omega: 0x03a9,
  Delta: 0x0394,
  pi: 0x03c0,
  radical: 0x221a,
  summation: 0x2211,
  partialdiff: 0x2202,
  integral: 0x222b,
  lozenge: 0x25ca,
  arrowright: 0x2192,
  arrowleft: 0x2190,
  arrowup: 0x2191,
  arrowdown: 0x2193,
  ff: 0xfb00,
  fi: 0xfb01,
  fl: 0xfb02,
  ffi: 0xfb03,
  ffl: 0xfb04,
};
const GLYPH_NAMES: ReadonlyMap<string, number> = new Map<string, number>([
  ...ASCII_NAMES.map((n, i) => [n, 0x20 + i] as [string, number]),
  ...LATIN1_NAMES.map((n, i) => [n, 0xa1 + i] as [string, number]),
  ...Object.entries(OTHER_NAMES),
]);

/**
 * Resolve a glyph name (Adobe Glyph List rules, limited): a known name, `uniXXXX[XXXX...]`, `uXXXX[XX]`, a name with a
 * `.suffix` (resolved without it) or `a_b` components. Anything else is unknown (null): never guessed from the name.
 */
export function glyphNameToUnicode(raw: string): string | null {
  if (raw.length === 0 || raw.length > 127) return null;
  const name = raw.split('.')[0]!;
  if (name.includes('_')) {
    const parts = name.split('_').map((p) => glyphNameToUnicode(p));
    return parts.length <= 8 && parts.every((p) => p !== null) ? parts.join('') : null;
  }
  const known = GLYPH_NAMES.get(name);
  if (known !== undefined) return String.fromCodePoint(known);
  let m = /^uni((?:[0-9A-F]{4}){1,8})$/.exec(name);
  if (m) {
    let out = '';
    for (let i = 0; i < m[1]!.length; i += 4) {
      const c = parseInt(m[1]!.slice(i, i + 4), 16);
      if (c >= 0xd800 && c <= 0xdfff) return null;
      out += String.fromCharCode(c);
    }
    return out;
  }
  m = /^u([0-9A-F]{4,6})$/.exec(name);
  if (m) {
    const c = parseInt(m[1]!, 16);
    return c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff) ? null : String.fromCodePoint(c);
  }
  return null;
}

// --------------------------------------------------------------------------------------------- simple encodings

/** WinAnsiEncoding (PDF 32000 Annex D): Latin-1 plus the 0x80..0x9F block; undefined codes map to null. */
export const WIN_ANSI_V3: readonly (string | null)[] = (() => {
  const t: (string | null)[] = [];
  for (let c = 0; c < 256; c++) t.push(c < 0x20 ? ' ' : c === 0x7f ? null : String.fromCharCode(c));
  const high = '€\0‚ƒ„…†‡ˆ‰Š‹Œ\0Ž\0\0‘’“”•–—˜™š›œ\0žŸ';
  for (let i = 0; i < 32; i++) t[0x80 + i] = high[i] === '\0' ? null : high[i]!;
  t[0x09] = '\t';
  t[0xad] = '-';
  return t;
})();

/** StandardEncoding (PDF 32000 Annex D): ASCII with quoteright/quoteleft at 0x27/0x60, and its own upper half. */
export const STANDARD_V3: readonly (string | null)[] = (() => {
  const t: (string | null)[] = [];
  for (let c = 0; c < 256; c++) t.push(c < 0x20 ? ' ' : c < 0x7f ? String.fromCharCode(c) : null);
  t[0x27] = '’';
  t[0x60] = '‘';
  const upper: Readonly<Record<number, string>> = {
    0xa1: 'exclamdown', 0xa2: 'cent', 0xa3: 'sterling', 0xa4: 'fraction', 0xa5: 'yen', 0xa6: 'florin', 0xa7: 'section',
    0xa8: 'currency', 0xa9: 'quotesingle', 0xaa: 'quotedblleft', 0xab: 'guillemotleft', 0xac: 'guilsinglleft',
    0xad: 'guilsinglright', 0xae: 'fi', 0xaf: 'fl', 0xb1: 'endash', 0xb2: 'dagger', 0xb3: 'daggerdbl',
    0xb4: 'periodcentered', 0xb6: 'paragraph', 0xb7: 'bullet', 0xb8: 'quotesinglbase', 0xb9: 'quotedblbase',
    0xba: 'quotedblright', 0xbb: 'guillemotright', 0xbc: 'ellipsis', 0xbd: 'perthousand', 0xbf: 'questiondown',
    0xc1: 'grave', 0xc2: 'acute', 0xc3: 'circumflex', 0xc4: 'tilde', 0xc5: 'macron', 0xc6: 'breve', 0xc7: 'dotaccent',
    0xc8: 'dieresis', 0xca: 'ring', 0xcb: 'cedilla', 0xcd: 'hungarumlaut', 0xce: 'ogonek', 0xcf: 'caron', 0xd0: 'emdash',
    0xe1: 'AE', 0xe3: 'ordfeminine', 0xe8: 'Lslash', 0xe9: 'Oslash', 0xea: 'OE', 0xeb: 'ordmasculine', 0xf1: 'ae',
    0xf5: 'dotlessi', 0xf8: 'lslash', 0xf9: 'oslash', 0xfa: 'oe', 0xfb: 'germandbls',
  };
  for (const [code, name] of Object.entries(upper)) {
    const g = glyphNameToUnicode(name);
    const v = g === null ? null : cleanDecoded(g);
    t[Number(code)] = typeof v === 'string' ? v : null;
  }
  return t;
})();

/**
 * MacRomanEncoding (PDF 32000 Annex D): ASCII (0x27 quotesingle, 0x60 grave) and its own upper half. Annex D defines
 * only the standard Latin character set, so the 15 Mac OS Roman glyphs outside it (notequal, infinity, lessequal,
 * greaterequal, partialdiff, summation, product, pi, integral, Omega, radical, approxequal, Delta, lozenge, apple) are
 * not part of this encoding and stay unmapped (withheld). 0xCA is the space glyph.
 */
export const MAC_ROMAN_V3: readonly (string | null)[] = (() => {
  const t: (string | null)[] = [];
  for (let c = 0; c < 256; c++) t.push(c < 0x20 ? ' ' : c < 0x7f ? String.fromCharCode(c) : null);
  const upper = [
    // 0x80..0x9F
    'Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla',
    'eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis',
    'otilde uacute ugrave ucircumflex udieresis',
    // 0xA0..0xBF
    'dagger degree cent sterling section bullet paragraph germandbls registered copyright trademark acute dieresis -',
    'AE Oslash - plusminus - - yen mu - - - - - ordfeminine ordmasculine - ae oslash',
    // 0xC0..0xDF
    'questiondown exclamdown logicalnot - florin - - guillemotleft guillemotright ellipsis space Agrave Atilde Otilde OE',
    'oe endash emdash quotedblleft quotedblright quoteleft quoteright divide - ydieresis Ydieresis fraction currency',
    'guilsinglleft guilsinglright fi fl',
    // 0xE0..0xFF
    'daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave',
    'Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex - Ograve Uacute Ucircumflex Ugrave dotlessi circumflex',
    'tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron',
  ]
    .join(' ')
    .split(' ');
  if (upper.length !== 128) throw new Error('MacRomanEncoding table must have 128 upper-half entries');
  upper.forEach((name, i) => {
    if (name === '-') return;
    const g = glyphNameToUnicode(name);
    const v = g === null ? null : cleanDecoded(g);
    t[0x80 + i] = typeof v === 'string' ? v : null;
  });
  return t;
})();

/** Adobe Symbol encoding, standard subset (Greek letters, mathematical operators, arrows and punctuation). */
export const SYMBOL: ReadonlyMap<number, string> = (() => {
  const m = new Map<number, string>();
  for (const c of ' !#%&()+,./0123456789:;<=>?[]_{|}') m.set(c.charCodeAt(0), c);
  const pairs: [number, number][] = [
    [0x22, 0x2200], [0x24, 0x2203], [0x27, 0x220b], [0x2a, 0x2217], [0x2d, 0x2212], [0x40, 0x2245], [0x5c, 0x2234],
    [0x5e, 0x22a5], [0x7e, 0x223c], [0xa2, 0x2032], [0xa3, 0x2264], [0xa4, 0x2044], [0xa5, 0x221e], [0xa7, 0x2663],
    [0xab, 0x2194], [0xac, 0x2190], [0xad, 0x2191], [0xae, 0x2192], [0xaf, 0x2193], [0xb0, 0x00b0], [0xb1, 0x00b1],
    [0xb2, 0x2033], [0xb3, 0x2265], [0xb4, 0x00d7], [0xb5, 0x221d], [0xb6, 0x2202], [0xb7, 0x2022], [0xb8, 0x00f7],
    [0xb9, 0x2260], [0xba, 0x2261], [0xbb, 0x2248], [0xbc, 0x2026], [0xc6, 0x2205], [0xc7, 0x2229], [0xc8, 0x222a],
    [0xce, 0x2208], [0xcf, 0x2209], [0xd6, 0x221a], [0xd7, 0x22c5], [0xd8, 0x00ac], [0xd9, 0x2227], [0xda, 0x2228],
    [0xe5, 0x2211], [0xf2, 0x222b],
  ];
  for (const [k, v] of pairs) m.set(k, String.fromCharCode(v));
  const upper = 'ΑΒΧΔΕΦΓΗΙ\0ΚΛΜΝΟΠΘΡΣΤΥ\0ΩΞΨΖ';
  const lower = 'αβχδεφγηιϕκλμνοπθρστυϖωξψζ';
  for (let i = 0; i < 26; i++) {
    if (upper[i] !== '\0') m.set(0x41 + i, upper[i]!);
    m.set(0x61 + i, lower[i]!);
  }
  return m;
})();

// ---------------------------------------------------------------------------------------------- ToUnicode CMap

type Tok = { t: 'hex'; v: string } | { t: 'name'; v: string } | { t: 'word'; v: string } | { t: '[' } | { t: ']' };

const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const DELIM = '()<>[]{}/%';

/** Linear tokenizer: hex strings, names, words, array brackets; dictionaries, literal strings and comments skipped. */
function* tokens(s: string): Generator<Tok> {
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    const code = s.charCodeAt(i);
    if (isWs(code)) i++;
    else if (c === '%') {
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
    } else if (c === '(') {
      let depth = 0;
      for (; i < s.length; i++) {
        if (s[i] === '\\') i++;
        else if (s[i] === '(') depth++;
        else if (s[i] === ')' && --depth === 0) break;
      }
      if (i >= s.length) bad();
      i++;
    } else if (c === '<' && s[i + 1] === '<') i += 2;
    else if (c === '>' && s[i + 1] === '>') i += 2;
    else if (c === '<') {
      const end = s.indexOf('>', i + 1);
      if (end < 0) bad();
      const hex = s.slice(i + 1, end).replace(/[\s\0]+/g, '');
      if (!/^[0-9A-Fa-f]*$/.test(hex) || hex.length % 2 !== 0) bad();
      yield { t: 'hex', v: hex.toUpperCase() };
      i = end + 1;
    } else if (c === '[' || c === ']') {
      yield { t: c };
      i++;
    } else if (c === '{' || c === '}' || c === ')' || c === '>') i++;
    else if (c === '/') {
      let j = i + 1;
      while (j < s.length && !isWs(s.charCodeAt(j)) && !DELIM.includes(s[j]!)) j++;
      yield { t: 'name', v: s.slice(i + 1, j) };
      i = j;
    } else {
      let j = i;
      while (j < s.length && !isWs(s.charCodeAt(j)) && !DELIM.includes(s[j]!)) j++;
      yield { t: 'word', v: s.slice(i, j) };
      i = j;
    }
  }
}

const utf16 = (hex: string): string => {
  let out = '';
  for (let k = 0; k < hex.length; k += 4) out += String.fromCharCode(parseInt(hex.slice(k, k + 4), 16));
  return out;
};

/** Validate a destination hex string (UTF-16BE, whole code units, bounded). */
function destination(hex: string): string {
  if (hex.length === 0 || hex.length % 4 !== 0 || hex.length / 2 > MAX_DESTINATION_BYTES) bad();
  return utf16(hex);
}

type Entry = Tok | { t: 'arr'; v: string[] };
const hexOf = (e: Entry | undefined): string => (e?.t === 'hex' ? e.v : bad());

/**
 * Parse a ToUnicode CMap program. Returns null when it is refused (malformed, `usecmap`, CID operators, codes longer
 * than 2 bytes); throws CMAP_TOO_LARGE when it exceeds a bound. `budget.mappings` is the document-wide mapping budget
 * and is charged before any range is expanded, so a range bomb is refused without being materialised.
 */
export function parseToUnicode(
  src: string,
  limits: CMapLimits,
  budget: { mappings: number },
  symbolFont = false,
): ToUnicodeMap | null {
  const clean = (t: string) => cleanDecoded(t, symbolFont);
  if (src.length > limits.maxCMapBytes) throw tooLarge();
  const map = new Map<number, Mapped>();
  const ranges: ToUnicodeMap['ranges'] = [];
  let count = 0;
  const charge = (n: number) => {
    count += n;
    budget.mappings -= n;
    if (count > limits.maxCMapMappings || budget.mappings < 0) throw tooLarge();
  };
  const srcLen = (hex: string) => {
    const len = hex.length / 2;
    if (len < 1 || len > 2) bad();
    if (ranges.length && !ranges.some((r) => r.len === len)) bad();
    return len;
  };
  const codespace = ([a, b]: Entry[]) => {
    const lo = hexOf(a);
    const hi = hexOf(b);
    if (lo.length !== hi.length) bad();
    const len = lo.length / 2;
    if (len < 1 || len > 2) bad();
    if (parseInt(lo, 16) > parseInt(hi, 16)) bad();
    ranges.push({ len, lo: parseInt(lo, 16), hi: parseInt(hi, 16) });
    if (ranges.length > 256) bad();
  };
  const bfchar = ([a, b]: Entry[]) => {
    const code = hexOf(a);
    const key = srcLen(code) * 0x10000 + parseInt(code, 16);
    charge(1);
    if (b!.t === 'name') {
      const g = glyphNameToUnicode(b!.v);
      map.set(key, g === null ? { withheld: 'GLYPH_UNMAPPED' } : clean(g));
    } else map.set(key, clean(destination(hexOf(b))));
  };
  const bfrange = ([a, b, d]: Entry[]) => {
    const loHex = hexOf(a);
    const hiHex = hexOf(b);
    if (loHex.length !== hiHex.length) bad();
    const len = srcLen(loHex);
    const lo = parseInt(loHex, 16);
    const hi = parseInt(hiHex, 16);
    if (lo > hi) bad();
    const n = hi - lo + 1;
    if (d!.t === 'arr') {
      if (d!.v.length !== n) bad();
      charge(n);
      d!.v.forEach((h, k) => map.set(len * 0x10000 + lo + k, clean(destination(h))));
      return;
    }
    const units = destination(hexOf(d));
    charge(n);
    const head = units.slice(0, -1);
    const last = units.charCodeAt(units.length - 1);
    for (let k = 0; k < n; k++) {
      const v = last + k;
      map.set(
        len * 0x10000 + lo + k,
        v > 0xffff ? { withheld: 'CODE_POINT_INVALID' } : clean(head + String.fromCharCode(v)),
      );
    }
  };
  const BLOCKS = { codespacerange: [2, codespace], bfchar: [2, bfchar], bfrange: [3, bfrange] } as const;
  type Kind = keyof typeof BLOCKS;
  try {
    let block: Kind | null = null;
    let pending: Entry[] = [];
    let array: string[] | null = null;
    for (const tok of tokens(src)) {
      if (array) {
        if (tok.t === ']') {
          pending.push({ t: 'arr', v: array });
          array = null;
        } else if (tok.t === 'hex') {
          array.push(tok.v);
          if (array.length > limits.maxCMapMappings) throw tooLarge();
          continue;
        } else bad();
      } else if (tok.t === 'word') {
        const m = /^(begin|end)(codespacerange|bfchar|bfrange|cidrange|cidchar|notdefrange)$/.exec(tok.v);
        if (tok.v === 'usecmap' || (m && !(m[2]! in BLOCKS))) bad();
        if (m) {
          const kind = m[2] as Kind;
          if (m[1] === 'begin' ? block !== null : block !== kind || pending.length !== 0) bad();
          block = m[1] === 'begin' ? kind : null;
          continue;
        }
        if (block !== null) bad();
        continue;
      } else if (block === null) continue;
      else if (tok.t === '[') {
        if (block !== 'bfrange' || pending.length !== 2) bad();
        array = [];
        continue;
      } else if (tok.t === ']') bad();
      else if (tok.t === 'name' && !(block === 'bfchar' && pending.length === 1)) bad();
      else pending.push(tok);
      const [arity, apply] = BLOCKS[block!];
      if (pending.length === arity) {
        apply(pending);
        pending = [];
      }
    }
    if (block !== null || array !== null) bad();
  } catch (e) {
    if (e instanceof Malformed) return null;
    throw e;
  }
  return { codeLengths: [...new Set(ranges.map((r) => r.len))].sort(), ranges, map };
}
