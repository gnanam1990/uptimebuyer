// Attacker-shaped probe process for T-039 (general worker, API, model/SERV roles). It holds NO broker secret. It tries
// to reach the LOCAL_STAND_IN paid endpoint directly (no client certificate, an attacker-minted certificate, plain
// HTTP, a guessed bearer), to read the broker's process environment, to dump every database table it can read, and
// to drive the broker socket with forged or authority-embedding references. It reports raw observations as JSON; the
// test (playing the secret manager) checks them for any secret material.
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import pg from 'pg';
import { makeLocalPki } from './pki.mjs';

const role = process.argv[2];
const env = process.env;
const report = { role, paid: {}, broker: {}, env: null, db: null };

function httpsGet(opts) {
  return new Promise((resolve) => {
    const req = https.request({
      method: 'GET',
      path: '/v1/payments/by-key/probe-key-0001',
      agent: false,
      timeout: 3000,
      ...opts,
    });
    req.on('response', (res) => {
      res.resume();
      resolve(`HTTP_${res.statusCode}`);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve(`ERROR_${e.code ?? 'TLS'}`));
    req.end();
  });
}

const port = Number(env.STANDIN_PORT);
report.paid.noClientCert = await httpsGet({
  host: '127.0.0.1',
  port,
  rejectUnauthorized: false,
  headers: { authorization: 'Bearer guessed-capability-value-000000000000' },
});
const attacker = makeLocalPki('m09-attacker', 'kite-broker');
report.paid.attackerCert = await httpsGet({
  host: '127.0.0.1',
  port,
  rejectUnauthorized: false,
  cert: attacker.client.cert,
  key: attacker.client.key,
  headers: { authorization: 'Bearer guessed-capability-value-000000000000' },
});
report.paid.plainHttp = await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/v1/payments', method: 'POST', timeout: 3000 }, (res) => {
    res.resume();
    resolve(`HTTP_${res.statusCode}`);
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (e) => resolve(`ERROR_${e.code ?? 'X'}`));
  req.end('{}');
});
report.paid.rawTcp = await new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.end('POST /v1/payments HTTP/1.1\r\nHost: x\r\n\r\n'));
  let got = '';
  s.on('data', (d) => (got += d.toString('latin1')));
  s.on('close', () => resolve(got.startsWith('HTTP/1.1 2') ? 'ACCEPTED' : 'REFUSED'));
  s.on('error', () => resolve('REFUSED'));
});

// The broker's environment and argv as another same-user process can see them.
try {
  report.env = execFileSync('ps', ['eww', '-o', 'command=', '-p', env.BROKER_PID], { encoding: 'utf8' });
} catch {
  report.env = '';
}

function post(path, body) {
  return new Promise((resolve) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { socketPath: env.BROKER_SOCKET, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', (e) => resolve({ status: 0, body: String(e.code) }));
    req.end(text);
  });
}
const forged = {
  referenceVersion: 1,
  tenantId: env.TENANT_ID,
  target: { kind: 'COMMERCIAL_INTENT', commercialIntentId: env.INTENT_ID },
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  nonce: 'probe-nonce-000000000001',
  signature: { algorithm: 'HMAC-SHA256', keyId: 'reference-k1', value: 'A'.repeat(43) },
};
report.broker.forged = await post('/v1/execution-references/execute', forged);
report.broker.embedded = await post('/v1/execution-references/execute', {
  ...forged,
  amountMinor: '99999999',
  merchantId: 'mer_attacker-0001',
  endpoint: 'https://attacker.example/pay',
});
report.broker.wrongRoute = await post('/v1/pay', forged);
report.broker.notJson = await post('/v1/execution-references/execute', 'not json');

if (env.DATABASE_URL) {
  const c = new pg.Client({ connectionString: env.DATABASE_URL });
  await c.connect();
  const tables = await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  let dump = '';
  for (const t of tables.rows) {
    const r = await c.query(`SELECT t::text AS row FROM "${t.tablename}" t`);
    for (const x of r.rows) dump += `${x.row}\n`;
  }
  await c.end();
  report.db = dump;
}
process.stdout.write(JSON.stringify(report));
