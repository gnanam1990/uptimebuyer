// f0-kite-broker: the only spike process holding the synthetic "Kite" credential (an mTLS client key plus a
// bearer capability) and the paid-destination allowlist. The credential arrives on fd 3 from the launcher and
// lives only in this process's memory; it is never in env, argv, files or logs. Ingress is a 0600 unix socket
// accepting only signed, credential-free intent envelopes. Launch with --disable-sigusr1 (inspector bypass).
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { createPublicKey } from 'node:crypto';
import { digestOf, sha256 } from '../lib/canonical.mjs';
import { evaluateIntent } from '../lib/envelope.mjs';
import { STATES, applyLookup, classifyExecute, decideOnSubmit, deriveStates, recoverOnBoot } from '../lib/journal.mjs';

const cfg = JSON.parse(readFileSync(3, 'utf8'));
closeSync(3);
const secret = { key: cfg.clientKey, cert: cfg.clientCert, capability: cfg.capability };
delete cfg.clientKey;
delete cfg.capability;
const clientPublicKey = createPublicKey(cfg.clientPublicKey);
const journalPath = path.join(cfg.stateDir, 'journal.jsonl');
const log = (msg) => process.stderr.write(`[f0-kite-broker] ${msg}\n`);

function append(event) {
  const fd = openSync(journalPath, 'a', 0o600);
  try {
    appendFileSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
const readJournal = () =>
  existsSync(journalPath)
    ? readFileSync(journalPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const states = () => deriveStates(readJournal());

for (const s of recoverOnBoot(states())) {
  append({
    event: 'RECOVERED',
    intentId: s.intentId,
    idempotencyKey: s.idempotencyKey,
    state: STATES.UNKNOWN,
    reason: 'SEND_STARTED_WITHOUT_OUTCOME',
  });
  log(`boot recovery: ${s.idempotencyKey} -> UNKNOWN`);
}

// Pinned, allowlisted destination only. No redirects are followed; proxy env vars are not consulted.
function paidCall(dest, method, pathName, headers, body, { onWritten } = {}) {
  return new Promise((resolve) => {
    const url = new URL(dest.origin);
    const req = https.request(
      {
        host: url.hostname,
        port: url.port,
        path: pathName,
        method,
        key: secret.key,
        cert: secret.cert,
        ca: [cfg.caCert],
        agent: false,
        timeout: 2000,
        headers: { authorization: `Bearer ${secret.capability}`, ...headers },
        checkServerIdentity: (_host, peer) =>
          peer.fingerprint256 === dest.serverFingerprint256 ? undefined : new Error('SERVER_PIN_MISMATCH'),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = null;
          }
          resolve({ kind: 'response', status: res.statusCode, body: parsed, responseDigest: sha256(raw) });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', (e) =>
      resolve({ kind: 'transport', error: e.message === 'TIMEOUT' ? 'TIMEOUT' : 'TRANSPORT_ERROR' }),
    );
    req.end(body, () => onWritten?.());
  });
}

let capability = null;
async function preflight() {
  const dest = cfg.allowlist['local-standin-paid'];
  const r = await paidCall(dest, 'GET', '/v1/capabilities', {}, undefined);
  capability = r.kind === 'response' && r.status === 200 ? r.body : null;
  return capability?.lookupByIdempotencyKey === true ? 'ELIGIBLE' : 'UNSUPPORTED';
}

async function submit(message) {
  const verdict = evaluateIntent({
    message,
    publicKey: clientPublicKey,
    approvals: cfg.approvals,
    allowlist: cfg.allowlist,
    nowMs: Date.now(),
  });
  if (!verdict.ok) {
    append({ event: 'REJECTED', intentId: String(message?.envelope?.intentId ?? ''), code: verdict.code });
    return { status: 403, body: { state: 'REJECTED', code: verdict.code } };
  }
  if (capability?.lookupByIdempotencyKey !== true)
    return { status: 409, body: { state: 'REJECTED', code: 'ADAPTER_UNSUPPORTED' } };
  const env = verdict.envelope;
  const body = {
    intentId: env.intentId,
    incidentId: env.incidentId,
    purpose: env.purpose,
    providerId: env.providerId,
    amountMinor: env.amountMinor,
    currency: env.currency,
    idempotencyKey: env.idempotencyKey,
  };
  const requestDigest = digestOf(body);
  const entry = states().get(env.idempotencyKey);
  const decision = decideOnSubmit(entry, requestDigest);
  if (decision === 'IDEMPOTENCY_CONFLICT') return { status: 409, body: { state: 'REJECTED', code: decision } };
  if (decision !== 'EGRESS') {
    return { status: 200, body: { state: entry.state, effectId: entry.effectId, egress: false, decision } };
  }
  append({ event: 'SEND_STARTED', intentId: env.intentId, idempotencyKey: env.idempotencyKey, requestDigest });
  const crash = cfg.faults.crashAfterSendKeys.includes(env.idempotencyKey);
  const r = await paidCall(
    verdict.destination,
    'POST',
    '/v1/execute',
    { 'content-type': 'application/json', 'idempotency-key': env.idempotencyKey },
    JSON.stringify(body),
    { onWritten: crash ? () => setTimeout(() => process.exit(137), 300) : undefined },
  );
  const outcome = classifyExecute(r);
  append({
    event: 'OUTCOME',
    intentId: env.intentId,
    idempotencyKey: env.idempotencyKey,
    ...outcome,
    responseDigest: r.responseDigest ?? null,
    replayed: r.body?.replayed ?? null,
  });
  return { status: 200, body: { ...outcome, egress: true, replayed: r.body?.replayed ?? null } };
}

async function reconcile(message) {
  const verdict = evaluateIntent({
    message,
    publicKey: clientPublicKey,
    approvals: cfg.approvals,
    allowlist: cfg.allowlist,
    nowMs: Date.now(),
  });
  if (!verdict.ok) return { status: 403, body: { state: 'REJECTED', code: verdict.code } };
  const entry = states().get(verdict.envelope.idempotencyKey);
  if (!entry) return { status: 404, body: { code: 'NO_ATTEMPT' } };
  if (entry.state !== STATES.UNKNOWN)
    return { status: 200, body: { state: entry.state, effectId: entry.effectId, lookup: false } };
  // Reconciliation is lookup-only: the broker never re-executes to obtain certainty.
  const r = await paidCall(
    verdict.destination,
    'GET',
    `/v1/lookup?idempotencyKey=${encodeURIComponent(entry.idempotencyKey)}`,
    {},
    undefined,
  );
  const next = applyLookup(entry, r);
  append({ event: 'RECONCILED', intentId: entry.intentId, idempotencyKey: entry.idempotencyKey, ...next });
  return { status: 200, body: { ...next, lookup: true } };
}

const server = http.createServer((req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!req.url.startsWith('/')) return reply(400, { code: 'ABSOLUTE_FORM_REJECTED_NOT_A_PROXY' });
  const route =
    req.method === 'POST' && req.url === '/v1/intents'
      ? submit
      : req.method === 'POST' && req.url === '/v1/reconcile'
        ? reconcile
        : null;
  if (!route) return reply(404, { code: 'NO_ROUTE' });
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 16384) req.destroy();
    else chunks.push(c);
  });
  req.on('end', async () => {
    let message;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return reply(400, { code: 'BAD_JSON' });
    }
    const out = await route(message);
    reply(out.status, out.body);
  });
  return undefined;
});
server.on('connect', (_req, socket) => {
  socket.end('HTTP/1.1 405 Method Not Allowed\r\nconnection: close\r\n\r\n');
});

const sock = path.join(cfg.ingressDir, 'broker.sock');
const eligibility = await preflight();
rmSync(sock, { force: true });
server.listen(sock, () => {
  chmodSync(sock, 0o600);
  log(`listening; adapter ${eligibility}`);
  process.send({ type: 'ready', socket: sock, adapter: eligibility, capability });
});
process.on('message', (m) => {
  if (m.type === 'stop') server.close(() => process.exit(0));
});
