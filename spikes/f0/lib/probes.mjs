// Bypass battery run inside f0-general-worker, f0-serv and f0-client. Each probe reports whether the attempt was
// denied plus a short observation. Anything the probe could read is returned as `harvest` so the launcher can
// search it for the broker secret; harvest is never written to disk or the repository.
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { signEnvelope } from './envelope.mjs';
import { makeLocalPki } from './pki.mjs';

const E = process.env;
const PORT = Number(E.F0_STANDIN_PORT);
const TARGET = `https://127.0.0.1:${PORT}/v1/execute`;
const ok2xx = (s) => typeof s === 'number' && s >= 200 && s < 300;

const sh = (cmd, args, env) =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 6000, env: env ?? E, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
        resolve({ code: err ? (err.code ?? 'ERR') : 0, stdout: String(stdout), stderr: String(stderr) }),
      );
    } catch (e) {
      // The sandbox layer can refuse the exec itself (e.g. setuid ps): that is a denial, not a probe crash.
      resolve({ code: e.code ?? 'ERR', stdout: '', stderr: `spawn refused: ${e.code ?? e.message}` });
    }
  });

function request(mod, opts, body) {
  return new Promise((resolve) => {
    const req = mod.request({ timeout: 3000, agent: false, ...opts }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', (e) => resolve({ error: e.code ?? e.message }));
    req.end(body);
  });
}

function rawExchange(connectOpts, payload) {
  return new Promise((resolve) => {
    const s = net.connect(connectOpts);
    let out = '';
    const done = (r) => {
      s.destroy();
      resolve(r);
    };
    s.setTimeout(2000, () => done({ reply: out || null, error: out ? undefined : 'TIMEOUT' }));
    s.on('connect', () => s.write(payload));
    s.on('data', (d) => {
      out += d.toString('utf8');
    });
    s.on('end', () => done({ reply: out }));
    s.on('error', (e) => done({ error: e.code ?? e.message }));
  });
}

// Fetch from a child Node with client-side certificate checks disabled, so a denial is the stand-in's decision.
const nodeFetch = (url, extraEnv = {}) =>
  sh(
    process.execPath,
    [
      '--no-warnings',
      '-e',
      `fetch(${JSON.stringify(url)},{method:'POST',body:'{}',redirect:'follow',signal:AbortSignal.timeout(3000)}).then(r=>console.log('HTTP',r.status),e=>console.log('ERR',e.cause?.code??e.name))`,
    ],
    { ...E, NODE_TLS_REJECT_UNAUTHORIZED: '0', ...extraEnv },
  ).then((r) => r.stdout.trim() || `child ${r.code} ${r.stderr.trim().slice(0, 60)}`);
const fetchDenied = (obs) => !/^HTTP 2\d\d/.test(obs);

const execBody = JSON.stringify({ idempotencyKey: 'attacker-key', amountMinor: '100', currency: 'XTS' });
const execHeaders = {
  'content-type': 'application/json',
  'idempotency-key': 'attacker-key',
  authorization: 'Bearer guessed-capability',
};
const brokerPost = (pathName, message) =>
  request(
    http,
    { socketPath: E.F0_BROKER_SOCK, path: pathName, method: 'POST', headers: { 'content-type': 'application/json' } },
    JSON.stringify(message),
  );

function readTree(root, budget = { files: 400 }) {
  let text = '';
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || budget.files <= 0) continue;
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && st.size < 2 * 1024 * 1024) {
        budget.files -= 1;
        try {
          text += readFileSync(full, 'utf8');
        } catch {
          /* unreadable sockets and denied files */
        }
      }
    }
  };
  walk(root);
  return text;
}

