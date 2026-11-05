// Response hardening and abuse bounds: strict security headers (CSP on every response, no caching of authenticated
// data, no framing, no referrer) and in-memory token buckets for unauthenticated failures and for authority-bearing
// commands. Buckets are per process; a multi-instance deployment adds an edge limiter (NOT_RUN here).

export interface BucketConfig {
  capacity: number;
  refillPerSecond: number;
  maxKeys: number;
}

export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly cfg: BucketConfig,
    private readonly now: () => number = Date.now,
  ) {}

  private current(key: string): { tokens: number; at: number } {
    const t = this.now();
    const b = this.buckets.get(key);
    if (!b) return { tokens: this.cfg.capacity, at: t };
    const tokens = Math.min(this.cfg.capacity, b.tokens + ((t - b.at) / 1000) * this.cfg.refillPerSecond);
    return { tokens, at: t };
  }

  /** True when a token was available (and spent). */
  take(key: string): boolean {
    const b = this.current(key);
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    if (!this.buckets.has(key) && this.buckets.size >= this.cfg.maxKeys) {
      // Bounded memory: drop the oldest entry (insertion order).
      const first = this.buckets.keys().next().value;
      if (first !== undefined) this.buckets.delete(first);
    }
    this.buckets.set(key, { tokens: b.tokens - 1, at: b.at });
    return true;
  }

  /** Give back one token taken by `take` (a reservation that turned out not to be a failure); never above capacity. */
  refund(key: string): void {
    const b = this.buckets.get(key);
    if (!b) return;
    const cur = this.current(key);
    this.buckets.set(key, { tokens: Math.min(this.cfg.capacity, cur.tokens + 1), at: cur.at });
  }

  /** Spend without consuming when empty; returns whether the key still has budget. */
  has(key: string): boolean {
    return this.current(key).tokens >= 1;
  }

  retryAfterSeconds(): number {
    return Math.max(1, Math.ceil(1 / this.cfg.refillPerSecond));
  }
}

/**
 * The single Content-Security-Policy: same-origin scripts and styles only (no inline script, no eval), API calls to
 * self plus the configured OIDC token endpoint, no plugins, no framing, no base-tag or form hijack.
 */
export function contentSecurityPolicy(connectOrigins: readonly string[]): string {
  const connect = ["'self'", ...new Set(connectOrigins)].join(' ');
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

export function securityHeaders(csp: string): Record<string, string> {
  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin-allow-popups',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
  };
}
