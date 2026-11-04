// Communication minimization and redaction (INV-13, NFR-06, FR-23). Every stored communication keeps a redacted text
// for authorized display, a redaction manifest (rule version and counts only, never the matched values) and, when
// processing consent allows, a minimum excerpt: only quote facts (price, ETA, availability) with speaker labels
// stripped, redaction markers excluded and instruction-like lines withheld. Raw content never leaves the isolated
// body table; the minimum excerpt is the only text that may enter an approved model run.
import { sha256Digest } from '@uptimebuyer/data';

export const REDACTION_RULE_VERSION = 'communication-redaction.v1';
export const REDACTION_CLASSES = Object.freeze(['SECRET', 'EMAIL', 'CARD', 'PHONE', 'URL', 'IBAN'] as const);
export type RedactionClass = (typeof REDACTION_CLASSES)[number];

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

type Rule = { cls: RedactionClass; re: RegExp; accept?: (m: string) => boolean };
const RULES: readonly Rule[] = [
  { cls: 'SECRET', re: /\b(?:sk|pk|rk|whsec)[-_](?:live|test)[-_][A-Za-z0-9_-]{6,}/gi },
  { cls: 'SECRET', re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi },
  { cls: 'SECRET', re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g },
  { cls: 'SECRET', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { cls: 'SECRET', re: /\b(?:password|passcode|passwd|api[-_ ]?key|secret|token|pin)\s*[:=]\s*\S+/gi },
  { cls: 'SECRET', re: /\b[A-Za-z0-9+/_-]{32,}={0,2}/g, accept: (m) => /\d/.test(m) && /[A-Za-z]/.test(m) },
  { cls: 'EMAIL', re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g },
  { cls: 'IBAN', re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g },
  {
    cls: 'CARD',
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: (m) => {
      const d = m.replace(/\D/g, '');
      return d.length >= 13 && d.length <= 19 && luhn(d);
    },
  },
  { cls: 'PHONE', re: /(?:\+|\b00)[1-9][\d\s().-]{6,18}\d/g },
  { cls: 'PHONE', re: /\b0\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g },
  { cls: 'URL', re: /\bhttps?:\/\/[^\s<>"]+/gi },
];

export interface RedactionManifest {
  readonly ruleVersion: string;
  readonly counts: Record<RedactionClass, number>;
}

export function redactCommunicationText(raw: string): { text: string; manifest: RedactionManifest } {
  const counts = Object.fromEntries(REDACTION_CLASSES.map((c) => [c, 0])) as Record<RedactionClass, number>;
  let text = raw.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === '\n' || ch === '\t' ? ch : ''));
  for (const rule of RULES)
    text = text.replace(rule.re, (m) => {
      if (rule.accept && !rule.accept(m)) return m;
      counts[rule.cls]++;
      return `[REDACTED:${rule.cls}]`;
    });
  return { text, manifest: { ruleVersion: REDACTION_RULE_VERSION, counts } };
}

const FACT = [
  /\b\d{1,7}(?:[.,]\d{2})?\s?(?:GBP|USD|EUR|CAD|AUD)\b/i,
  /[£$€]\s?\d/,
  /\bETA\b/i,
  /\b\d{1,4}\s?(?:minutes?|mins?|hours?|hrs?|days?)\b/i,
  /\b(?:availab(?:le|ility)|attend|arrive|on site|in stock|lead time)\b/i,
];
// Instruction- or authority-like lines are evidence of what was said, never part of a model excerpt.
const WITHHELD =
  /\b(?:approv\w*|authori[sz]\w*|compatib\w*|ignore\b|instruction|close (?:the )?incident|spend|override|allow|reject|system prompt)\b/i;

export const MINIMUM_EXCERPT_LIMITS = Object.freeze({ maxLines: 5, maxChars: 2_000 });

/** The minimum approved excerpt from already-redacted text, or null when no quote fact remains. */
export function minimumQuoteExcerpt(redacted: string): string | null {
  const lines: string[] = [];
  for (const rawLine of redacted.split(/\r?\n/)) {
    const line = rawLine.replace(/^[^:\n]{1,40}:\s*/, '').trim();
    if (!line || line.includes('[REDACTED:') || WITHHELD.test(line)) continue;
    if (!FACT.some((f) => f.test(line))) continue;
    lines.push(line.slice(0, 400));
    if (lines.length >= MINIMUM_EXCERPT_LIMITS.maxLines) break;
  }
  const excerpt = lines.join('\n').slice(0, MINIMUM_EXCERPT_LIMITS.maxChars).trim();
  return excerpt.length > 0 ? excerpt : null;
}

export const contentDigest = (raw: string) => sha256Digest(raw);
