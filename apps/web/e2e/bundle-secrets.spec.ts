// Secret-material scan of the BUILT operator bundle (FR-19 security, SECURITY.md, M12 security review): no private
// key, token, credential reference, signing material, database URL or forbidden environment-variable name may ship in
// apps/web/dist, and the HTML loads no inline script (the CSP forbids it). Runs after the production build.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const dist = resolve(import.meta.dirname, '..', 'dist');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const FORBIDDEN: [string, RegExp][] = [
  ['PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['secret reference', /secretref:/],
  ['database URL', /postgres(?:ql)?:\/\//],
  ['AWS key id', /AKIA[0-9A-Z]{16}/],
  [
    'generic api key assignment',
    /(?:api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_\-.]{16,}["']/i,
  ],
  ['private JWK member', /"d"\s*:\s*"[A-Za-z0-9_-]{20,}"/],
  ['Kite credential names', /KITE_[A-Z_]*(?:KEY|SECRET|TOKEN)|kpass|PASSPORT_/],
  [
    'forbidden env names',
    /\b(?:DATABASE_URL|UB_OIDC_[A-Z_]+|RECOVERY_SIGNING_KEY|COMPATIBILITY_SIGNING|UB_CMMS_TOKEN|SERV_API_KEY|OPENSERV_API_KEY|VITE_[A-Z_]+)\b/,
  ],
  ['process.env access', /process\.env/],
];

test('the production web bundle contains no secret-like material or forbidden env names', () => {
  const all = files(dist);
  expect(all.some((f) => f.endsWith('.js'))).toBe(true);
  for (const f of all) {
    if (!/\.(js|css|html|json|map|txt|svg)$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    for (const [name, re] of FORBIDDEN) expect(re.test(text), `${name} in ${f}`).toBe(false);
  }
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(all.some((f) => f.endsWith('.map'))).toBe(false);
});
