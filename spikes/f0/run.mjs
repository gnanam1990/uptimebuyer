#!/usr/bin/env node
// F0 feasibility spike runner. Starts the spike processes, exercises the local checks and writes a redacted
// machine-readable result to spikes/f0/evidence/F0-RESULT.json.
//
// This launcher plays the trusted deployment role (secret manager + approval store): it mints a SYNTHETIC
// credential at runtime, hands it only to f0-kite-broker over a pipe, and never writes it anywhere.
// Everything paid is a LOCAL_STAND_IN. No Kite, OpenServ, provider, person or money is contacted.
//
// F0 is feasibility evidence, not canonical module or product implementation evidence.
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestOf, fingerprint, sha256 } from './lib/canonical.mjs';
import { TAMPER_FIELDS } from './lib/envelope.mjs';
import { deriveRecoveryResult, makeRecord } from './lib/evidence.mjs';
import { decidePart, responseDeadline } from './lib/parts.mjs';
import { makeLocalPki } from './lib/pki.mjs';
import { SOURCES, assess } from './lib/sensor.mjs';

const SPIKE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SPIKE, '../..');
const OUT = path.join(SPIKE, 'evidence', 'F0-RESULT.json');
const STATEMENT = 'F0 is feasibility evidence, not canonical module or product implementation evidence.';
const startedAt = new Date();
const checks = [];
const check = (id, gate, pass, evidence) => {
  checks.push({ id, gate, pass: Boolean(pass), evidence });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${gate} ${id} — ${evidence}`);
};
const tryText = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

// --- run directory and synthetic secrets (memory only) ---------------------------------------------------------
const runDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'f0-run-')));
chmodSync(runDir, 0o700);
const privateDir = path.join(runDir, 'broker-private');
const ingressDir = path.join(runDir, 'broker-ingress');
for (const d of [privateDir, ingressDir]) mkdirSync(d, { mode: 0o700 });
const stateDirs = [path.join(privateDir, 'state-1'), path.join(privateDir, 'state-2')];
for (const d of stateDirs) mkdirSync(d, { mode: 0o700 });

const pki = makeLocalPki('f0-local', 'f0-kite-broker');
const capability = randomBytes(32).toString('base64url');
const client = generateKeyPairSync('ed25519');
const keyBody = (pem) =>
  pem
    .split('\n')
    .filter((l) => l && !l.startsWith('-----'))
    .join('');
const markers = {
  capability,
  brokerClientKeyBody: keyBody(pki.client.key),
  brokerClientKeyFirstLine: pki.client.key.split('\n')[1],
};
const findSecret = (text) => Object.keys(markers).filter((k) => text.includes(markers[k]));
const decoyCanary = `canary-${randomBytes(6).toString('hex')}`;

const baseEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME ?? '',
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  LANG: 'C',
};

// --- process helpers -------------------------------------------------------------------------------------------
const children = new Set();
function launch(file, { fd3, env = {}, nodeArgs = [], sandboxProfile } = {}) {
  const script = path.join(SPIKE, 'proc', file);
  const argv = [...nodeArgs, script];
  const [cmd, args] = sandboxProfile
    ? ['sandbox-exec', ['-p', sandboxProfile, process.execPath, ...argv]]
    : [process.execPath, argv];
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ipc'], env: { ...baseEnv, ...env } });
  child.stdout.on('data', (d) => process.stdout.write(`  [${file}] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`  [${file}] ${d}`));
  child.stdio[3].end(fd3 ? JSON.stringify(fd3) : '');
  children.add(child);
  child.on('exit', () => children.delete(child));
  let seq = 0;
  const pending = new Map();
  child.on('message', (m) => {
    if (m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  child.rpc = (op, a) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (m) => (m.ok ? resolve(m.result) : reject(new Error(m.error))));
      child.send({ id, op, args: a });
    });
  child.ready = new Promise((resolve, reject) => {
    child.on('message', (m) => m.type === 'ready' && resolve(m));
    child.on('exit', (code) => reject(new Error(`${file} exited ${code} before ready`)));
  });
  child.exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return child;
}
const stop = async (child) => {
  if (child.exitCode !== null) return;
  child.send({ type: 'stop' });
  await Promise.race([child.exited, new Promise((r) => setTimeout(r, 2000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
};
const snapshot = (standin) =>
  new Promise((resolve) => {
    const on = (m) => {
      if (m.type === 'snapshot') {
        standin.off('message', on);
        resolve(m);
      }
    };
    standin.on('message', on);
    standin.send({ type: 'snapshot' });
  });
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const getJson = (port, p) =>
  new Promise((resolve) => {
    http
      .get({ host: '127.0.0.1', port, path: p, timeout: 1500 }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      })
      .on('error', (e) => resolve({ error: e.code }));
  });

const results = { probes: [], reconciliation: {}, processes: {} };
let exitCode = 1;
try {
  // --- approvals (the broker's own authority source; stands in for the PostgreSQL reload) ----------------------
  const future = new Date(Date.now() + 10 * 60_000).toISOString();
  const mk = (name, over = {}) => ({
    intentId: `f0-intent-${name}`,
    incidentId: 'f0-inc-0001',
    purpose: 'f0-local-standin-paid-call',
    providerId: 'local-standin-paid',
    amountMinor: '100',
    currency: 'XTS',
    expiresAt: future,
    idempotencyKey: `f0-key-${name}`,
    ...over,
  });
  const I = {
    ok: mk('ok'),
    tamper: mk('tamper'),
    expired: mk('expired', { expiresAt: new Date(Date.now() - 1000).toISOString() }),
    notAllowlisted: mk('not-allowlisted', { providerId: 'other-paid-endpoint' }),
    drop: mk('drop'),
    lookupDown: mk('lookup-down'),
    crash: mk('crash'),
    journalLoss: mk('journal-loss'),
  };
  const approvals = Object.fromEntries(
    Object.values(I).map(({ amountMinor, ...a }) => [a.intentId, { ...a, maxAmountMinor: amountMinor }]),
  );

  // --- LOCAL_STAND_IN paid endpoint ----------------------------------------------------------------------------
  const standin = launch('f0-standin.mjs', {
    env: { F0_ROLE: 'LOCAL_STAND_IN' },
    fd3: {
      serverKey: pki.server.key,
      serverCert: pki.server.cert,
      caCert: pki.caCert,
      brokerClientFingerprint256: pki.client.fingerprint256,
      capabilitySha256: sha256(capability),
      faults: {
        dropResponseKeys: [I.drop.idempotencyKey, I.lookupDown.idempotencyKey],
        holdResponseKeys: [I.crash.idempotencyKey],
        lookupUnavailableKeys: [I.lookupDown.idempotencyKey],
      },
    },
  });
  const { port: standinPort } = await standin.ready;
  const allowlist = {
    'local-standin-paid': {
      origin: `https://127.0.0.1:${standinPort}`,
      serverFingerprint256: pki.server.fingerprint256,
      label: 'LOCAL_STAND_IN',
    },
  };

  // --- broker ---------------------------------------------------------------------------------------------------
  const startBroker = async (stateDir, crashAfterSendKeys) => {
    const b = launch('f0-kite-broker.mjs', {
      nodeArgs: ['--disable-sigusr1'],
      env: { F0_ROLE: 'f0-kite-broker' },
      fd3: {
        clientKey: pki.client.key,
        clientCert: pki.client.cert,
        capability,
        caCert: pki.caCert,
        clientPublicKey: client.publicKey.export({ type: 'spki', format: 'pem' }),
        approvals,
        allowlist,
        stateDir,
        ingressDir,
        faults: { crashAfterSendKeys },
      },
    });
    b.info = await b.ready;
    (results.processes.brokerLaunches ??= []).push({
      pid: b.pid,
      stateDir: path.basename(stateDir),
      crashFaultArmed: crashAfterSendKeys.length > 0,
    });
    return b;
  };
  let broker = await startBroker(stateDirs[0], [I.crash.idempotencyKey]);
  const brokerSock = broker.info.socket;
  check(
    'adapter-preflight',
    'F0-A(local analogue)',
    broker.info.adapter === 'ELIGIBLE',
    `stand-in capabilities ${JSON.stringify(broker.info.capability)}`,
  );

  // --- decoy control process --------------------------------------------------------------------------------------
  const decoyInspectPort = await freePort();
  const decoy = launch('f0-decoy.mjs', {
    env: { F0_DECOY_CANARY: decoyCanary },
    nodeArgs: [`--inspect-port=127.0.0.1:${decoyInspectPort}`],
  });
  await decoy.ready;

  const sandboxProfile = [
    '(version 1)',
    '(allow default)',
    `(deny network-outbound (remote ip "localhost:${standinPort}"))`,
    `(deny file-read* file-write* (subpath ${JSON.stringify(privateDir)}))`,
    '(deny process-info* (target others))',
    '(deny process-info-listpids)',
  ].join('');
  const roleEnv = (role, sandboxed) => ({
    F0_ROLE: role,
    F0_SANDBOXED: sandboxed ? '1' : '0',
    F0_STANDIN_PORT: String(standinPort),
    F0_BROKER_SOCK: brokerSock,
    F0_BROKER_PID: String(broker.pid),
    F0_BROKER_STATE_DIR: stateDirs[0],
    F0_KEYGEN_DIR: pki.keygenDir,
    F0_SPIKE_DIR: SPIKE,
    F0_DECOY_PID: String(decoy.pid),
  });
  const clientFd3 = { signingKey: client.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const clientProc = launch('f0-client.mjs', { env: roleEnv('f0-client', true), fd3: clientFd3, sandboxProfile });
  await clientProc.ready;
  const submit = (fields, extra = {}) => clientProc.rpc('submit', { fields, ...extra });
  const reconcile = (fields) => clientProc.rpc('reconcile', { fields });
  const ledgerOf = async (key) => (await snapshot(standin)).ledger[key] ?? null;

  // --- F0-C local: happy path and duplicate submission -----------------------------------------------------------
  const ok1 = await submit(I.ok);
  const ok2 = await submit(I.ok);
  const okLedger = await ledgerOf(I.ok.idempotencyKey);
  check(
    'execute-confirmed',
    'F0-C(local)',
    ok1.body.state === 'CONFIRMED' && ok1.body.egress === true,
    `state=${ok1.body.state} effect=${ok1.body.effectId}`,
  );
  check(
    'duplicate-submission-same-effect',
    'F0-C(local)',
    ok2.body.effectId === ok1.body.effectId && ok2.body.egress === false && okLedger.executeCalls === 1,
    `second submit decision=${ok2.body.decision} egress=${ok2.body.egress}; provider executeCalls=${okLedger.executeCalls}`,
  );
  results.reconciliation.happyPath = { first: ok1.body, duplicate: ok2.body, provider: okLedger };

  // --- F0-B: tampered envelopes -----------------------------------------------------------------------------------
  const tamperValues = {
    incidentId: 'f0-inc-9999',
    purpose: 'f0-other-purpose',
    providerId: 'other-paid-endpoint',
    amountMinor: '100000',
    currency: 'USD',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    idempotencyKey: 'f0-key-attacker-chosen',
  };
  const tamper = [];
  for (const field of TAMPER_FIELDS) {
    for (const resign of [false, true]) {
      const r = await submit(I.tamper, { mutate: { field, value: tamperValues[field] }, resign });
      tamper.push({
        field,
        mode: resign ? 'resigned-by-client-key' : 'mutated-after-signature',
        status: r.status,
        code: r.body.code,
      });
    }
  }
  const tamperLedger = (await snapshot(standin)).ledger;
  check(
    'tamper-post-signature-rejected',
    'F0-B',
    tamper
      .filter((t) => t.mode === 'mutated-after-signature')
      .every((t) => t.status === 403 && t.code === 'SIGNATURE_INVALID'),
    tamper
      .filter((t) => t.mode === 'mutated-after-signature')
      .map((t) => `${t.field}:${t.code}`)
      .join(' '),
  );
  check(
    'tamper-resigned-out-of-authority-rejected',
    'F0-B',
    tamper
      .filter((t) => t.mode === 'resigned-by-client-key')
      .every((t) => t.status === 403 && /^(AUTHORITY_MISMATCH_|AMOUNT_EXCEEDS)/.test(t.code)),
    tamper
      .filter((t) => t.mode === 'resigned-by-client-key')
      .map((t) => `${t.field}:${t.code}`)
      .join(' '),
  );
  check(
    'tamper-no-egress',
    'F0-B',
    !tamperLedger[I.tamper.idempotencyKey] && !tamperLedger[tamperValues.idempotencyKey],
    'provider ledger has no entry for the tampered intent or the attacker-chosen key',
  );
  const tamperControl = await submit(I.tamper);
  check(
    'tamper-control-untampered-accepted',
    'F0-B',
    tamperControl.body.state === 'CONFIRMED',
    `untampered envelope state=${tamperControl.body.state}`,
  );
  const expired = await submit(I.expired);
  check(
    'expired-authority-rejected',
    'F0-B',
    expired.status === 403 && expired.body.code === 'EXPIRED',
    `code=${expired.body.code}`,
  );
  const notAllowed = await submit(I.notAllowlisted);
  check(
    'non-allowlisted-provider-rejected',
    'F0-B',
    notAllowed.status === 403 && notAllowed.body.code === 'PROVIDER_NOT_ALLOWLISTED',
    `code=${notAllowed.body.code}`,
  );
  results.tamper = tamper;

  // --- F0-C local: dropped response becomes UNKNOWN until lookup ---------------------------------------------------
  const d1 = await submit(I.drop);
  const d2 = await submit(I.drop);
  const dRec = await reconcile(I.drop);
  const dLedger = await ledgerOf(I.drop.idempotencyKey);
  check(
    'dropped-response-unknown',
    'F0-C(local)',
    d1.body.state === 'UNKNOWN',
    `first outcome state=${d1.body.state} reason=${d1.body.reason}`,
  );
  check(
    'unknown-not-retried',
    'F0-C(local)',
    d2.body.state === 'UNKNOWN' && d2.body.egress === false,
    `resubmit decision=${d2.body.decision}`,
  );
  check(
    'lookup-reconciles-unknown',
    'F0-C(local)',
    dRec.body.state === 'CONFIRMED' && dRec.body.effectId === dLedger.effectId && dLedger.executeCalls === 1,
    `reconcile state=${dRec.body.state}; provider executeCalls=${dLedger.executeCalls}`,
  );
  const l1 = await submit(I.lookupDown);
  const lRec = await reconcile(I.lookupDown);
  const l2 = await submit(I.lookupDown);
  const lLedger = await ledgerOf(I.lookupDown.idempotencyKey);
  check(
    'inconclusive-lookup-stays-unknown',
    'F0-C(local)',
    l1.body.state === 'UNKNOWN' &&
      lRec.body.state === 'UNKNOWN' &&
      lRec.body.reason === 'LOOKUP_INCONCLUSIVE' &&
      l2.body.egress === false &&
      lLedger.executeCalls === 1,
    `reconcile state=${lRec.body.state} reason=${lRec.body.reason}; provider executeCalls=${lLedger.executeCalls}`,
  );
  results.reconciliation.dropped = { first: d1.body, resubmit: d2.body, reconcile: dRec.body, provider: dLedger };
  results.reconciliation.lookupUnavailable = {
    first: l1.body,
    reconcile: lRec.body,
    resubmit: l2.body,
    provider: lLedger,
  };

  // --- F0-C local: broker killed after durable SEND_STARTED ---------------------------------------------------------
  const crashSubmit = submit(I.crash);
  const crashExit = await broker.exited;
  const crashReply = await crashSubmit;
  const journalAfterCrash = readFileSync(path.join(stateDirs[0], 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.idempotencyKey === I.crash.idempotencyKey);
  broker = await startBroker(stateDirs[0], []);
  const cRec = await reconcile(I.crash);
  const cLedger = await ledgerOf(I.crash.idempotencyKey);
  check(
    'crash-after-send-started-converges',
    'F0-C(local)',
    crashExit.code === 137 &&
      journalAfterCrash.map((e) => e.event).join(',') === 'SEND_STARTED' &&
      cRec.body.state === 'CONFIRMED' &&
      cRec.body.effectId === cLedger.effectId &&
      cLedger.executeCalls === 1,
    `broker exit=${crashExit.code}; journal before restart=${journalAfterCrash.map((e) => e.event)}; after restart+lookup state=${cRec.body.state}; provider executeCalls=${cLedger.executeCalls}`,
  );
  results.reconciliation.crashAfterSendStarted = {
    clientReply: crashReply.error ?? crashReply.status,
    brokerExit: crashExit,
    reconcile: cRec.body,
    provider: cLedger,
  };

  // --- controls: the probe techniques work against an ordinary process ----------------------------------------------
  const decoyEnv = tryText('ps', ['-E', '-ww', '-o', 'command=', '-p', String(decoy.pid)]) ?? '';
  process.kill(decoy.pid, 'SIGUSR1');
  await new Promise((r) => setTimeout(r, 700));
  const decoyInspector = await getJson(decoyInspectPort, '/json');
  check(
    'control-ps-env-reads-other-process-env',
    'F0-B(control)',
    decoyEnv.includes(decoyCanary),
    'same-UID ps -E exposes a canary placed in an ordinary process env',
  );
  check(
    'control-sigusr1-opens-inspector',
    'F0-B(control)',
    (decoyInspector.body ?? '').includes('f0-decoy'),
    'SIGUSR1 opens the inspector of an ordinary Node process (why the broker runs with --disable-sigusr1)',
  );

  // --- F0-B: bypass battery from every non-broker role, with and without the sandbox layer --------------------------
  const general = http.createServer((_q, s) => s.end('general non-payment endpoint')).listen(0, '127.0.0.1');
  await new Promise((r) => general.once('listening', r));
  const before = await snapshot(standin);
  const captured = ok1.message;
  for (const sandboxed of [true, false]) {
    for (const [file, role] of [
      ['f0-general-worker.mjs', 'f0-general-worker'],
      ['f0-serv.mjs', 'f0-serv'],
      ['f0-client.mjs', 'f0-client'],
    ]) {
      const env = { ...roleEnv(role, sandboxed), F0_BROKER_PID: String(broker.pid) };
      const p = launch(file, {
        env,
        fd3: role === 'f0-client' ? clientFd3 : undefined,
        sandboxProfile: sandboxed ? sandboxProfile : undefined,
      });
      await p.ready;
      results.processes[`${role}${sandboxed ? '+sandbox' : ''}`] = { pid: p.pid, uid: process.getuid(), sandboxed };
      if (role === 'f0-general-worker') {
        const w = await p.rpc('ordinaryWork', { url: `http://127.0.0.1:${general.address().port}/` });
        check(
          `ordinary-work-runs${sandboxed ? '-sandboxed' : ''}`,
          'F0-B',
          w.generalEndpointStatus === 200,
          `general endpoint HTTP ${w.generalEndpointStatus}`,
        );
      }
      if (role === 'f0-serv') {
        const k = await p.rpc('openServKeyPresent');
        results.processes[`${role}${sandboxed ? '+sandbox' : ''}`].openServKey = k;
      }
      const { probes } = await p.rpc('probes', { capturedMessage: captured });
      for (const pr of probes) {
        const leaked = findSecret(pr.harvest);
        const canary = pr.harvest.includes(decoyCanary);
        delete pr.harvest;
        results.probes.push({ role, sandboxed, ...pr, secretMarkersFound: leaked, controlCanaryFound: canary });
      }
      await p.rpc('exit').catch(() => {});
      await p.exited;
    }
  }
  general.close();
  await stop(decoy);
  const after = await snapshot(standin);
  const attackProbes = results.probes.filter((p) => !p.id.startsWith('control-'));
  check(
    'no-secret-read-outside-broker',
    'F0-B',
    results.probes.every((p) => p.secretMarkersFound.length === 0),
    `${results.probes.length} probe results scanned for capability and key material: none found`,
  );
  check(
    'every-bypass-attempt-denied',
    'F0-B',
    attackProbes.every((p) => p.denied || p.layer === 'secret'),
    `${attackProbes.filter((p) => p.layer !== 'secret').length} network/broker/debugger attempts denied across 3 roles x 2 layers`,
  );
  check(
    'credential-layer-alone-holds',
    'F0-B',
    attackProbes.filter((p) => !p.sandboxed && p.layer !== 'secret').every((p) => p.denied),
    'without the sandbox profile every direct, alternate-client, redirect and proxy attempt still fails (mTLS + capability)',
  );
  check(
    'probe-sensitivity-unsandboxed',
    'F0-B(control)',
    results.probes.filter((p) => p.id === 'control-ps-env-decoy' && !p.sandboxed).every((p) => p.controlCanaryFound),
    'unsandboxed roles CAN read another process env (decoy canary), so a clean broker env is load-bearing',
  );
  check(
    'sandbox-layer-denies-network-and-state',
    'F0-B',
    attackProbes
      .filter(
        (p) =>
          p.sandboxed &&
          [
            'direct-tls-no-client-cert',
            'direct-raw-tcp',
            'secret-fs-broker-state-dir',
            'secret-ps-env-broker',
          ].includes(p.id),
      )
      .every((p) => p.denied && /EPERM|Operation not permitted|failed/.test(p.observed)),
    'sandbox-exec profile denies TCP to the stand-in port, reads of the broker state dir and process-info of other processes',
  );
  const sum = (s) => Object.values(s.ledger).reduce((n, e) => n + e.executeCalls, 0);
  check(
    'no-provider-effect-from-attackers',
    'F0-B',
    sum(before) === sum(after) && before.counters.authorizedRequests === after.counters.authorizedRequests,
    `provider executeCalls ${sum(before)}->${sum(after)}; authorized requests ${before.counters.authorizedRequests}->${after.counters.authorizedRequests}; TLS handshake rejections ${before.counters.tlsClientErrors}->${after.counters.tlsClientErrors}; unauthorized HTTP ${before.counters.wrongClientCert + before.counters.badCapability}->${after.counters.wrongClientCert + after.counters.badCapability}`,
  );
  results.standinCounters = after.counters;

  // --- F0-C local: provider-enforced same-key idempotency after local journal loss ----------------------------------
  const j1 = await submit(I.journalLoss);
  await stop(broker);
  broker = await startBroker(stateDirs[1], []);
  const j2 = await submit(I.journalLoss);
  const jLedger = await ledgerOf(I.journalLoss.idempotencyKey);
  check(
    'provider-duplicate-key-same-effect',
    'F0-C(local)',
    j1.body.state === 'CONFIRMED' &&
      j2.body.replayed === true &&
      j2.body.effectId === j1.body.effectId &&
      jLedger.executeCalls === 2 &&
      jLedger.effectsCreated === 1,
    `journal lost, same key re-sent: replayed=${j2.body.replayed} same effect=${j2.body.effectId === j1.body.effectId}; provider executeCalls=${jLedger.executeCalls} effectsCreated=${jLedger.effectsCreated}`,
  );
  results.reconciliation.journalLoss = { first: j1.body, afterLoss: j2.body, provider: jLedger };

  // --- F0-D: SIMULATED_INPUT sensor fixture ----------------------------------------------------------------------
  const now = Date.now();
  const sensorRun = execFileSync(process.execPath, [path.join(SPIKE, 'proc', 'f0-sensor-sim.mjs'), String(now)], {
    encoding: 'utf8',
    env: baseEnv,
  });
  const obs = sensorRun
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const policy = { maxAgeMs: 5 * 60_000, maxClockSkewMs: 30_000, minMilliC: 0, maxMilliC: 5_000 };
  const full = assess(obs, now, policy);
  const byScenario = Object.fromEntries(obs.map((o, i) => [o.scenario, full.rows[i].status]));
  const staleOnly = assess(
    obs.filter((o) => o.scenario === 'stale_in_range'),
    now,
    policy,
  );
  const staleAsIfLive = assess(
    obs.filter((o) => o.scenario === 'stale_in_range').map((o) => ({ ...o, source: SOURCES.LIVE_AUTHENTICATED })),
    now,
    policy,
  );
  check(
    'sensor-sim-classification',
    'F0-D(local)',
    byScenario.normal === 'FRESH_IN_RANGE' &&
      byScenario.controlled_breach_simulated === 'BREACH' &&
      byScenario.stale_in_range === 'STALE' &&
      byScenario.replayed_sequence === 'OUT_OF_ORDER_OR_REPLAY' &&
      byScenario.restored === 'FRESH_IN_RANGE',
    JSON.stringify(byScenario),
  );
  check(
    'stale-never-healthy',
    'F0-D(local)',
    staleOnly.conditionStatus === 'STALE' &&
      !staleOnly.healthyClaimAllowed &&
      staleAsIfLive.conditionStatus === 'STALE' &&
      !staleAsIfLive.healthyClaimAllowed,
    'stale in-range reading is STALE and not healthy, even when relabelled LIVE_AUTHENTICATED in a logic-only check',
  );
  check(
    'simulated-never-healthy',
    'F0-D(local)',
    full.conditionStatus === 'FRESH_IN_RANGE' && !full.healthyClaimAllowed,
    'restored SIMULATED_INPUT reading is in range but healthyClaimAllowed=false',
  );
  const cited = {
    manufacturer: 'FixtureCo',
    mpn: 'FX-EVAP-FAN-120-A',
    citation: { docDigest: sha256('FIXTURE_NOT_A_REAL_MANUAL rev F1 page 14'), page: 14 },
    isFixture: true,
  };
  const candidates = {
    exact: { manufacturer: 'FixtureCo', mpn: 'FX-EVAP-FAN-120-A', similarity: 1 },
    similarSuffix: {
      manufacturer: 'FixtureCo',
      mpn: 'FX-EVAP-FAN-120-B',
      similarity: 0.97,
      description: 'same description, different suffix',
    },
    otherManufacturer: { manufacturer: 'OtherFixtureCo', mpn: 'FX-EVAP-FAN-120-A', similarity: 0.95 },
    missingMpn: { manufacturer: 'FixtureCo', mpn: '', similarity: 0.9 },
  };
  const partDecisions = Object.fromEntries(Object.entries(candidates).map(([k, c]) => [k, decidePart(cited, c)]));
  check(
    'ambiguous-part-held',
    'F0-D(local)',
    partDecisions.exact.decision === 'EXACT_MATCH_FIXTURE_ONLY' &&
      ['similarSuffix', 'otherManufacturer', 'missingMpn'].every((k) => partDecisions[k].decision === 'HELD'),
    Object.entries(partDecisions)
      .map(([k, d]) => `${k}:${d.decision}/${d.reason}`)
      .join(' '),
  );
  const sop = { sopId: 'demo-sop-cold-holding', version: 'v1-fixture', containmentDeadlineMinutes: 120 };
  const spoilage = { label: 'NON_AUTHORITATIVE_ESTIMATE', minutes: 600 };
  const dl = responseDeadline(sop, spoilage);
  const dlNoSop = responseDeadline(null, spoilage);
  check(
    'deadline-from-sop-only',
    'F0-D(local)',
    dl.minutes === 120 && dlNoSop.decision === 'HELD',
    `with SOP: ${dl.sopRef} ${dl.minutes}min; without SOP: ${dlNoSop.decision} (estimate ignored)`,
  );
  results.sensor = {
    label: 'SIMULATED_INPUT',
    policy,
    classification: byScenario,
    finalAssessment: { conditionStatus: full.conditionStatus, healthyClaimAllowed: full.healthyClaimAllowed },
  };
  results.parts = {
    label: 'FIXTURE_NOT_A_REAL_MANUAL',
    cited: { ...cited, citation: { ...cited.citation } },
    decisions: partDecisions,
  };
  results.sop = { sop, spoilage, withSop: dl, withoutSop: dlNoSop };

  // --- F0-E: recovery-authority separation -------------------------------------------------------------------------
  const restored = obs.find((o) => o.scenario === 'restored');
  const recs = {
    payment: makeRecord('PAYMENT_OBSERVATION', {
      source: 'LOCAL_STAND_IN',
      effectId: ok1.body.effectId,
      amountMinor: '100',
      currency: 'XTS',
    }),
    acceptance: makeRecord('PROVIDER_ACCEPTANCE', { source: 'LOCAL_STAND_IN', effectId: ok1.body.effectId }),
    work: makeRecord('WORK_REPORT', {
      source: 'FIXTURE',
      status: 'PROVIDER_REPORTED_COMPLETED',
      reportedAtMs: restored.sourceTimeMs - 2_000,
    }),
    signoff: makeRecord('SIGNOFF', { source: 'FIXTURE', role: 'maintenance_approver' }),
    simWindow: makeRecord('SENSOR_WINDOW', {
      source: SOURCES.SIMULATED_INPUT,
      startMs: restored.sourceTimeMs,
      samples: 1,
      allFreshInRange: true,
    }),
  };
  const rp = { minSamples: 1 };
  const e1 = deriveRecoveryResult([recs.payment, recs.acceptance, recs.work], rp);
  const e2 = deriveRecoveryResult([recs.payment, recs.acceptance, recs.work, recs.signoff], rp);
  const e3 = deriveRecoveryResult([recs.payment, recs.acceptance, recs.work, recs.signoff, recs.simWindow], rp);
  const e4 = deriveRecoveryResult(
    [recs.payment, recs.acceptance, recs.work, { kind: 'COMPLETED', status: 'ALL_DONE' }],
    rp,
  );
  check(
    'provider-completed-plus-receipt-insufficient',
    'F0-E',
    e1.result === 'INSUFFICIENT_FOR_RECOVERY',
    `${e1.result} ${e1.reasons.join(',')}`,
  );
  check(
    'plus-signoff-still-insufficient',
    'F0-E',
    e2.result === 'INSUFFICIENT_FOR_RECOVERY',
    `${e2.result} ${e2.reasons.join(',')}`,
  );
  check(
    'simulated-window-not-recovery',
    'F0-E',
    e3.result === 'CONDITION_IN_RANGE_SIMULATED_NOT_RECOVERY',
    `${e3.result} ${e3.reasons.join(',')}`,
  );
  check(
    'collapsed-completed-badge-ignored',
    'F0-E',
    e4.result === 'INSUFFICIENT_FOR_RECOVERY',
    `${e4.result} ${e4.reasons.join(',')}`,
  );
  check(
    'records-stay-separate',
    'F0-E',
    new Set(Object.values(recs).map((r) => r.digest)).size === Object.keys(recs).length,
    'five evidence kinds, five distinct records and digests',
  );
  results.evidenceRecords = recs;
  results.recovery = { paymentAcceptanceWork: e1, plusSignoff: e2, plusSimulatedWindow: e3, collapsedBadge: e4 };

  results.processes.broker = {
    pid: broker.pid,
    uid: process.getuid(),
    nodeArgs: ['--disable-sigusr1'],
    credentialChannel: 'fd 3 pipe (not env, argv or file)',
    ingress: 'unix socket 0600 in 0700 dir',
  };
  results.processes.standin = {
    pid: standin.pid,
    uid: process.getuid(),
    label: 'LOCAL_STAND_IN',
    holds: 'server key + SHA-256 of capability (not the capability)',
  };
  await stop(broker);
  await stop(clientProc);
  await stop(standin);
  exitCode = checks.every((c) => c.pass) ? 0 : 1;
} catch (e) {
  check('runner-completed', 'runner', false, e.stack ?? e.message);
} finally {
  for (const c of children) c.kill('SIGKILL');
  rmSync(runDir, { recursive: true, force: true });
}

// --- redacted result -----------------------------------------------------------------------------------------------
const runnerOk = checks.every((c) => c.gate !== 'runner');
const localPass = (gate) =>
  runnerOk &&
  checks.some((c) => c.gate.startsWith(gate)) &&
  checks.filter((c) => c.gate.startsWith(gate)).every((c) => c.pass);
const subGates = {
  'F0-A': 'BLOCKED',
  'F0-B': localPass('F0-B') ? 'PASS' : 'FAIL',
  'F0-C': 'BLOCKED',
  'F0-D': 'UNKNOWN',
  'F0-E': localPass('F0-E') ? 'PASS' : 'FAIL',
  'F0-F': 'BLOCKED',
  'F0-G': 'BLOCKED',
};
const git = (args) => tryText('git', ['-C', REPO, ...args]);
const result = {
  schemaVersion: 1,
  recordKind: 'F0_FEASIBILITY_RESULT',
  statement: STATEMENT,
  run: {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    command: 'node spikes/f0/run.mjs',
    exitCode,
    environment: { platform: process.platform, osRelease: release(), arch: process.arch, uid: process.getuid() },
    tools: {
      node: process.version,
      openssl: tryText('openssl', ['version']),
      curl: tryText('curl', ['--version'])?.split('\n')[0] ?? null,
      sandboxExec: tryText('which', ['sandbox-exec']) ? 'present (deprecated macOS API)' : 'absent',
    },
    repository: {
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      head: git(['rev-parse', 'HEAD']),
      dirtyPaths: (git(['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length,
    },
  },
  secretMetadata: {
    kind: 'SYNTHETIC_RUNTIME_ONLY (not a Kite credential)',
    components: ['mTLS client key+certificate for CN=f0-kite-broker', '32-byte bearer capability'],
    capabilityFingerprint: fingerprint(capability),
    brokerClientCertFingerprint256: pki.client.fingerprint256,
    holder: 'f0-kite-broker only',
    delivery: 'launcher -> broker fd 3 pipe; never env, argv, file, log or repository',
  },
  externalEffects: {
    realCall: false,
    realEmail: false,
    realPayment: false,
    purchase: false,
    physicalAction: false,
    networkBeyondLoopback: false,
  },
  amounts: {
    approvedMaximum: '100 XTS minor units per intent (XTS = ISO 4217 testing code)',
    actual: 'LOCAL_STAND_IN only; no real value moved',
  },
  checks,
  probes: results.probes,
  tamper: results.tamper,
  reconciliation: results.reconciliation,
  standinCounters: results.standinCounters,
  sensor: results.sensor,
  parts: results.parts,
  sop: results.sop,
  evidenceRecords: results.evidenceRecords,
  recovery: results.recovery,
  processes: results.processes,
  feasibility: {
    reportPath: 'spikes/f0/F0-REPORT.md',
    status: 'RUN_LOCAL_ONLY',
    subGates,
    scope: {
      'F0-A':
        'no Kite credential or authorization; live catalog not re-queried; only a LOCAL_STAND_IN capability preflight ran',
      'F0-B':
        'PASS for the local process-level spike boundary only (same UID, loopback, synthetic credential); production isolation NOT_RUN',
      'F0-C':
        'real low-value paid action not authorized; reconciliation STATE logic passed against LOCAL_STAND_IN only',
      'F0-D':
        'SIMULATED_INPUT only (cannot pass); no physical sensor or real manual; stale/ambiguous/SOP logic passed locally',
      'F0-E': 'separation logic passed with stand-in and fixture records; final recovery policy NOT_RUN (M11)',
      'F0-F': 'no interview records and no authorization to contact operators',
      'F0-G': 'no OpenServ account or API key; event submission blocked until a real SERV run is recorded',
    },
    recommendation: 'NARROW',
    userDecisionReference: null,
  },
};
const text = `${JSON.stringify(result, null, 2)}\n`;
const leaks = findSecret(text);
if (leaks.length) {
  console.error(`refusing to write result: secret markers present (${leaks.join(',')})`);
  process.exit(2);
}
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, text);
console.log(
  `\n${checks.filter((c) => c.pass).length}/${checks.length} local checks passed; sub-gates ${JSON.stringify(subGates)}`,
);
console.log(`result: ${path.relative(REPO, OUT)} (digest ${digestOf(result).slice(0, 16)})`);
process.exit(exitCode);