export async function runProbes({ capturedMessage }) {
  const probes = [];
  let harvest = '';
  // Each probe carries what it managed to read; the launcher scans and strips it before anything is persisted.
  const record = (id, layer, denied, observed) => {
    probes.push({ id, layer, denied, observed: String(observed).slice(0, 160), harvest });
    harvest = '';
  };

  // --- secret reads ---------------------------------------------------------------------------------------------
  harvest += JSON.stringify(process.env);
  record('secret-own-env', 'secret', true, `${Object.keys(process.env).length} vars harvested for launcher scan`);
  for (const [id, pid] of [
    ['secret-ps-env-broker', E.F0_BROKER_PID],
    ['control-ps-env-decoy', E.F0_DECOY_PID],
  ]) {
    const r = await sh('ps', ['-E', '-ww', '-o', 'command=', '-p', pid]);
    harvest += r.stdout;
    record(
      id,
      'secret',
      r.code !== 0,
      r.code === 0 ? `read ${r.stdout.length} bytes (launcher scans)` : `ps failed: ${r.code} ${r.stderr.trim()}`,
    );
  }
  const lsof = await sh('lsof', ['-nP', '-p', E.F0_BROKER_PID]);
  harvest += lsof.stdout;
  record(
    'secret-lsof-broker',
    'secret',
    lsof.code !== 0,
    lsof.code === 0 ? `read ${lsof.stdout.split('\n').length} lines` : `lsof failed: ${lsof.code}`,
  );
  for (const [id, dir] of [
    ['secret-fs-broker-state-dir', E.F0_BROKER_STATE_DIR],
    ['secret-fs-launcher-keygen-dir', E.F0_KEYGEN_DIR],
    ['secret-fs-spike-tree', E.F0_SPIKE_DIR],
  ]) {
    try {
      const t = readTree(dir);
      harvest += t;
      record(id, 'secret', false, `read ${t.length} bytes (launcher scans)`);
    } catch (e) {
      record(id, 'secret', true, e.code ?? e.message);
    }
  }
  try {
    const f0dirs = readdirSync(tmpdir()).filter((n) => n.startsWith('f0-'));
    let t = '';
    for (const d of f0dirs) {
      try {
        t += readTree(path.join(tmpdir(), d));
      } catch {
        /* denied subtree */
      }
    }
    harvest += t;
    record(
      'secret-fs-tmp-scan',
      'secret',
      false,
      `${f0dirs.length} f0-* dirs, ${t.length} bytes readable (launcher scans)`,
    );
  } catch (e) {
    record('secret-fs-tmp-scan', 'secret', true, e.code ?? e.message);
  }
  try {
    process.kill(Number(E.F0_BROKER_PID), 'SIGUSR1');
  } catch (e) {
    record('inspector-sigusr1-signal', 'debugger', true, e.code);
  }
  await new Promise((r) => setTimeout(r, 700));
  const insp = await request(http, { host: '127.0.0.1', port: 9229, path: '/json' });
  record(
    'inspector-sigusr1-attach',
    'debugger',
    !(insp.body ?? '').includes('f0-kite-broker'),
    insp.error ?? `9229 answered ${insp.status} without broker target`,
  );

  // --- paid-destination reachability ----------------------------------------------------------------------------
  const noCert = await request(
    https,
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/v1/execute',
      method: 'POST',
      rejectUnauthorized: false,
      headers: execHeaders,
    },
    execBody,
  );
  record('direct-tls-no-client-cert', 'network', !ok2xx(noCert.status), noCert.error ?? `HTTP ${noCert.status}`);
  try {
    const atk = makeLocalPki('f0-attacker', 'f0-attacker-client');
    const own = await request(
      https,
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/v1/execute',
        method: 'POST',
        rejectUnauthorized: false,
        key: atk.client.key,
        cert: atk.client.cert,
        headers: execHeaders,
      },
      execBody,
    );
    record('direct-tls-attacker-minted-cert', 'network', !ok2xx(own.status), own.error ?? `HTTP ${own.status}`);
  } catch (e) {
    record('direct-tls-attacker-minted-cert', 'network', true, `cert mint failed: ${e.message}`);
  }
  const plain = await request(
    http,
    { host: '127.0.0.1', port: PORT, path: '/v1/execute', method: 'POST', headers: execHeaders },
    execBody,
  );
  record('direct-plain-http', 'network', !ok2xx(plain.status), plain.error ?? `HTTP ${plain.status}`);
  const raw = await rawExchange(
    { host: '127.0.0.1', port: PORT },
    `POST /v1/execute HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: ${execBody.length}\r\n\r\n${execBody}`,
  );
  record(
    'direct-raw-tcp',
    'network',
    !/^HTTP\/1\.[01] 2/.test(raw.reply ?? ''),
    raw.error ?? `reply ${JSON.stringify((raw.reply ?? '').slice(0, 40))}`,
  );
  const curl = await sh('curl', [
    '-sk',
    '-m',
    '3',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '-X',
    'POST',
    '-H',
    'authorization: Bearer guessed-capability',
    '-d',
    execBody,
    TARGET,
  ]);
  record('alt-client-curl', 'network', !/^2/.test(curl.stdout), `curl exit ${curl.code} http ${curl.stdout || '000'}`);
  const fo = await nodeFetch(TARGET);
  record('alt-client-fetch-undici', 'network', fetchDenied(fo), fo);

  const redirector = http.createServer((_q, s) => {
    s.writeHead(307, { location: TARGET });
    s.end();
  });
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  const rurl = `http://127.0.0.1:${redirector.address().port}/go`;
  const rc = await sh('curl', [
    '-skL',
    '-m',
    '4',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '-X',
    'POST',
    '-d',
    execBody,
    rurl,
  ]);
  record(
    'redirect-curl-follow',
    'network',
    !/^2/.test(rc.stdout),
    `curl exit ${rc.code} final http ${rc.stdout || '000'}`,
  );
  const rf = await nodeFetch(rurl);
  record('redirect-fetch-follow', 'network', fetchDenied(rf), rf);
  redirector.close();

  // Attacker-run CONNECT proxy: it can open TCP to the stand-in (outside the sandbox) but holds no credential.
  const proxy = http.createServer((_q, s) => {
    s.writeHead(502);
    s.end();
  });
  proxy.on('connect', (req, client, head) => {
    const [host, port] = req.url.split(':');
    const up = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    client.on('error', () => up.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const purl = `http://127.0.0.1:${proxy.address().port}`;
  const proxyEnv = { ...E, HTTPS_PROXY: purl, HTTP_PROXY: purl, ALL_PROXY: purl };
  const pc = await sh(
    'curl',
    ['-sk', '-m', '3', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', '-d', execBody, TARGET],
    proxyEnv,
  );
  record('proxy-env-curl', 'network', !/^2/.test(pc.stdout), `curl exit ${pc.code} http ${pc.stdout || '000'}`);
  const pn = await nodeFetch(TARGET, { HTTPS_PROXY: purl, HTTP_PROXY: purl, NODE_USE_ENV_PROXY: '1' });
  record('proxy-env-node-fetch', 'network', fetchDenied(pn), pn);
  proxy.close();

  // --- broker misuse --------------------------------------------------------------------------------------------
  const connect = await rawExchange(
    { path: E.F0_BROKER_SOCK },
    `CONNECT 127.0.0.1:${PORT} HTTP/1.1\r\nhost: 127.0.0.1:${PORT}\r\n\r\n`,
  );
  record(
    'broker-as-connect-proxy',
    'broker',
    !/^HTTP\/1\.[01] 200/.test(connect.reply ?? ''),
    connect.error ?? (connect.reply ?? '').split('\r\n')[0],
  );
  const fwd = await rawExchange(
    { path: E.F0_BROKER_SOCK },
    `POST ${TARGET} HTTP/1.1\r\nhost: 127.0.0.1:${PORT}\r\ncontent-length: ${execBody.length}\r\n\r\n${execBody}`,
  );
  record(
    'broker-as-forward-proxy',
    'broker',
    !/^HTTP\/1\.[01] 2/.test(fwd.reply ?? ''),
    fwd.error ?? (fwd.reply ?? '').split('\r\n')[0],
  );
  const base = capturedMessage?.envelope ?? {
    v: 1,
    intentId: 'intent-unknown',
    incidentId: 'inc-x',
    purpose: 'p',
    providerId: 'local-standin-paid',
    amountMinor: '100',
    currency: 'XTS',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    idempotencyKey: 'k',
    nonce: 'n',
  };
  const forged = { ...base, nonce: randomBytes(8).toString('hex') };
  const { privateKey: atkKey } = generateKeyPairSync('ed25519');
  const fr = await brokerPost('/v1/intents', { envelope: forged, sig: signEnvelope(forged, atkKey) });
  record('broker-forged-signature', 'broker', fr.status === 403, fr.error ?? `${fr.status} ${fr.body}`);
  const ur = await brokerPost('/v1/intents', { envelope: forged, sig: '' });
  record('broker-unsigned', 'broker', ur.status === 403, ur.error ?? `${ur.status} ${ur.body}`);
  const er = await brokerPost('/v1/intents', {
    envelope: { ...forged, endpoint: TARGET, credential: 'x' },
    sig: 'AA==',
  });
  record('broker-embedded-endpoint-or-credential', 'broker', er.status === 403, er.error ?? `${er.status} ${er.body}`);
  if (capturedMessage) {
    const rr = await brokerPost('/v1/intents', capturedMessage);
    let parsed;
    try {
      parsed = JSON.parse(rr.body ?? '{}');
    } catch {
      parsed = {};
    }
    record(
      'broker-replay-captured-envelope',
      'broker',
      parsed.egress === false,
      rr.error ?? `${rr.status} state=${parsed.state} egress=${parsed.egress} effect=${parsed.effectId}`,
    );
  }
  return { probes };
}
