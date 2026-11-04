// LOCAL_STAND_IN paid endpoint (a separate test process). It is NOT Kite and NOT a provider: an HTTPS server on
// 127.0.0.1 that accepts only the pinned broker client certificate AND a bearer capability whose SHA-256 it holds. It
// supports authoritative lookup by idempotency key (fencing unknown keys), provider-enforced same-key replay,
// accept-only, decline, dropped responses, delays and refunds/reversals, so the broker's reconciliation can be probed.
// Its key material arrives on fd 3; control commands arrive as JSON lines on stdin; it reports on stdout.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import readline from 'node:readline';

const cfg = JSON.parse(readFileSync(3, 'utf8'));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const state = {
  mode: 'SETTLE',
  delayMs: 0,
  lookupSupported: true,
  sessionMode: 'ACTIVE',
  executeCalls: 0,
  effectsCreated: 0,
  authorized: 0,
  rejected: 0,
  payments: new Map(),
  sessions: new Map(),
  fenced: new Set(),
};
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

function authorized(req) {
  const peer = req.socket.getPeerCertificate();
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  return Boolean(peer && peer.fingerprint256 === cfg.clientFingerprint256 && sha(bearer) === cfg.capabilityHash);
}

function reply(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const paymentBody = (p) =>
  p.status === 'settled'
    ? { status: 'settled', paymentRef: p.ref, amountMinor: p.amountMinor, returns: p.returns }
    : { status: 'accepted', paymentRef: p.ref };

const server = https.createServer(
  { key: cfg.serverKey, cert: cfg.serverCert, ca: cfg.caCert, requestCert: true, rejectUnauthorized: true },
  (req, res) => {
    if (!authorized(req)) {
      state.rejected++;
      return reply(res, 401, { status: 'unauthorized' });
    }
    state.authorized++;
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      const key = String(req.headers['idempotency-key'] ?? '');
      const url = new URL(req.url, 'https://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/v1/sessions') {
        if (state.sessionMode === 'DECLINE') return reply(res, 409, { status: 'declined' });
        const s = state.sessions.get(key) ?? { ref: `sis_${randomUUID().slice(0, 12)}` };
        state.sessions.set(key, s);
        return reply(res, 200, { status: 'active', sessionRef: s.ref });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/v1/sessions/by-key/')) {
        const k = decodeURIComponent(url.pathname.slice('/v1/sessions/by-key/'.length));
        const s = state.sessions.get(k);
        return s
          ? reply(res, 200, { status: 'active', sessionRef: s.ref })
          : reply(res, 404, { status: 'not_found_fenced' });
      }
      if (req.method === 'POST' && url.pathname === '/v1/payments') {
        state.executeCalls++;
        if (state.fenced.has(key)) return reply(res, 409, { status: 'key_fenced' });
        const existing = state.payments.get(key);
        if (existing)
          return reply(res, existing.status === 'settled' ? 200 : 202, { ...paymentBody(existing), replayed: true });
        if (state.mode === 'DECLINE') return reply(res, 402, { status: 'declined' });
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const p = {
          ref: `sfx_${randomUUID().slice(0, 16)}`,
          amountMinor: String(body.amountMinor),
          status: state.mode === 'ACCEPT_ONLY' ? 'accepted' : 'settled',
          returns: [],
        };
        state.payments.set(key, p);
        state.effectsCreated++;
        if (state.mode === 'DROP_RESPONSE') return req.socket.destroy();
        if (state.mode === 'DELAY') await new Promise((r) => setTimeout(r, state.delayMs));
        return reply(res, p.status === 'settled' ? 200 : 202, paymentBody(p));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/v1/payments/by-key/')) {
        if (!state.lookupSupported) return reply(res, 501, { status: 'lookup_unsupported' });
        const k = decodeURIComponent(url.pathname.slice('/v1/payments/by-key/'.length));
        const p = state.payments.get(k);
        if (!p) {
          state.fenced.add(k);
          return reply(res, 404, { status: 'not_found_fenced' });
        }
        return reply(res, p.status === 'settled' ? 200 : 202, paymentBody(p));
      }
      return reply(res, 404, { status: 'no_route' });
    });
  },
);
server.on('tlsClientError', () => state.rejected++);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const c = JSON.parse(line);
  if (c.cmd === 'mode') Object.assign(state, { mode: c.mode, delayMs: c.delayMs ?? 0 });
  if (c.cmd === 'lookup') state.lookupSupported = c.supported;
  if (c.cmd === 'settle') for (const p of state.payments.values()) p.status = 'settled';
  if (c.cmd === 'refund') {
    const p = state.payments.get(c.key);
    if (p) p.returns.push({ id: c.id, kind: c.kind, amountMinor: String(c.amountMinor) });
  }
  out({
    event: 'stats',
    seq: c.seq,
    executeCalls: state.executeCalls,
    effectsCreated: state.effectsCreated,
    authorized: state.authorized,
    rejected: state.rejected,
    sessions: state.sessions.size,
  });
});

server.listen(0, '127.0.0.1', () => out({ event: 'listening', port: server.address().port }));
