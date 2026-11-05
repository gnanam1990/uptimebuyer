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

const VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  /\bsecretref:[^\s"'<>]+/g,
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@"']+:[^\s/@"']+@/gi,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g,
  /\b(sk|rk|pk)[-_](live|test|proj|ant)[-_][A-Za-z0-9_-]{8,}/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  // Phone numbers: international or (area) groups with at least 9 digits.
  /(?<![\w-])\+\d[\d\s().-]{7,}\d(?![\w-])/g,
  /(?<![\w-])\(\d{3}\)\s?\d{3}[\s.-]\d{4}(?![\w-])/g,
];

function redactCards(s: string): string {
  return s.replace(/(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])/g, (m) => {
    const digits = m.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? REDACTED : m;
  });
}

/** Replace secret-shaped substrings and every registered secret value. Never throws. */
export function redactString(input: string, secrets: readonly string[] = []): string {
  let s = String(input);
  for (const v of secrets) if (v.length >= MIN_SECRET_LENGTH && s.includes(v)) s = s.split(v).join(REDACTED);
  for (const re of VALUE_PATTERNS) {
    re.lastIndex = 0;
    s = s.replace(re, REDACTED);
  }
  s = redactCards(s);
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[TRUNCATED]` : s;
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
