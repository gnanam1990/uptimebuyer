// M12 security review regression guards over the web source (XSS, storage, telemetry/analytics leakage): no raw-HTML
// sinks (provider- or model-supplied text is always rendered as text), no browser storage or cookies (the access
// token and PKCE material live in memory only), no eval-like code (the CSP forbids it), no beacons or console output
// that could carry data off the page, and no environment access in client code.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(import.meta.dirname, '..', 'src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const FORBIDDEN: [string, RegExp][] = [
  ['raw HTML sink', /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/],
  ['eval-like code', /\beval\s*\(|new Function\s*\(|setTimeout\(\s*['"`]/],
  ['browser storage', /localStorage|sessionStorage|indexedDB|document\.cookie|caches\./],
  ['data egress', /sendBeacon|navigator\.(?:clipboard|share)|new Image\(|XMLHttpRequest/],
  ['console output', /\bconsole\.(?:log|info|warn|error|debug|trace)\b/],
  ['environment access', /process\.env|import\.meta\.env/],
  ['inline style injection', /createElement\(\s*['"]style['"]\s*\)|\.setAttribute\(\s*['"]style['"]/],
];

describe('M12 web source security guards', () => {
  it('uses no raw-HTML sinks, storage, eval, beacons, console output or env access', () => {
    const offenders: string[] = [];
    for (const f of files(src)) {
      const text = code(readFileSync(f, 'utf8'));
      for (const [name, re] of FORBIDDEN) if (re.test(text)) offenders.push(`${name}: ${relative(src, f)}`);
    }
    expect(offenders).toEqual([]);
  });

  it('fetches only through the typed client and the OIDC token endpoint', () => {
    const fetchers = files(src).filter((f) => /\bfetch\s*\(/.test(code(readFileSync(f, 'utf8'))));
    expect(fetchers.map((f) => relative(src, f)).sort()).toEqual(['auth.ts']);
  });
});
