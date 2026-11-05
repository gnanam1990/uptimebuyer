// Redaction for every telemetry surface (INV-13, NFR-06, NFR-09). Logs, span attributes, alert payloads and metric
// help text pass through here before they are written. Two independent layers: sensitive keys are replaced whatever
// their value, and secret-shaped values (bearer tokens, JWTs, PEM keys, secret references, credentialed URLs, contact
// values, card numbers, registered secret values) are replaced wherever they appear. Output is bounded in depth,
// string length and key count so a hostile payload cannot blow up a log line.

export const REDACTED = '[REDACTED]';
export const DEPTH_LIMIT = '[DEPTH_LIMIT]';
export const DROPPED = '[DROPPED]';

const MAX_DEPTH = 8;
const MAX_STRING = 1_024;
const MAX_KEYS = 200;
const MIN_SECRET_LENGTH = 8;

// Normalized (lowercase, separators removed) key fragments that always carry sensitive values.
const SENSITIVE_KEY =
  /authorization|cookie|password|passwd|passphrase|secret|token|apikey|privatekey|credential|signature|sessionkey|rawbody|rawtext|transcript|^body$|content$|phone|email|contactvalue|cardnumber|^pan$|cvv|iban|accountnumber|^otp$|^pin$|bearer|jwk$|^key$|signingkey|verifierkey|dsn|connectionstring|databaseurl/;
// Counters and identifiers that merely contain a sensitive fragment.
const SAFE_KEYS = new Set([
  'prompttokens',
  'completiontokens',
  'maxoutputtokens',
  'tokencount',
  'tokenbudget',
  'maxruntokens',
  'totaltokens',
  'tokensremaining',
  'signatureresult',
  'signaturealgorithm',
  'signaturekeyid',
  'bodydigest',
  'rawbodydigest',
  'contentdigest',
  'payloaddigest',
]);

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SAFE_KEYS.has(k)) return false;
  return SENSITIVE_KEY.test(k);
}

const luhn = (digits: string): boolean => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
};

// Every pattern has a bounded match length (no unbounded repetition), at most MAX_MATCH characters, so a scan window
// of MAX_STRING + MAX_MATCH sees every match that starts inside the kept prefix in full.
const MAX_MATCH = 8_192;
const VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8000}?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g,
  /\bBearer\s{1,8}[A-Za-z0-9._~+/=-]{8,4096}/gi,
  /\beyJ[A-Za-z0-9_-]{4,4096}\.[A-Za-z0-9_-]{4,4096}\.[A-Za-z0-9_-]{4,4096}/g,
  /\bsecretref:[^\s"'<>]{1,512}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,255}/g,
  /\b(?:sk|rk|pk)[-_](?:live|test|proj|ant)[-_][A-Za-z0-9_-]{8,255}/g,
  /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g,
  // Phone numbers: international or (area) groups with at least 9 digits.
  /(?<![\w-])\+\d[\d\s().-]{7,24}\d(?![\w-])/g,
  /(?<![\w-])\(\d{3}\)\s?\d{3}[\s.-]\d{4}(?![\w-])/g,
];
const CARD = /(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])/g;
const URL_START = /\b[a-z][a-z0-9+.-]{1,20}:\/\//gi;
const USERINFO_MAX = 512;

type Interval = [number, number];

/**
 * URL userinfo (M13 S3/S10): from after `scheme://` to the LAST `@` of the authority, whatever it contains (`/ ? # :
 * @ %40`, unicode). The authority candidate is the non-whitespace run after `://` (capped), cut at a `?` or `#` that
 * follows a path `/` (a query or fragment, not userinfo), so an e-mail address in a query never swallows the host.
 */
