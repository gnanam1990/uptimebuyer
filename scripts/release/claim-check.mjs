#!/usr/bin/env node
// T-059 claim, link and secret checks for the release drafts (M14; INV-12, NFR-12, EVENT-NOTES pre-submission
// revalidation). Offline and read-only. It fails when:
//   - a draft cites a claim id (C-NNN) the ledger (docs/release/claims.json) does not define;
//   - a draft line cites a NOT_RUN claim without a NOT_RUN/simulation qualifier on the same line;
//   - a draft line makes a real-world assertion (deployment, real payment/provider/sensor/recovery, fulfilment,
//     customers) without such a qualifier;
//   - a ledger claim contradicts docs/coverage/coverage.json (EVIDENCED while a mapped id is not PASS at its layer),
//     names an unknown id, lacks resolvable evidence, or is NOT_RUN without saying so in its text;
//   - a REAL_WORLD claim is EVIDENCED although no external evidence exists for it;
//   - a relative link does not resolve, or an external link is not https, carries userinfo or is not allow-listed
//     (config/release/link-allowlist.json; liveness of external links is not checked offline and stays NOT_RUN);
//   - a draft carries a secret or personal data (secret-scan patterns plus JWTs, bearer tokens, credentialed database
//     URLs, e-mail addresses, phone numbers, wallet addresses).
//   node scripts/release/claim-check.mjs [--json] [--probe-unqualified]
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATTERNS } from '../secret-scan.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Only explicit evidence-status words qualify a real-world assertion (M14 security review R1): generic negations such as
// "without", "never" or "is not" can be part of the assertion itself ("completed without errors").
const QUALIFIER =
  /NOT_RUN|\bnot run\b|\bnot yet\b|simulat|recorded[- ]contract|contract[- ]fake|RECORDED_CONTRACT|CONTRACT_FAKE|\bUNSUPPORTED\b|needs? (?:its own )?explicit authori[sz]ation/i;
const ASSERTIONS = [
  /\bdeployed\b/i,
  /\bin production\b/i,
  /\bproduction[- ]ready\b/i,
  /\blive (?:demo|deployment|site|environment)\b/i,
  /\breal (?:kite|payment|provider|sensor|cmms|openserv|serv reasoning|technician|refrigerat\w*|recovery|document|money|purchase|customer|pilot|run)\b/i,
  /\b(?:paid|purchased|bought|charged)\b.{0,40}\b(?:provider|part|technician|kite|service|merchant)\b/i,
  /\bphysically recovered\b/i,
  /\bfulfil(?:l)?ed\b/i,
  /\bverified on (?:real|physical)\b/i,
  /\b(?:customers?|pilots?) (?:use|uses|using|run|runs)\b/i,
];
const CLAIM_ID = /\bC-\d{3}\b/g;
const LAYERS = ['SPECIFICATION', 'LOCAL_TEST', 'LOCAL_COMPOSE', 'REAL_WORLD'];
const STATUSES = ['EVIDENCED', 'NOT_RUN', 'UNSUPPORTED', 'UNKNOWN'];

