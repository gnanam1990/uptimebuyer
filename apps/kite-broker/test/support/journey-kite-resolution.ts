// T-058 manual resolution runner (CLI) for a live Kite payment the journey recorded as UNKNOWN. The work is
// test/support/kite-payment-resolution.ts. Run by the operator after the finance approver (the owner) decided the
// outcome from read-only evidence. It refuses a dirty tracked tree (the record's sourceSha is the code that ran it),
// makes no kpass call, no merchant call and never re-sends; the database is dropped only after every export.
//   DATABASE_URL=postgres://... node --experimental-transform-types --no-warnings \
//     --import ./packages/domain/test/support/ts-register.mjs \
//     apps/kite-broker/test/support/journey-kite-resolution.ts --journey-id <id> --database <kept database> \
//     --intent <cin_...> --facts <facts.json> --reason-code <CODE> [--captured-minor 1]
// facts.json: { "facts": ReconciliationFacts, "ownerDecision": { decidedBy, role, decidedOn, statement, relayedBy } }
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveKitePayment, type ReconciliationFacts, type ResolutionOptions } from './kite-payment-resolution.js';

const repo = path.resolve(import.meta.dirname, '..', '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jg = (await import(path.join(repo, 'scripts', 'release', 'journey-gate.mjs'))) as any;
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const die = (m: string): never => {
  console.error(`resolution refused: ${m}`);
  process.exit(2);
};

/** Values the redaction check must never find (compared only, never printed). */
function kpassSecrets(): { name: string; value: string }[] {
  const root = path.join(homedir(), '.config', 'uptimebuyer', 'kite-broker', '.kite-passport');
  const read = (f: string) => {
    try {
      return JSON.parse(readFileSync(path.join(root, f), 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const cfg = read('config.json');
  const agent = read('agent.json');
  const out: { name: string; value: string }[] = [];
  for (const [name, v] of [
    ['KPASS_JWT', cfg.jwt],
    ['KPASS_AGENT_TOKEN', agent.agent_token],
    ['KPASS_ACCOUNT_EMAIL', cfg.email],
    ['KPASS_USER_ID', cfg.user_id],
  ] as const)
    if (typeof v === 'string') out.push({ name, value: v });
  return out;
}

const runGateCli: NonNullable<ResolutionOptions['runGateCli']> = (a) => {
  const r = spawnSync(
    process.execPath,
    [
      'scripts/release/journey-gate.mjs',
      '--manifest',
      a.manifestRel,
      '--json',
      ...(a.database ? ['--database', '--tenant', a.database.tenantId, '--incident', a.database.incidentId] : []),
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...(a.database ? { JOURNEY_DATABASE_URL: a.database.url } : {}) },
    },
  );
  return { code: r.status, report: JSON.parse(r.stdout) };
};

const journeyId = arg('--journey-id') ?? die('--journey-id is required');
const databaseName = arg('--database') ?? die('--database is required');
if (!/^ub_[a-z0-9_]{1,60}$/.test(databaseName)) die('--database must be a throwaway ub_ database');
const intentId = arg('--intent') ?? die('--intent is required');
const reasonCode = arg('--reason-code') ?? die('--reason-code is required');
const input = JSON.parse(readFileSync(arg('--facts') ?? die('--facts is required'), 'utf8')) as {
  facts: ReconciliationFacts;
  ownerDecision: ResolutionOptions['ownerDecision'];
};
if (!process.env.DATABASE_URL) die('DATABASE_URL is not set');
const status = spawnSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
if (status.status !== 0 || status.stdout.trim() !== '') die('the tracked tree is not clean; commit the runner first');
const sourceSha = jg.headSha(repo) ?? die('cannot read HEAD');

const report = await resolveKitePayment({
  databaseName,
  journeyId,
  artifactRoot: repo,
  gateEvidenceDir: path.join(repo, 'docs', 'release', 'evidence'),
  sourceSha,
  intentId,
  capturedMinor: BigInt(arg('--captured-minor') ?? '1'),
  reasonCode,
  facts: input.facts,
  ownerDecision: input.ownerDecision,
  isAuthorized: (g, id, req, w) => jg.evidenceAuthorizer(repo)(g, id, req, w),
  secrets: kpassSecrets,
  log: (l) => console.error(`[resolution ${journeyId}] ${l}`),
  runGateCli,
});
console.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
