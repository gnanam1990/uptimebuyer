// Unambiguous formatting (UI-SPEC §5.3, §13): money from integer minor units with the ISO 4217 exponent using exact
// string arithmetic (never floating point), UTC instants that say UTC, and milli-degrees Celsius with one decimal.
const EXPONENT: Record<string, number> = { JPY: 0, KRW: 0, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3 };

export function formatMinor(amountMinor: string, currency: string): string {
  if (!/^-?\d+$/.test(amountMinor)) return `Not reported ${currency}`;
  const neg = amountMinor.startsWith('-');
  const digits = neg ? amountMinor.slice(1) : amountMinor;
  const exp = EXPONENT[currency] ?? 2;
  if (exp === 0) return `${neg ? '-' : ''}${digits.replace(/^0+(?=\d)/, '')} ${currency}`;
  const padded = digits.padStart(exp + 1, '0');
  const whole = padded.slice(0, -exp).replace(/^0+(?=\d)/, '');
  return `${neg ? '-' : ''}${whole}.${padded.slice(-exp)} ${currency}`;
}

export function formatMoney(m: { amountMinor: string; currency: string } | null | undefined): string {
  return m ? formatMinor(m.amountMinor, m.currency) : 'Not reported';
}

export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return 'Not reported';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'Not reported';
  return `${new Date(t).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function formatMilliCelsius(v: number): string {
  const sign = v < 0 ? '-' : '';
  const tenths = Math.round(Math.abs(v) / 100);
  return `${sign}${Math.floor(tenths / 10)}.${tenths % 10} °C`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'Not reported';
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Human words for a machine code (IDs and codes stay copyable elsewhere). */
export function humanize(code: string): string {
  const s = code.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
