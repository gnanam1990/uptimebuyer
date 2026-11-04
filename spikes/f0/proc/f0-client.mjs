// f0-client: creates credential-free signed intent envelopes. Its Ed25519 signing key (not a Kite credential)
// arrives on fd 3. Tamper modes mutate a field after signing, or re-sign a mutated field (compromised client).
import { createPrivateKey, randomBytes } from 'node:crypto';
import { closeSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { signEnvelope } from '../lib/envelope.mjs';
import { runProbes } from '../lib/probes.mjs';
import { serveRole } from '../lib/role.mjs';

const signingKey = createPrivateKey(JSON.parse(readFileSync(3, 'utf8')).signingKey);
closeSync(3);

function post(pathName, message) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: process.env.F0_BROKER_SOCK,
        path: pathName,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        timeout: 15000,
      },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString('utf8')) }));
      },
    );
    req.on('error', (e) => resolve({ status: null, error: e.code ?? e.message }));
    req.end(JSON.stringify(message));
  });
}

function build({ fields, mutate, resign }) {
  let envelope = { v: 1, ...fields, nonce: randomBytes(8).toString('hex') };
  if (mutate && resign) envelope = { ...envelope, [mutate.field]: mutate.value };
  const sig = signEnvelope(envelope, signingKey);
  if (mutate && !resign) envelope = { ...envelope, [mutate.field]: mutate.value };
  return { envelope, sig };
}

serveRole('f0-client', {
  async submit(args) {
    const message = build(args);
    return { message, ...(await post('/v1/intents', message)) };
  },
  async reconcile(args) {
    return post('/v1/reconcile', build(args));
  },
  probes: (args) => runProbes(args),
  exit: () => 'bye',
});
