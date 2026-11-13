#!/usr/bin/env node
// T-060 authorization tooling for the PERSON who authorizes an external action (never run by an agent). Offline: no
// network, no process spawning. It keeps one Ed25519 key in a private directory OUTSIDE the repository (0700 directory,
// 0600 key), prints only the public key (DER SPKI, base64url) and its key id for config/release/authorizers.json, builds
// a PAYMENT authorization record from explicit arguments, shows it in plain words and signs it with the release gate's
// own signAuthorization only after the person types YES. The signed record is written under evidence/authorizations/.
//   node scripts/release/authorize.mjs keygen [--key-dir <dir>]
//   node scripts/release/authorize.mjs payment --merchant <host> --amount-minor <n> --currency <ISO> \
//     --purpose <CODE> --environment <env> --valid-hours <h> [--authorized-by <name>] [--key-dir <dir>] [--out <dir>]
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadGateConfig, signAuthorization } from './release-gate.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_KEY_DIR = path.join(homedir(), '.config', 'uptimebuyer', 'authorizer');
const KEY_FILE = 'authorizer-ed25519.pem';
/** The most this repository's Kite wiring can pay per session (the broker adapter's KITE_HARD_CAPS), in minor units. */
const MAX_PAYMENT_MINOR = 5;

const lexicallyInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
/** The real path of `p`, resolved through its nearest existing ancestor (the rest may not exist yet). */
function realpathOfNearest(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.unshift(path.basename(cur));
    cur = up;
  }
  return path.join(realpathSync(cur), ...rest);
}
/** True when `child` is inside `parent`, compared by real path so a symlink into the repository cannot hide it. */
const inside = (child, parent) =>
  lexicallyInside(path.resolve(child), path.resolve(parent)) ||
  lexicallyInside(realpathOfNearest(child), realpathSync(parent));

function ownedPrivate(p, kind) {
  const st = lstatSync(p);
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) throw new Error(`${p} is not a regular ${kind}`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${p} is not owned by you`);
  const want = kind === 'dir' ? 0o700 : 0o600;
  if ((st.mode & 0o777) !== want)
    throw new Error(`${p} must be mode ${want.toString(8).padStart(4, '0')} (it is ${(st.mode & 0o777).toString(8)})`);
}

function describeKey(privateKey) {
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return {
    keyId: `owner-${createHash('sha256').update(der).digest('hex').slice(0, 16)}`,
    publicKey: Buffer.from(der).toString('base64url'),
  };
}

/** Create the key once (0700 dir, 0600 PKCS#8 PEM) or reuse it; returns the public key and key id only. */
export function ensureKey(dir = DEFAULT_KEY_DIR, { repoRoot = repo } = {}) {
  if (inside(dir, repoRoot)) throw new Error('the authorizer key directory must be outside the repository');
  const file = path.join(dir, KEY_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  ownedPrivate(dir, 'dir');
  if (existsSync(file)) {
    ownedPrivate(file, 'file');
    return { ...describeKey(createPrivateKey(readFileSync(file, 'utf8'))), created: false };
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
  return { ...describeKey(privateKey), created: true };
}

function loadPrivateKey(dir) {
  const file = path.join(dir, KEY_FILE);
  ownedPrivate(dir, 'dir');
  ownedPrivate(file, 'file');
  return createPrivateKey(readFileSync(file, 'utf8'));
}

const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const minorText = (n, currency) => `${currency} ${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;

/** A PAYMENT authorization record from explicit arguments (unsigned). Throws on anything outside the rules. */
export function buildPaymentAuthorization(a, now = new Date()) {
  const merchant = String(a.merchant ?? '');
  if (!HOST.test(merchant)) throw new Error('merchant must be a lower-case host name such as lionx402.com');
  if (!Number.isSafeInteger(a.amountMinor) || a.amountMinor < 1 || a.amountMinor > MAX_PAYMENT_MINOR)
    throw new Error(`amount-minor must be a whole number from 1 to ${MAX_PAYMENT_MINOR}`);
  if (!/^[A-Z]{3}$/.test(String(a.currency ?? ''))) throw new Error('currency must be an ISO code such as USD');
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(String(a.purpose ?? '')))
    throw new Error('purpose must be the product purpose code, e.g. REFRIGERATION_REPAIR_TECHNICIAN_LOOKUP');
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(String(a.environment ?? '')))
    throw new Error('environment must be a short lower-case name such as kite-passport-prod');
  const maxHours = loadGateConfig(repo).gates.PAYMENT.maxValidityHours ?? 4;
  if (typeof a.validHours !== 'number' || !(a.validHours > 0) || a.validHours > maxHours)
    throw new Error(`valid-hours must be more than 0 and at most ${maxHours}`);
  const authorizedBy = String(a.authorizedBy ?? 'repository-owner');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(authorizedBy)) throw new Error('authorized-by must be a short lower-case name');
  const authorizedAt = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();
  const expiresAt = new Date(Date.parse(authorizedAt) + Math.round(a.validHours * 3_600_000)).toISOString();
  const day = authorizedAt.slice(0, 10).replace(/-/g, '');
  const scope = {
    merchant,
    amountMinor: a.amountMinor,
    currency: a.currency,
    purpose: a.purpose,
    environment: a.environment,
  };
  return {
    schema: 'release-authorization.v1',
    gate: 'PAYMENT',
    authorizationId: `auth-payment-${day}-${randomBytes(3).toString('hex')}`,
    authorizedBy,
    authorizedAt,
    expiresAt,
    statement:
      `I authorize exactly one payment through the UptimeBuyer Kite broker of at most ${scope.amountMinor} minor ` +
      `unit(s) of ${scope.currency} (${minorText(scope.amountMinor, scope.currency)}) to ${merchant} for ` +
      `${scope.purpose} in ${scope.environment}, valid from ${authorizedAt} until ${expiresAt}, usable only once.`,
    scope,
  };
}