function userinfoIntervals(s: string, out: Interval[]): void {
  URL_START.lastIndex = 0;
  for (let m = URL_START.exec(s); m; m = URL_START.exec(s)) {
    const from = m.index + m[0].length;
    let end = from;
    while (end < s.length && end - from < USERINFO_MAX && !/[\s"'<>]/.test(s[end]!)) end++;
    let seenSlash = false;
    let cut = end;
    for (let i = from; i < end; i++) {
      const ch = s[i]!;
      if (ch === '/') seenSlash = true;
      else if ((ch === '?' || ch === '#') && seenSlash) {
        cut = i;
        break;
      }
    }
    const at = s.lastIndexOf('@', cut - 1);
    if (at >= from) out.push([from, at + 1]);
  }
}

function intervalsOf(s: string, secrets: readonly string[]): Interval[] {
  const out: Interval[] = [];
  for (const v of secrets) {
    if (v.length < MIN_SECRET_LENGTH) continue;
    for (let i = s.indexOf(v); i >= 0; i = s.indexOf(v, i + 1)) out.push([i, i + v.length]);
  }
  for (const re of VALUE_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      out.push([m.index, m.index + m[0].length]);
    }
  }
  CARD.lastIndex = 0;
  for (let m = CARD.exec(s); m; m = CARD.exec(s)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) out.push([m.index, m.index + m[0].length]);
  }
  userinfoIntervals(s, out);
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Interval[] = [];
  for (const iv of out) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged;
}

/**
 * Replace secret-shaped substrings and every registered secret value. Never throws. Work is bounded: patterns run
 * over the kept length plus the longest possible match. The output holds ONLY characters whose original offset is
 * below the kept length (M13 S9): every match is located on the original text first, a match that starts inside the
 * kept prefix is replaced whole (even when it straddles the cut), and nothing after the cut can shift in.
 */
export function redactString(input: string, secrets: readonly string[] = []): string {
  const full = String(input);
  const truncated = full.length > MAX_STRING;
  // Registered secrets may be longer than a pattern's bound: search them in a window that still holds a full one.
  const longestSecret = secrets.reduce((n, v) => Math.max(n, v.length), 0);
  const window = full.slice(0, MAX_STRING + Math.max(MAX_MATCH, longestSecret));
  const keep = Math.min(MAX_STRING, full.length);
  let out = '';
  let pos = 0;
  for (const [a, b] of intervalsOf(window, secrets)) {
    if (a >= keep) break;
    if (a > pos) out += full.slice(pos, a);
    out += REDACTED;
    pos = b;
  }
  if (pos < keep) out += full.slice(pos, keep);
  return truncated ? `${out}…[TRUNCATED]` : out;
}

export interface RedactionOptions {
  secrets?: readonly string[];
  maxDepth?: number;
}

/** Deep, bounded, redacted copy of any value. */
export function redactValue(value: unknown, opts: RedactionOptions = {}): unknown {
  const secrets = opts.secrets ?? [];
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') return redactString(v, secrets);
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'function' || typeof v === 'symbol') return DROPPED;
    if (depth >= maxDepth) return DEPTH_LIMIT;
    const o = v as object;
    if (seen.has(o)) return '[CYCLE]';
    seen.add(o);
    if (Array.isArray(o)) return o.slice(0, MAX_KEYS).map((x) => walk(x, depth + 1));
    if (o instanceof Date) return Number.isNaN(o.getTime()) ? null : o.toISOString();
    if (o instanceof Uint8Array) return `[BYTES:${o.byteLength}]`;
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, x] of Object.entries(o)) {
      if (n++ >= MAX_KEYS) {
        out['[KEYS_TRUNCATED]'] = true;
        break;
      }
      out[k] = isSensitiveKey(k) ? REDACTED : walk(x, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/** Values registered at runtime (configuration secrets, resolved credentials) that must never be written anywhere. */
export class SecretRegistry {
  readonly #values = new Set<string>();

  register(value: string | undefined | null): void {
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) this.#values.add(value);
  }

  values(): readonly string[] {
    return [...this.#values];
  }
}