// Diagrams and command blocks are not prose; every other fenced block (for example the X post text) is checked.
const stripCode = (text) => text.replace(/```(?:mermaid|sh|bash|json)\n[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '));

export function checkDraftText(file, text, { ledger }) {
  const findings = [];
  const claims = new Map((ledger?.claims ?? []).map((c) => [c.id, c]));
  const lines = stripCode(text).split('\n');
  lines.forEach((line, i) => {
    const where = { file, line: i + 1 };
    // A qualifier must be visible: text inside an HTML comment does not qualify (M14 security review R2).
    const visible = line.replace(/<!--[\s\S]*?-->/g, '');
    const qualified = QUALIFIER.test(visible);
    for (const m of line.matchAll(CLAIM_ID)) {
      const c = claims.get(m[0]);
      if (!c) findings.push({ rule: 'CLAIM_UNDEFINED', ...where, detail: m[0] });
      else if (c.status !== 'EVIDENCED' && !qualified)
        findings.push({ rule: 'NOT_RUN_CLAIM_UNQUALIFIED', ...where, detail: m[0] });
    }
    if (!qualified && ASSERTIONS.some((re) => re.test(visible)))
      findings.push({ rule: 'UNQUALIFIED_ASSERTION', ...where, detail: visible.trim().slice(0, 120) });
  });
  return findings;
}

export function checkLedger(ledger, coverage, root) {
  const findings = [];
  const byId = new Map((coverage?.entries ?? []).map((e) => [e.id, e]));
  const seen = new Set();
  for (const c of ledger?.claims ?? []) {
    const where = { file: 'docs/release/claims.json', detail: c.id };
    if (!/^C-\d{3}$/.test(c.id ?? '') || seen.has(c.id)) findings.push({ rule: 'CLAIM_ID_INVALID', ...where });
    seen.add(c.id);
    if (!STATUSES.includes(c.status) || !LAYERS.includes(c.layer))
      findings.push({ rule: 'CLAIM_SHAPE_INVALID', ...where });
    const ids = Array.isArray(c.coverageIds) ? c.coverageIds : [];
    const entries = ids.map((id) => byId.get(id));
    if (ids.length === 0 || entries.some((e) => !e)) {
      findings.push({ rule: 'CLAIM_COVERAGE_ID_UNKNOWN', ...where });
      continue;
    }
    if (c.status === 'EVIDENCED') {
      if (c.layer === 'REAL_WORLD') {
        findings.push({ rule: 'REAL_WORLD_CLAIM_WITHOUT_EXTERNAL_EVIDENCE', ...where });
        if (entries.some((e) => e.status !== 'PASS' || e.externalEvidence === 'NOT_RUN'))
          findings.push({ rule: 'CLAIM_CONTRADICTS_COVERAGE', ...where });
        continue;
      }
      // A local-layer claim needs every mapped id PASS at the local layer (and never FAIL overall).
      const ok = entries.every((e) =>
        c.layer === 'SPECIFICATION'
          ? e.status !== 'FAIL'
          : (e.localStatus ?? e.status) === 'PASS' && e.status !== 'FAIL',
      );
      if (!ok) findings.push({ rule: 'CLAIM_CONTRADICTS_COVERAGE', ...where });
      const ev = Array.isArray(c.evidence) ? c.evidence : [];
      if (ev.length === 0 || ev.some((p) => typeof p !== 'string' || !existsSync(path.join(root, p))))
        findings.push({ rule: 'CLAIM_EVIDENCE_MISSING', ...where });
    } else if (!QUALIFIER.test(c.text ?? '') || !/NOT_RUN|UNSUPPORTED|UNKNOWN/.test(c.text ?? '')) {
      findings.push({ rule: 'NOT_RUN_CLAIM_UNQUALIFIED', ...where });
    }
  }
  return findings;
}

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(?<![(<"])\b(https?:\/\/[^\s)>"'\]]+)/g;
const SHORTENERS = new Set(['bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly']);

export function checkLinksIn(file, text, { root, allowlist }) {
  const findings = [];
  const hosts = new Map((allowlist?.hosts ?? []).map((h) => [h.host, h]));
  const body = stripCode(text);
  for (const m of body.matchAll(LINK)) {
    const target = m[1] ?? m[2];
    const where = { file, detail: target };
    if (/^(mailto:|tel:)/i.test(target)) {
      findings.push({ rule: 'LINK_NOT_ALLOWED', ...where });
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      let u;
      try {
        u = new URL(target);
      } catch {
        findings.push({ rule: 'LINK_BROKEN', ...where });
        continue;
      }
      if (u.protocol !== 'https:' || u.username || u.password) {
        findings.push({ rule: 'LINK_INSECURE', ...where });
        continue;
      }
      const entry = hosts.get(u.hostname);
      if (!entry || SHORTENERS.has(u.hostname) || (entry.pathPrefix && !u.pathname.startsWith(entry.pathPrefix)))
        findings.push({ rule: 'LINK_NOT_ALLOWED', ...where });
      continue;
    }
    if (target.startsWith('#')) continue;
    const rel = decodeURIComponent(target.split('#')[0]);
    const full = path.resolve(path.dirname(path.join(root, file)), rel);
    if (!full.startsWith(root) || !existsSync(full)) findings.push({ rule: 'LINK_BROKEN', ...where });
  }
  return findings;
}

const EXTRA_SECRETS = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];
const PERSONAL = [
  /\b[A-Za-z0-9._%+-]+@(?!example\.(?:invalid|com|org)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /(?<![\w.:])\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3}[\s.-]?\d{3,4}\b/,
  /\b0x[a-fA-F0-9]{40}\b/,
];

export function checkSecretsIn(file, text) {
  const findings = [];
  for (const { id, re } of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) findings.push({ rule: 'SECRET', file, detail: id });
    re.lastIndex = 0;
  }
  if (EXTRA_SECRETS.some((re) => re.test(text)) && !findings.length) findings.push({ rule: 'SECRET', file });
  if (PERSONAL.some((re) => re.test(text))) findings.push({ rule: 'PERSONAL_DATA', file });
  return findings;
}

export function runReleaseChecks(root = repo, overrides = {}) {
  const ledger = JSON.parse(readFileSync(path.join(root, 'docs', 'release', 'claims.json'), 'utf8'));
  const coverage = JSON.parse(readFileSync(path.join(root, 'docs', 'coverage', 'coverage.json'), 'utf8'));
  const allowlist = JSON.parse(readFileSync(path.join(root, 'config', 'release', 'link-allowlist.json'), 'utf8'));
  const findings = [...checkLedger(ledger, coverage, root)];
  for (const file of ledger.drafts) {
    const full = path.join(root, file);
    if (!existsSync(full) || !statSync(full).isFile()) {
      findings.push({ rule: 'DRAFT_MISSING', file });
      continue;
    }
    const text = overrides[file] ?? readFileSync(full, 'utf8');
    findings.push(...checkDraftText(file, text, { ledger }));
    if (/\.(md|srt)$/.test(file)) findings.push(...checkLinksIn(file, text, { root, allowlist }));
    findings.push(...checkSecretsIn(file, text));
  }
  return { drafts: ledger.drafts, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const overrides = {};
  if (args.includes('--probe-unqualified')) {
    // Self-test: the write-up with one unqualified real-world assertion appended must fail.
    const f = 'docs/release/WRITEUP.md';
    overrides[f] = `${readFileSync(path.join(repo, f), 'utf8')}\nUptimeBuyer paid a real provider through Kite.\n`;
  }
  const r = runReleaseChecks(repo, overrides);
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  for (const f of r.findings)
    console.log(`FINDING ${f.rule} ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.detail ?? ''}`);
  console.log(JSON.stringify({ drafts: r.drafts.length, findings: r.findings.length }));
  process.exitCode = r.findings.length ? 1 : 0;
}
