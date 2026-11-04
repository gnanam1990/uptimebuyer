// Untrusted-text controls (AI-SAFETY §5, INV-13). Retrieved documents and model output are data, never instructions.
// Instruction-like lines are flagged at ingestion and withheld from model excerpts; secrets and payment identifiers
// are redacted before any text can reach a model; model output with URLs or secret material is rejected. Flags are
// recorded as evidence; they never unlock or change behaviour.

export const INJECTION_FLAGS = Object.freeze([
  'INSTRUCTION_OVERRIDE',
  'TOOL_REQUEST',
  'SECRET_REQUEST',
  'EGRESS_REQUEST',
  'POLICY_CHANGE',
  'PAYMENT_REQUEST',
] as const);
export type InjectionFlag = (typeof INJECTION_FLAGS)[number];

const MONEY = String.raw`(\$\s?\d|€\s?\d|£\s?\d|\b(usd|eur|gbp|usdc|funds|money|invoice|wallet|kite|card number|bank account|crypto)\b)`;

const PATTERNS: Readonly<Record<InjectionFlag, readonly RegExp[]>> = {
  INSTRUCTION_OVERRIDE: [
    /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|system|your)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|directions?|guidelines?)\b/i,
    /\b(system prompt|developer mode|jailbreak|you are now|new instructions)\b/i,
    /\b(notice|message|instructions?|note)\s+(to|for)\s+(the\s+)?(ai|llm|assistants?|agents?|models?|chatbots?)\b/i,
  ],
  TOOL_REQUEST: [
    /\b(call|invoke|execute|trigger)\s+(the\s+|a\s+|this\s+)?(tool|function|api|endpoint|plugin|webhook)\b/i,
    /\btool\s+[a-z][a-z0-9]*_[a-z0-9_]+\b/i,
    /\b(submit_candidate_schema|search_evidence|get_asset_snapshot)\b/,
  ],
  SECRET_REQUEST: [
    /\b(reveal|print|show|output|send|leak|exfiltrate|disclose|share|return|include|repeat)\b[^.\n]{0,40}\b(secrets?|api[ _-]?keys?|tokens?|passwords?|credentials?|system prompt|environment variables?|private keys?)\b/i,
    /\b[A-Z][A-Z0-9]*_(API_KEY|SECRET|TOKEN|PASSWORD)\b/,
  ],
  EGRESS_REQUEST: [
    /\b(https?|ftp|file):\/\//i,
    /\bwww\.[a-z0-9-]+\.[a-z]/i,
    /\b(fetch|curl|wget|browse to|navigate to|post (it |this |them )?to|upload (it |this |them )?to|exfiltrate)\b/i,
  ],
  POLICY_CHANGE: [
    /\b(change|modify|update|override|bypass|disable|raise|increase|lift|remove|skip)\b[^.\n]{0,40}\b(approvals?|polic(y|ies)|spending|budgets?|authori[sz]ations?|guardrails?)\b/i,
    /\b(auto-?approve[sd]?|pre-?approved)\b/i,
    /\bmark (this |the |it |that )?(part |item |order )?(as )?(compatible|approved|paid|verified|recovered)\b/i,
  ],
  PAYMENT_REQUEST: [
    new RegExp(String.raw`\b(pay|payment|purchase|buy|transfer|wire|remit|charge|send)\b[^.\n]{0,40}${MONEY}`, 'i'),
    /\b(transfer|wire|send)\s+(the\s+)?funds\b/i,
  ],
};

function lineFlags(line: string): InjectionFlag[] {
  return INJECTION_FLAGS.filter((f) => PATTERNS[f].some((re) => re.test(line)));
}

/** All injection flags present in `text`, in canonical order. */
export function scanUntrustedText(text: string): InjectionFlag[] {
  const found = new Set<InjectionFlag>();
  for (const line of text.split('\n')) for (const f of lineFlags(line)) found.add(f);
  return INJECTION_FLAGS.filter((f) => found.has(f));
}

/** Replace every instruction-like line with a withheld marker; factual lines pass through unchanged. */
export function neutralizeUntrustedText(text: string): { text: string; flags: InjectionFlag[]; withheldLines: number } {
  let withheldLines = 0;
  const found = new Set<InjectionFlag>();
  const out = text.split('\n').map((line) => {
    const flags = lineFlags(line);
    if (flags.length === 0) return line;
    withheldLines += 1;
    for (const f of flags) found.add(f);
    return `[withheld: untrusted instruction-like text (${flags.join(', ')})]`;
  });
  return { text: out.join('\n'), flags: INJECTION_FLAGS.filter((f) => found.has(f)), withheldLines };
}

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
};

// Assembled at runtime so this file itself never contains a key-shaped literal.
const PEM = new RegExp(['-----BEGIN [A-Z ]*', 'PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)'].join(''), 'g');
const SECRET_PATTERNS: readonly RegExp[] = [
  PEM,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:xox[abpors]|gh[pousr])[-_][A-Za-z0-9_-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /secretref:[^\s"'<>]+/g,
];
const ASSIGNED = /\b(api[ _-]?key|secret|token|password|passwd|passcode|credential|pin)\b(\s*(?:is|=|:)\s*)(\S{6,})/gi;
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;

/** Redact credentials, bearer tokens, secret references and payment card numbers. Content digests are kept. */
export function redactSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const re of SECRET_PATTERNS)
    out = out.replace(re, () => {
      redactions += 1;
      return '[redacted]';
    });
  out = out.replace(ASSIGNED, (_m, name: string, sep: string, value: string) => {
    if (value === '[redacted]') return `${name}${sep}${value}`;
    redactions += 1;
    return `${name}${sep}[redacted]`;
  });
  out = out.replace(CARD, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return m;
    redactions += 1;
    return '[redacted]';
  });
  return { text: out, redactions };
}

/** Personal contact data in communication excerpts (INV-13 minimization). */
export function redactContacts(text: string): { text: string; redactions: number } {
  let redactions = 0;
  const out = text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => {
      redactions += 1;
      return '[redacted-email]';
    })
    .replace(/(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{3}[ .-]\d{3,4}(?:[ .-]\d{3,4})?/g, (m) => {
      if (m.replace(/\D/g, '').length < 7) return m;
      redactions += 1;
      return '[redacted-phone]';
    });
  return { text: out, redactions };
}

/** Values of environment variables that name secrets; they must never appear in model input or stored output. */
export function envSecretValues(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE)/i.test(k) && typeof v === 'string' && v.length >= 8)
    .map(([, v]) => v as string);
}

export function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => n.length > 0 && haystack.includes(n));
}

/** Replace known secret values (exact) with a marker. */
export function scrubValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of values) if (v) out = out.split(v).join('[redacted]');
  return out;
}

const URL_LIKE = [/\b(https?|ftp|file|javascript):\/?\//i, /\bwww\.[a-z0-9-]+\.[a-z]/i];

/** Violations in model output text: executable URLs and secret material (env values or secret-shaped strings). */
export function findOutputViolations(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): ('EXECUTABLE_URL_IN_OUTPUT' | 'SECRET_IN_OUTPUT')[] {
  const v: ('EXECUTABLE_URL_IN_OUTPUT' | 'SECRET_IN_OUTPUT')[] = [];
  if (URL_LIKE.some((re) => re.test(text))) v.push('EXECUTABLE_URL_IN_OUTPUT');
  if (containsAny(text, envSecretValues(env)) || redactSecrets(text).redactions > 0) v.push('SECRET_IN_OUTPUT');
  return v;
}
