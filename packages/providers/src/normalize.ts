// Deterministic normalization of provider identity, service area, contact values and provider-supplied text
// (FR-07). Provider strings are untrusted data: they are NFKC-normalized, stripped of control and format characters,
// bounded, and never interpreted. Contact values are digested for dedupe/joins and never logged.
import { canonicalDigest } from '@uptimebuyer/domain';
import { sha256Digest } from '@uptimebuyer/data';

// Control (Cc), format (Cf: zero-width, bidi overrides), private use and unassigned code points.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu;

/** Display-safe provider text: NFKC, no control/format characters, collapsed whitespace, bounded. */
export function safeProviderText(raw: string, max = 200): string {
  return raw.normalize('NFKC').replace(UNSAFE, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Lowercase ASCII-alphanumeric word form used for dedupe ("FrostFix  Refrigeration Ltd." -> "frostfix refrigeration ltd"). */
export function normalizeProviderName(raw: string): string {
  return safeProviderText(raw, 400)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 200)
    .trim();
}

export function normalizePostalCode(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const v = safeProviderText(raw, 40)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{2,10}$/.test(v) ? v : null;
}

export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : null;
}

export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = safeProviderText(raw, 253)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(v) ? v : null;
}

export type ContactChannel = 'PHONE' | 'EMAIL' | 'API';

/** Canonical contact value per channel, or null when it cannot be a valid value. */
export function normalizeContactValue(channel: ContactChannel, raw: string): string | null {
  const v = safeProviderText(raw, 320);
  if (channel === 'PHONE') {
    const digits = v.replace(/[^\d+]/g, '');
    const e164 = digits.startsWith('+') ? `+${digits.slice(1).replace(/\+/g, '')}` : null;
    return e164 && /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
  }
  if (channel === 'EMAIL') {
    const e = v.toLowerCase();
    return /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}$/.test(e) ? e : null;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v) ? v : null;
}

export const contactValueDigest = (channel: ContactChannel, value: string) => sha256Digest(`${channel}\n${value}`);

export interface ServiceArea {
  countries: string[];
  postalPrefixes: string[];
}

export function normalizeServiceArea(raw: {
  countries?: readonly string[];
  postalPrefixes?: readonly string[];
}): ServiceArea {
  const countries = [...new Set((raw.countries ?? []).map(normalizeCountry).filter((c): c is string => c !== null))]
    .sort()
    .slice(0, 50);
  const postalPrefixes = [
    ...new Set((raw.postalPrefixes ?? []).map((p) => normalizePostalCode(p)).filter((p): p is string => p !== null)),
  ]
    .sort()
    .slice(0, 200);
  return { countries, postalPrefixes };
}

/** Whether a location falls in a declared service area; UNKNOWN when the area or location is not declared. */
export function serviceAreaMatch(
  area: ServiceArea,
  at: { country: string | null; postalCode: string | null },
): 'IN_AREA' | 'OUT_OF_AREA' | 'UNKNOWN' {
  if (area.countries.length === 0 || at.country === null) return 'UNKNOWN';
  if (!area.countries.includes(at.country)) return 'OUT_OF_AREA';
  if (area.postalPrefixes.length === 0 || at.postalCode === null) return 'UNKNOWN';
  return area.postalPrefixes.some((p) => at.postalCode!.startsWith(p)) ? 'IN_AREA' : 'OUT_OF_AREA';
}

/** Tenant-scoped dedupe key for a discovered provider (normalized name + country + postal code + domain). */
export function providerDedupeKey(
  tenantId: string,
  p: { normalizedName: string; country: string | null; postalCode: string | null; websiteDomain: string | null },
): string {
  return canonicalDigest('service-provider', 1, {
    tenantId,
    normalizedName: p.normalizedName,
    country: p.country,
    postalCode: p.postalCode,
    websiteDomain: p.websiteDomain,
  });
}
