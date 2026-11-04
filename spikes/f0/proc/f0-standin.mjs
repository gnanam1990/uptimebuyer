// LOCAL_STAND_IN: a local HTTPS server standing in for a paid endpoint. Not Kite, not a real provider, no money.
// Every request must present the broker's client certificate (mTLS, pinned fingerprint) AND the bearer
// capability whose SHA-256 this process holds (it never holds the capability value itself).
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { digestOf, sha256 } from '../lib/canonical.mjs';
import { createLedger } from '../lib/ledger.mjs';

const cfg = JSON.parse(readFileSync(3, 'utf8'));
const ledger = createLedger();
const faults = {
  drop: new Set(cfg.faults.dropResponseKeys),
  hold: new Set(cfg.faults.holdResponseKeys),
  lookupDown: new Set(cfg.faults.lookupUnavailableKeys),
};
const counters = {
  tlsClientErrors: 0,
  wrongClientCert: 0,
  badCapability: 0,
  authorizedRequests: 0,
  executeRequests: 0,
  lookupRequests: 0,
};
const expectedCap = Buffer.from(cfg.capabilitySha256, 'hex');

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'x-f0-label': 'LOCAL_STAND_IN' });
  res.end(JSON.stringify({ label: 'LOCAL_STAND_IN', ...body }));
}

function authorized(req) {
  const peer = req.socket.getPeerCertificate();
  if (!req.socket.authorized || !peer || peer.fingerprint256 !== cfg.brokerClientFingerprint256) {
    counters.wrongClientCert += 1;
    return false;
  }
  const auth = req.headers.authorization ?? '';
  const got = Buffer.from(sha256(auth.startsWith('Bearer ') ? auth.slice(7) : ''), 'hex');
  if (got.length !== expectedCap.length || !timingSafeEqual(got, expectedCap)) {
    counters.badCapability += 1;
    return false;
  }
  counters.authorizedRequests += 1;
  return true;
}

const server = https.createServer(
  { key: cfg.serverKey, cert: cfg.serverCert, ca: [cfg.caCert], requestCert: true, rejectUnauthorized: true },
  (req, res) => {
    if (!authorized(req)) return send(res, 401, { code: 'UNAUTHORIZED' });
    const url = new URL(req.url, 'https://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
      return send(res, 200, { lookupByIdempotencyKey: true, sameKeyIdempotentExecute: true, refunds: false });
    }
    if (req.method === 'GET' && url.pathname === '/v1/lookup') {
      counters.lookupRequests += 1;
      const key = url.searchParams.get('idempotencyKey') ?? '';
      if (faults.lookupDown.has(key)) return send(res, 503, { code: 'LOOKUP_UNAVAILABLE_INJECTED' });
      const r = ledger.lookup(key);
      return send(res, r.status, r);
    }
    if (req.method === 'POST' && url.pathname === '/v1/execute') {
      counters.executeRequests += 1;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(res, 400, { code: 'BAD_JSON' });
        }
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || key !== body.idempotencyKey)
          return send(res, 400, { code: 'IDEMPOTENCY_KEY_REQUIRED' });
        const r = ledger.execute(key, digestOf(body), body);
        // Fault injection happens after the effect is committed: the provider has the effect, the caller loses the answer.
        if (faults.drop.has(key)) return req.socket.destroy();
        if (faults.hold.has(key)) return setTimeout(() => send(res, r.status, r), 5000).unref();
        return send(res, r.status, r);
      });
      return undefined;
    }
    return send(res, 404, { code: 'NO_ROUTE' });
  },
);
server.on('tlsClientError', () => {
  counters.tlsClientErrors += 1;
});
server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port }));
process.on('message', (m) => {
  if (m.type === 'snapshot') process.send({ type: 'snapshot', ledger: ledger.snapshot(), counters: { ...counters } });
  if (m.type === 'stop') server.close(() => process.exit(0));
});