/** The record in plain words, for the person to read before typing YES. */
export function describeAuthorization(r) {
  const s = r.scope;
  return [
    'You are about to sign ONE payment authorization. It can be used only once.',
    `  Pays:          at most ${s.amountMinor} minor unit${s.amountMinor === 1 ? '' : 's'} of ${s.currency} (${minorText(s.amountMinor, s.currency)})`,
    `  To merchant:   ${s.merchant}`,
    `  Purpose:       ${s.purpose}`,
    `  Environment:   ${s.environment}`,
    `  Valid from:    ${r.authorizedAt}`,
    `  Valid until:   ${r.expiresAt}`,
    `  Authorized by: ${r.authorizedBy}`,
    `  Record id:     ${r.authorizationId}`,
    'The release gate opens for this record only if the requested payment matches this scope exactly (the amount may be',
    'lower) and every PAYMENT preflight check passes. It does not move money by itself.',
  ].join('\n');
}

/** Only the exact answer YES (optionally followed by a newline) confirms. */
export function confirmed(answer) {
  return typeof answer === 'string' && answer.replace(/\r?\n$/, '') === 'YES';
}

/** Sign with the key in `dir` (which must already exist and be private). */
export function signRecord(record, dir = DEFAULT_KEY_DIR) {
  const privateKey = loadPrivateKey(dir);
  return signAuthorization(record, privateKey, describeKey(privateKey).keyId);
}

export function writeRecord(signed, outDir = path.join(repo, 'evidence', 'authorizations')) {
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${signed.gate}.${signed.authorizationId}.json`);
  writeFileSync(file, `${JSON.stringify(signed, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  return file;
}

async function readLine(prompt) {
  process.stdout.write(prompt);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return '';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const val = (k) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : undefined);
  const keyDir = path.resolve(val('--key-dir') ?? DEFAULT_KEY_DIR);
  try {
    if (cmd === 'keygen') {
      const k = ensureKey(keyDir);
      console.log(`${k.created ? 'Created' : 'Using existing'} authorizer key in ${keyDir}`);
      console.log(`keyId: ${k.keyId}`);
      console.log(`publicKey: ${k.publicKey}`);
      console.log(
        'Add this line to config/release/authorizers.json under "authorizers" (a reviewed, committed change):',
      );
      console.log(`  "${k.keyId}": "${k.publicKey}"`);
    } else if (cmd === 'payment') {
      const record = buildPaymentAuthorization({
        merchant: val('--merchant'),
        amountMinor: Number(val('--amount-minor')),
        currency: val('--currency'),
        purpose: val('--purpose'),
        environment: val('--environment'),
        validHours: Number(val('--valid-hours')),
        authorizedBy: val('--authorized-by') ?? 'repository-owner',
      });
      const k = ensureKey(keyDir);
      console.log(describeAuthorization(record));
      console.log(`  Signing key:   ${k.keyId}`);
      const answer = await readLine('Type YES to sign this authorization (anything else cancels): ');
      if (!confirmed(answer)) {
        console.log('\nNot signed. Nothing was written.');
        process.exitCode = 3;
      } else {
        const file = writeRecord(signRecord(record, keyDir), val('--out') ? path.resolve(val('--out')) : undefined);
        console.log(`\nSigned and written: ${file}`);
        console.log(`authorizationId: ${record.authorizationId}`);
      }
    } else {
      console.error(
        'usage: authorize.mjs keygen [--key-dir d] | payment --merchant h --amount-minor n --currency C ...',
      );
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`refused: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  }
}
